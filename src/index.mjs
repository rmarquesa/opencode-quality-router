import { tool } from "@opencode-ai/plugin";
import { randomUUID } from "node:crypto";
import { loadConfig } from "./config.mjs";
import { StateStore } from "./store.mjs";
import { QuotaService } from "./quotas.mjs";
import {
  candidatesFor,
  selectCandidate,
  modelOf,
  keyOf,
  classifyError,
} from "./routing.mjs";
import { createRecovery } from "./recovery.mjs";

const POLICY = `Quality Router: maximize task-specific quality, not speed or cost. Before delegating managed agents, call quota_candidates, inspect capability notes, evidence and availability, then use the native task tool with model (provider/model), model_reason and model_order (alternatives ordered by quality for this concrete task). Candidate order is an operator preference, not a proven benchmark ranking. Prefer the most capable eligible model for the concrete task. Never infer quota from catalog membership. Unknown quota is not confirmed capacity. Include scope, relevant context/files, constraints and acceptance checks in task.prompt. Do not repeat completed work after provider recovery. Report unresolved verification. The router preserves native task permissions and may change the selected model if its availability changes.`;

// Only this module is loaded as an OpenCode plugin; helpers are ordinary modules.
export default async function QualityRouter(
  { client, directory },
  options = {},
) {
  const config = await loadConfig({ ...options, directory });
  const store = new StateStore(config.statePath);
  const quota = new QuotaService(config, store);
  const routes = Object.fromEntries(
    Object.entries(config.agents).map(([a, p]) => [
      a,
      p.candidates.map((c) => c.model),
    ]),
  );
  const tickets = new Map(),
    calls = new Map(),
    selections = new Map();
  let catalogue,
    catalogAt = 0;
  async function catalog() {
    if (catalogue && Date.now() - catalogAt < 60000) return catalogue;
    const result = await client.config.providers();
    if (result.error || !Array.isArray(result.data?.providers))
      throw new Error("Cannot verify model catalog");
    catalogue = new Set(
      result.data.providers.flatMap((p) =>
        Object.keys(p.models).map((m) => `${p.id}/${m}`),
      ),
    );
    catalogAt = Date.now();
    return catalogue;
  }
  async function list(agent, force = false) {
    const profile = config.agents[agent];
    if (!profile) throw new Error(`Unmanaged agent: ${agent}`);
    const providers = profile.candidates.map((c) => c.model.split("/")[0]);
    const [models, state] = await Promise.all([
      catalog(),
      quota.refreshAll(providers, force),
    ]);
    return candidatesFor(config, agent, models, state);
  }
  async function pick(agent, requested, attempted = new Set(), order) {
    const available = await list(agent);
    if (order)
      available.sort((a, b) => {
        const score = (c) =>
          order.includes(c.model)
            ? order.indexOf(c.model)
            : order.length + c.rank;
        return score(a) - score(b);
      });
    const candidate = selectCandidate(
      available,
      requested,
      attempted,
      config.allowUnknownQuota !== false,
    );
    return candidate;
  }
  async function report(message) {
    await client.app
      .log({ body: { service: "quality-router", level: "info", message } })
      .catch(() => {});
    await client.tui
      ?.showToast({
        body: {
          title: "Quality Router",
          message,
          variant: "info",
          duration: 5000,
        },
      })
      .catch(() => {});
  }
  async function markFailure(model, error) {
    const reason = classifyError(error);
    if (!reason) return;
    if (reason === "quota") await quota.refresh(model.split("/")[0], true);
    await store.update((s) => {
      s.blocks[model] = {
        reason,
        until: Date.now() + config.failureCooldownMs,
        observedAt: Date.now(),
      };
    });
  }
  const recovery = createRecovery({
    client,
    config: { ...config, routes, cooldownMs: config.failureCooldownMs },
    chooseModel: async (route, requested, attempted, sessionID) => {
      const agent = Object.keys(routes).find((a) => routes[a] === route);
      return (
        await pick(
          agent,
          requested,
          attempted,
          selections.get(sessionID)?.order,
        )
      )?.model;
    },
    selectionFor: async (agent, requested, sessionID, automatic) => {
      const preserve =
        !automatic &&
        (config.preserveManualSelection !== false || selections.has(sessionID));
      const candidate = await pick(
        agent,
        preserve ? requested : undefined,
        new Set(),
        selections.get(sessionID)?.order,
      );
      if (candidate) return candidate.model;
    },
    markFailure,
    modelFor: (agent, key) =>
      modelOf(
        key,
        config.agents[agent].candidates.find((c) => c.model === key)?.variant,
      ),
  });

  function expireTickets() {
    const now = Date.now();
    for (const [token, t] of tickets)
      if (t.expires < now) tickets.delete(token);
    for (const [key, token] of calls)
      if (!tickets.has(token)) calls.delete(key);
  }
  return {
    config: async (oc) => {
      await recovery.config(oc);
      for (const agent of Object.keys(config.agents)) {
        const a = oc.agent?.[agent];
        if (a && a.mode !== "subagent")
          a.prompt = (a.prompt ?? "") + "\n\n" + POLICY;
      }
    },
    tool: {
      quota_candidates: tool({
        description:
          "Get quality-oriented model candidates and live/cached quota status for a managed agent. Select the best model for the task, then call native task with model and model_reason. Does not generate model requests.",
        args: {
          agent: tool.schema.string(),
          refresh: tool.schema.boolean().optional(),
        },
        execute: async ({ agent, refresh }) =>
          JSON.stringify({
            agent,
            objective: "task-specific quality",
            candidates: await list(agent, refresh),
          }),
      }),
    },
    "tool.definition": async (input, output) => {
      if (input.toolID !== "task") return;
      const schema = output.jsonSchema;
      if (!schema?.properties)
        throw new Error(
          "Quality Router requires native task JSON schema support (tested on OpenCode 1.18.31)",
        );
      output.jsonSchema = {
        ...schema,
        properties: {
          ...schema.properties,
          model: {
            type: "string",
            description:
              "Optional explicit provider/model selected using quota_candidates for this task.",
          },
          model_reason: {
            type: "string",
            description:
              "Why this model offers the best quality for this concrete task.",
          },
          model_order: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional allowed alternatives ordered by quality for this specific task.",
          },
        },
      };
      output.description +=
        " For managed agents, consult quota_candidates and pass model and model_reason. Availability is rechecked before dispatch.";
    },
    "tool.execute.before": async (input, output) => {
      if (input.tool !== "task" || !config.agents[output.args.subagent_type])
        return;
      if (output.args.background)
        throw new Error("Quality Router supports foreground native tasks only");
      const agent = output.args.subagent_type;
      if (output.args.model && !routes[agent].includes(output.args.model))
        throw new Error(`Model is outside candidate allowlist for ${agent}`);
      const order = output.args.model_order;
      if (
        order &&
        (!Array.isArray(order) ||
          new Set(order).size !== order.length ||
          order.some((m) => !routes[agent].includes(m)))
      )
        throw new Error("Invalid task-specific model order");
      const selected = await pick(agent, output.args.model, new Set(), order);
      if (!selected)
        throw new Error(
          `No eligible model for ${agent}. Restore quota or configure another candidate.`,
        );
      expireTickets();
      const token = randomUUID();
      const ticket = {
        parent: input.sessionID,
        callID: input.callID,
        agent,
        model: selected.model,
        variant: selected.variant,
        order,
        reason: output.args.model_reason ?? "Configured quality preference",
        expires: Date.now() + 300000,
      };
      tickets.set(token, ticket);
      calls.set(`${input.sessionID}:${input.callID}`, token);
      output.args.prompt = `[quality-router-ticket:${token}]\n${output.args.prompt}`;
      await report(`${agent}: selected ${selected.model}`);
    },
    "chat.message": async (input, output) => {
      expireTickets();
      let ticket;
      for (const part of output.parts ?? []) {
        if (part.type !== "text") continue;
        const match = part.text.match(
          /^\[quality-router-ticket:([a-f0-9-]+)\]\n/,
        );
        if (!match) continue;
        ticket = tickets.get(match[1]);
        if (!ticket)
          throw new Error(
            "Routing ticket expired or invalid; task not dispatched",
          );
        const session = await client.session.get({
          path: { id: input.sessionID },
        });
        if (
          session.error ||
          session.data?.parentID !== ticket.parent ||
          output.message.agent !== ticket.agent
        )
          throw new Error("Routing ticket session/agent mismatch");
        tickets.delete(match[1]);
        part.text = part.text.slice(match[0].length);
        output.message.model = modelOf(ticket.model, ticket.variant);
        delete output.message.variant;
      }
      if (ticket)
        selections.set(input.sessionID, {
          agent: ticket.agent,
          model: ticket.model,
          order: ticket.order,
          reason: ticket.reason,
        });
      await recovery["chat.message"](input, output);
      if (ticket) {
        const actual = keyOf(output.message.model);
        selections.set(input.sessionID, {
          agent: ticket.agent,
          model: actual,
          order: ticket.order,
          reason: ticket.reason,
        });
      }
    },
    "tool.execute.after": async (input, output) => {
      if (input.tool !== "task") return;
      const token = calls.get(`${input.sessionID}:${input.callID}`);
      if (token) tickets.delete(token);
      calls.delete(`${input.sessionID}:${input.callID}`);
      const child = output?.metadata?.sessionId;
      if (!child) return;
      const selected = selections.get(child);
      if (!selected) return;
      const result = await client.session.messages({ path: { id: child } });
      const last = result.data?.findLast((m) => m.info.role === "assistant");
      const actual = last ? keyOf(last.info) : selected.model;
      output.metadata = {
        ...output.metadata,
        model: modelOf(actual),
        qualityRouter: {
          selectedModel: selected.model,
          actualModel: actual,
          reason: selected.reason,
        },
      };
    },
    "experimental.chat.messages.transform":
      recovery["experimental.chat.messages.transform"],
    event: async (input) => {
      await recovery.event(input);
      if (input.event.type === "session.deleted")
        selections.delete(input.event.properties?.info?.id);
    },
    dispose: async () => {
      tickets.clear();
      calls.clear();
      selections.clear();
      await recovery.dispose();
    },
  };
}
