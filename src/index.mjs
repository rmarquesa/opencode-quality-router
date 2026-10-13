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
import { failureBlock, syntheticQuotaError } from "./errors.mjs";
import {
  accessEvidence,
  requirementsFor,
  suitability,
  comparisonShortlist,
  validateComparison,
} from "./comparison.mjs";
import {
  selectionPolicy,
  candidateDetails,
  taskDecision,
  compactCandidate,
} from "./decision.mjs";
import {
  DOMAINS,
  COMPLEXITIES,
  validateAssessment,
  capabilityEvidence,
} from "./matrix.mjs";

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
    selections = new Map(),
    consultations = new Map();
  let catalogue,
    catalogAt = 0;
  async function catalog() {
    if (catalogue && Date.now() - catalogAt < 60000) return catalogue;
    const result = await client.config.providers();
    if (result.error || !Array.isArray(result.data?.providers))
      throw new Error("Cannot verify model catalog");
    catalogue = new Map(
      result.data.providers.flatMap((p) =>
        Object.entries(p.models).map(([id, model]) => [`${p.id}/${id}`, model]),
      ),
    );
    catalogAt = Date.now();
    return catalogue;
  }
  async function list(
    agent,
    force = false,
    domain,
    complexity,
    requirements = { toolCalling: true },
  ) {
    const profile = config.agents[agent];
    if (!profile) throw new Error(`Unmanaged agent: ${agent}`);
    const providers = profile.candidates.map((c) => c.model.split("/")[0]);
    const [models, state] = await Promise.all([
      catalog(),
      quota.refreshAll(providers, force),
    ]);
    return candidatesFor(config, agent, models, state).map((c) => {
      const details = candidateDetails(config, c, models.get(c.model));
      const expectedFree =
        (c.economics ?? config.providerEconomics?.[c.model.split("/")[0]])
          ?.billing === "free";
      return {
        ...c,
        ...details,
        access: accessEvidence(state, c.model, config.accessTtlMs),
        suitability: suitability(details, requirements),
        ...(domain && complexity
          ? {
              assessment: capabilityEvidence(
                state,
                c.model,
                domain,
                complexity,
              ),
            }
          : {}),
        ...(expectedFree && details.economics.billing !== "free"
          ? {
              availability: {
                status: "blocked",
                reason:
                  "Configured free offer no longer has confirmed zero catalog rates",
              },
            }
          : {}),
      };
    });
  }
  async function pick(
    agent,
    requested,
    attempted = new Set(),
    order,
    requirements,
  ) {
    let available = (
      await list(agent, false, undefined, undefined, requirements)
    ).filter((c) => c.suitability.status !== "incompatible");
    if (config.objective === "value" && order)
      available = available.filter((c) => order.includes(c.model));
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
      s.blocks[model] = failureBlock(config, error);
      s.access ??= {};
      s.access[model] = {
        ...s.access[model],
        lastFailureAt: Date.now(),
        failureReason: reason,
      };
    });
  }
  async function noteAccess(info, message) {
    const timestamp = info?.time?.completed;
    if (
      info?.role !== "assistant" ||
      info.error ||
      info.finish !== "stop" ||
      !Number.isFinite(timestamp)
    )
      return;
    const model = keyOf(info);
    if (!model || !config.agents[info.agent]) return;
    if (info.providerID === "google") {
      if (!message) {
        const result = await client.session.messages({
          path: { id: info.sessionID },
        });
        if (result.error) return;
        message = result.data?.find((m) => m.info.id === info.id);
      }
      if (!message || syntheticQuotaError(message)) return;
    }
    const state = await store.read();
    if ((state.access?.[model]?.lastSuccessAt ?? 0) >= timestamp) return;
    await store.update((s) => {
      s.access ??= {};
      const old = s.access[model] ?? {};
      if ((old.lastSuccessAt ?? 0) < timestamp)
        s.access[model] = { ...old, lastSuccessAt: timestamp };
    });
  }
  const recovery = createRecovery({
    client,
    config: { ...config, routes, cooldownMs: config.failureCooldownMs },
    chooseModel: async (route, requested, attempted, sessionID) => {
      const agent = Object.keys(routes).find((a) => routes[a] === route);
      if (config.objective === "value" && !selections.has(sessionID)) {
        const session = await client.session.get({ path: { id: sessionID } });
        if (session.error || !session.data)
          throw new Error("Cannot verify recovery session");
        // After restart an old child has no in-memory assessed alternatives.
        // Its parent must make a new decision, not inherit the entire catalog.
        if (session.data.parentID) return;
      }
      return (
        await pick(
          agent,
          requested,
          attempted,
          selections.get(sessionID)?.order,
          selections.get(sessionID)?.requirements,
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
        selections.get(sessionID)?.requirements,
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
    for (const [id, entry] of consultations)
      if (entry.expires < now) consultations.delete(id);
  }
  return {
    config: async (oc) => {
      await recovery.config(oc);
      for (const agent of Object.keys(config.agents)) {
        const a = oc.agent?.[agent];
        if (a && a.mode !== "subagent")
          a.prompt = (a.prompt ?? "") + "\n\n" + selectionPolicy(config);
      }
    },
    tool: {
      quota_candidates: tool({
        description:
          "Compare managed-agent model candidates: availability, evidence, capabilities, API reference prices and account billing/quota economics. Assess quality and cost for the concrete task, then choose a model and alternative order. Does not generate model requests.",
        args: {
          agent: tool.schema.string(),
          comparison_id: tool.schema
            .string()
            .optional()
            .describe(
              "Reuse this task's comparison ID to inspect additional candidates; not reusable after delegation.",
            ),
          requirements: tool.schema
            .object({
              toolCalling: tool.schema.boolean().optional(),
              reasoning: tool.schema.boolean().optional(),
              imageInput: tool.schema.boolean().optional(),
              contextTokens: tool.schema.number().int().min(1).optional(),
            })
            .optional()
            .describe(
              "Actual task requirements, not assumed model quality. Tools required by default.",
            ),
          refresh: tool.schema.boolean().optional(),
          task: tool.schema
            .string()
            .optional()
            .describe(
              "Task scope, complexity, risks and acceptance checks for your quality/cost comparison.",
            ),
          task_domain: tool.schema.enum(DOMAINS).optional(),
          task_complexity: tool.schema.enum(COMPLEXITIES).optional(),
          models: tool.schema
            .array(tool.schema.string())
            .min(1)
            .max(20)
            .optional()
            .describe(
              "Inspect up to 20 model IDs from candidate_index for this task.",
            ),
          offset: tool.schema.number().int().min(0).optional(),
          include_blocked: tool.schema.boolean().optional(),
          details: tool.schema
            .boolean()
            .optional()
            .describe(
              "Return full notes, prices and quota windows instead of compact comparison rows.",
            ),
        },
        execute: async (
          {
            agent,
            comparison_id,
            requirements: requestedRequirements,
            refresh,
            task,
            task_domain,
            task_complexity,
            details,
            models: requestedModels,
            offset,
            include_blocked,
          },
          context,
        ) => {
          if (
            config.objective === "value" &&
            (typeof task !== "string" || !task.trim())
          )
            throw new Error(
              "Value routing requires a concrete task summary in quota_candidates so the comparison is specific to this delegation.",
            );
          if (config.objective === "value")
            validateAssessment(task_domain, task_complexity);
          expireTickets();
          let consultation = comparison_id
            ? consultations.get(comparison_id)
            : undefined;
          if (
            comparison_id &&
            (!consultation ||
              consultation.parent !== context?.sessionID ||
              consultation.agent !== agent ||
              consultation.task !== task ||
              consultation.domain !== task_domain ||
              consultation.complexity !== task_complexity)
          )
            throw Error(
              "Comparison ID is expired or belongs to another task/session",
            );
          const requirements = requirementsFor(
            requestedRequirements ?? consultation?.requirements,
          );
          if (
            consultation &&
            JSON.stringify(requirements) !==
              JSON.stringify(consultation.requirements)
          )
            throw Error(
              "Keep task requirements unchanged while extending a comparison",
            );
          let candidates = await list(
            agent,
            refresh,
            task_domain,
            task_complexity,
            requirements,
          );
          if (config.objective === "value")
            candidates = candidates
              .map(({ rank, ...c }) => c)
              .sort((a, b) => a.model.localeCompare(b.model));
          const allCandidates = candidates;
          const eligible = allCandidates.filter(
            (c) => c.availability.status !== "blocked",
          );
          if (
            requestedModels?.some(
              (model) => !allCandidates.some((c) => c.model === model),
            )
          )
            throw new Error(
              "Requested inspection model is outside the current candidate catalog",
            );
          const shortlist =
            config.objective === "value" &&
            !requestedModels &&
            offset === undefined &&
            !include_blocked;
          const inspected = requestedModels
            ? allCandidates.filter((c) => requestedModels.includes(c.model))
            : shortlist
              ? comparisonShortlist(allCandidates)
              : include_blocked
                ? allCandidates
                : eligible;
          if (config.objective === "value")
            candidates = inspected.slice(
              offset ?? 0,
              (offset ?? 0) + (requestedModels ? 20 : 12),
            );
          if (context?.sessionID && config.objective === "value") {
            consultation ??= {
              id: randomUUID(),
              parent: context.sessionID,
              agent,
              task,
              domain: task_domain,
              complexity: task_complexity,
              requirements,
              expires: Date.now() + 300000,
              inspected: new Map(),
            };
            consultation.eligibleCount = eligible.filter(
              (c) => c.suitability.status !== "incompatible",
            ).length;
            consultations.set(consultation.id, consultation);
          }
          const result = {
            agent,
            comparison_id: consultation?.id,
            requirements,
            inspection_mode: shortlist
              ? "task_shortlist"
              : "requested_or_catalog_page",
            objective: config.objective,
            task,
            task_domain,
            task_complexity,
            ...(config.objective === "value"
              ? {
                  totalCandidates: allCandidates.length,
                  blockedCount: allCandidates.length - eligible.length,
                  candidate_index: eligible.map((c) => ({
                    model: c.model,
                    billing: c.economics.billing,
                  })),
                  next_offset: shortlist
                    ? 0
                    : (offset ?? 0) + candidates.length < inspected.length
                      ? (offset ?? 0) + candidates.length
                      : null,
                }
              : {}),
            guidance:
              "Judge task suitability and expected quality first, then compare costs. candidate_index lists every eligible model without a value rank; default details form an evidence/access/economics shortlist, not a recommendation rank; use offset: 0 to browse the alphabetical catalog. Recent access proves a response, not quota or quality. Unknown quota is not a failed request. Pass comparison_id and model_comparison; inspect additional models with the same comparison_id before dispatch. Use models to inspect indexed candidates appropriate to this task, or offset for the next page; include_blocked to inspect quota failures. Unmeasured is unknown; smoke trials are not domain-wide benchmarks. Different tasks on the same agent can use different models. API prices are USD per million tokens, not confirmed account charges; included quota consumption may be unknown. Pass this domain/complexity and a justified choice/alternative order to task.",
            candidates:
              config.objective === "value" && !details
                ? candidates.map(compactCandidate)
                : candidates,
          };
          // Keep responses below the native tool truncation boundary. Inspection credit
          // applies only to rows actually returned, never to the full name index.
          while (
            config.objective === "value" &&
            Buffer.byteLength(JSON.stringify(result)) > 15000 &&
            result.candidates.length > 2
          ) {
            result.candidates.pop();
            if (!shortlist)
              result.next_offset = (offset ?? 0) + result.candidates.length;
          }
          for (const row of result.candidates) {
            const full = allCandidates.find((c) => c.model === row.model);
            consultation?.inspected.set(row.model, full);
          }
          return JSON.stringify(result);
        },
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
          comparison_id: {
            type: "string",
            description:
              "Single-use ID returned by quota_candidates for this exact task.",
          },
          model_comparison: {
            type: "array",
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                model: { type: "string" },
                fit: { type: "string", enum: ["suitable", "unsuitable"] },
                reason: { type: "string" },
              },
              required: ["model", "fit", "reason"],
              additionalProperties: false,
            },
            description:
              "Compare inspected models with task-specific fit reasons. At least two when alternatives exist. Selected and fallback models must be suitable. Keeping the same winner is allowed.",
          },
          model: {
            type: "string",
            description:
              "Optional explicit provider/model selected using quota_candidates for this task.",
          },
          model_reason: {
            type: "string",
            description:
              "Task requirements, expected quality, cost/quota tradeoff and why this model is preferable to a relevant alternative.",
          },
          model_order: {
            type: "array",
            items: { type: "string" },
            description:
              "Allowed alternatives ordered for this concrete task under the routing objective. Required in value mode; [] excludes all alternatives.",
          },
          task_domain: {
            type: "string",
            enum: DOMAINS,
            description:
              "Domain of this concrete task, matching quota_candidates.",
          },
          task_complexity: {
            type: "string",
            enum: COMPLEXITIES,
            description:
              "Complexity of this task, independent of the specialist's name; match quota_candidates.",
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
      const order = taskDecision(config, agent, output.args);
      if (config.objective === "value")
        validateAssessment(
          output.args.task_domain,
          output.args.task_complexity,
        );
      expireTickets();
      const consultation = consultations.get(output.args.comparison_id);
      let comparison;
      if (config.objective === "value") {
        if (
          !consultation ||
          consultation.parent !== input.sessionID ||
          consultation.agent !== agent ||
          consultation.domain !== output.args.task_domain ||
          consultation.complexity !== output.args.task_complexity
        )
          throw Error(
            "Consult quota_candidates and pass its comparison_id for this task/session",
          );
        comparison = validateComparison(output.args, consultation);
      }
      const selected = await pick(
        agent,
        output.args.model,
        new Set(),
        order,
        consultation?.requirements,
      );
      if (!selected)
        throw new Error(
          `No eligible model for ${agent}. Restore quota or configure another candidate.`,
        );
      expireTickets();
      if (config.objective === "value" && !consultations.has(consultation.id))
        throw Error(
          "Comparison expired during availability refresh; consult again before dispatch",
        );
      const token = randomUUID();
      const ticket = {
        parent: input.sessionID,
        callID: input.callID,
        agent,
        model: selected.model,
        variant: selected.variant,
        order,
        reason: output.args.model_reason ?? "Configured quality preference",
        comparison,
        comparedTask: consultation?.task,
        requirements: consultation?.requirements,
        assessment: {
          domain: output.args.task_domain,
          complexity: output.args.task_complexity,
        },
        expires: Date.now() + 300000,
      };
      tickets.set(token, ticket);
      calls.set(`${input.sessionID}:${input.callID}`, token);
      if (config.objective === "value") consultations.delete(consultation.id);
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
          comparedTask: ticket.comparedTask,
          comparison: ticket.comparison,
          requirements: ticket.requirements,
          assessment: ticket.assessment,
        });
      await recovery["chat.message"](input, output);
      if (ticket) {
        const actual = keyOf(output.message.model);
        selections.set(input.sessionID, {
          agent: ticket.agent,
          model: actual,
          order: ticket.order,
          reason: ticket.reason,
          comparedTask: ticket.comparedTask,
          comparison: ticket.comparison,
          requirements: ticket.requirements,
          assessment: ticket.assessment,
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
          comparedTask: selected.comparedTask,
          comparison: selected.comparison,
          requirements: selected.requirements,
          objective: config.objective,
          assessment: selected.assessment,
        },
      };
      const synthetic = syntheticQuotaError(last);
      if (synthetic) {
        await markFailure(actual, synthetic);
        throw new Error(
          `Subagent failed (task_id: ${child}): provider quota exhausted; no specialist answer was produced.`,
        );
      }
      await noteAccess(last?.info, last);
    },
    "experimental.chat.messages.transform":
      recovery["experimental.chat.messages.transform"],
    event: async (input) => {
      await recovery.event(input);
      if (input.event.type === "message.updated")
        await noteAccess(input.event.properties?.info);
      if (input.event.type === "session.deleted") {
        const id = input.event.properties?.info?.id;
        selections.delete(id);
        for (const [key, entry] of consultations)
          if (entry.parent === id) consultations.delete(key);
      }
    },
    dispose: async () => {
      tickets.clear();
      calls.clear();
      selections.clear();
      consultations.clear();
      await recovery.dispose();
    },
  };
}
