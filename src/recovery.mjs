import { classifyError, quotaNotice, syntheticQuotaError } from "./errors.mjs";
const keyOf = (model) => (model ? `${model.providerID}/${model.modelID}` : "");
const modelOf = (key) => {
  const i = key.indexOf("/");
  return { providerID: key.slice(0, i), modelID: key.slice(i + 1) };
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CONTINUE =
  "[quality-router] Continue the existing task from the conversation above. The previous provider failed. Check completed actions and tool results first; do not repeat completed edits, commands, submissions or delegated tasks.";

function recoverable(error) {
  return !!classifyError(error);
}

// Only export the entry point: OpenCode loads every function export as a plugin.
export function createRecovery({
  client,
  config,
  chooseModel,
  markFailure,
  selectionFor,
  modelFor = (_agent, key) => modelOf(key),
}) {
  const sessions = new Map();
  const taskResults = new Map();
  const variants = new Map();
  let disposed = false;
  const stateFor = (id) => {
    if (!sessions.has(id))
      sessions.set(id, {
        revision: 0,
        anchors: new Map(),
        auto: new Map(),
        cancelled: false,
        abortIDs: new Set(),
      });
    return sessions.get(id);
  };
  async function report(message, error = false) {
    try {
      await client.app.log({
        body: {
          service: "quality-router",
          level: error ? "error" : "info",
          message,
        },
      });
    } catch {}
    try {
      await client.tui?.showToast({
        body: {
          title: "Quality Router",
          message,
          variant: error ? "error" : "info",
          duration: 6000,
        },
      });
    } catch {}
  }
  async function choose(route, start, attempted = new Set(), sessionID) {
    return chooseModel(
      route,
      attempted.size ? undefined : route[start],
      attempted,
      sessionID,
    );
  }
  async function messages(id) {
    const result = await client.session.messages({ path: { id } });
    if (result.error || !Array.isArray(result.data))
      throw new Error("Cannot read session history");
    return result.data;
  }
  async function sessionInfo(id) {
    const result = await client.session.get({ path: { id } });
    if (result.error || !result.data)
      throw new Error("Cannot read session metadata");
    return result.data;
  }
  async function waitIdle(id, alive) {
    const deadline = Date.now() + 10000;
    while (alive()) {
      const result = await client.session.status();
      if (result.error || !result.data)
        throw new Error("Cannot verify session status");
      if (!result.data[id] || result.data[id].type === "idle") return;
      if (Date.now() >= deadline)
        throw new Error(
          "Session is still busy; recovery stopped to avoid overlapping work.",
        );
      await sleep(50);
    }
  }
  async function stop(id, state) {
    state.internalAbort = true;
    try {
      const history = await messages(id);
      const assistant = history.findLast((m) => m.info.role === "assistant");
      if (assistant) state.abortIDs.add(assistant.info.id);
      const result = await client.session.abort({ path: { id } });
      if (result?.error) throw new Error("Cannot stop the failed request");
    } finally {
      state.internalAbort = false;
    }
  }

  // Keep callers attached to the recovered result; never launch detached child
  // work. Each model is attempted once, even if cooldown expires during a run.
  async function recover(id, cause, parentState) {
    const state = stateFor(id);
    if (state.recovery) return state.recovery;
    const revision = state.revision;
    const parentRevision = parentState?.revision;
    const alive = () =>
      !disposed &&
      !state.cancelled &&
      state.revision === revision &&
      (!parentState ||
        (!parentState.cancelled && parentState.revision === parentRevision));
    const job = async () => {
      let history = await messages(id);
      let user = history.findLast((m) => m.info.role === "user");
      if (!user || (cause?.parentID && cause.parentID !== user.info.id)) return;
      const agent = user.info.agent;
      const route = config.routes[agent];
      if (!route) return;
      let failed =
        cause?.model ??
        (keyOf(
          history.findLast(
            (m) =>
              m.info.role === "assistant" && m.info.parentID === user.info.id,
          )?.info,
        ) ||
          keyOf(user.info.model));
      if (!route.includes(failed)) return;
      if (!state.anchors.has(agent))
        state.anchors.set(
          agent,
          Math.max(0, route.indexOf(keyOf(user.info.model))),
        );
      const attempted = new Set();
      while (alive()) {
        attempted.add(failed);
        await markFailure(failed, cause?.error);
        const next = await choose(
          route,
          route.indexOf(failed) + 1,
          attempted,
          id,
        );
        if (!next) {
          await report(
            `${agent}: no remaining available provider; stopped. Retry after cooldown or restore provider access.`,
            true,
          );
          return;
        }
        await sleep(config.retryDelayMs);
        await waitIdle(id, alive);
        history = await messages(id);
        if (
          !alive() ||
          history.findLast((m) => m.info.role === "user")?.info.id !==
            user.info.id
        )
          return;
        await report(`${agent}: ${failed} -> ${next}`);
        state.expected = next;
        state.auto.set(agent, next);
        state.attemptError = undefined;
        const body = {
          agent,
          model: modelFor(agent, next),
          parts: [{ type: "text", synthetic: true, text: CONTINUE }],
          ...(user.info.system !== undefined
            ? { system: user.info.system }
            : {}),
          ...(user.info.format !== undefined
            ? { format: user.info.format }
            : {}),
          // Sending tools here would replace inherited session permissions.
          // The existing session already retains its permission rules.
        };
        let response;
        try {
          response = await client.session.prompt({ path: { id }, body });
        } finally {
          state.expected = undefined;
        }
        if (!alive()) return;
        const result = response.data;
        const error =
          state.attemptError ??
          response.error ??
          result?.info?.error ??
          syntheticQuotaError(result);
        if (!error && result?.info?.role === "assistant") {
          if (
            result.parts?.some(
              (p) => p.type === "tool" && p.state?.status === "error",
            )
          )
            return;
          state.cause = undefined;
          return result;
        }
        if (!recoverable(error)) {
          await report(
            `${agent}: recovery stopped on a non-provider error.`,
            true,
          );
          return;
        }
        failed = next;
        cause = { error };
        history = await messages(id);
        user = history.findLast((m) => m.info.role === "user");
        if (!user) return;
      }
    };
    state.recovery = Promise.resolve()
      .then(job)
      .catch(async (error) => {
        await report(`Quality Router stopped: ${error.message}`, true);
      });
    try {
      return await state.recovery;
    } finally {
      state.recovery = undefined;
    }
  }

  async function failure(id, error, info, retry = false) {
    if (!id || !recoverable(error)) return;
    const state = stateFor(id);
    if (state.cancelled) return;
    if (state.recovery) {
      if (retry && !state.internalAbort) {
        state.attemptError = error;
        await stop(id, state);
      }
      return;
    }
    if (state.handling) return;
    state.handling = true;
    try {
      const history = await messages(id);
      const user = history.findLast((m) => m.info.role === "user");
      if (!user || (info?.parentID && info.parentID !== user.info.id)) return;
      const assistant = history.findLast(
        (m) => m.info.role === "assistant" && m.info.parentID === user.info.id,
      );
      if (!info && !retry && assistant && !assistant.info.error) return;
      const model = info
        ? keyOf(info)
        : keyOf(assistant?.info) || keyOf(user.info.model);
      if (!config.routes[user.info.agent]?.includes(model)) return;
      const fingerprint = `${user.info.id}:${model}`;
      if (state.lastFailure === fingerprint) return;
      state.lastFailure = fingerprint;
      state.cause = { model, error, parentID: user.info.id };
      await markFailure(model, error);
      const session = await sessionInfo(id);
      state.parentID = session.parentID;
      if (retry) await stop(id, state);
      if (session.parentID) return; // The parent transform owns child recovery.
      await recover(id, state.cause);
    } finally {
      state.handling = false;
    }
  }

  return {
    config: async (oc) => {
      for (const [agent, value] of Object.entries(oc.agent ?? {}))
        variants.set(agent, value.variant);
    },
    "chat.message": async (input, output) => {
      const state = stateFor(input.sessionID);
      const agent = output.message.agent;
      const route = config.routes[agent];
      const requested = keyOf(output.message.model);
      const automatic =
        state.expected === requested &&
        output.parts?.some((p) => p.synthetic && p.text === CONTINUE);
      if (automatic) return;
      state.revision++;
      state.cancelled = false;
      state.cause = undefined;
      state.lastFailure = undefined;
      if (!route?.includes(requested)) return; // Respect manual non-routed models.
      if (
        !state.anchors.has(agent) ||
        (requested !== state.auto.get(agent) &&
          requested !== route[state.anchors.get(agent)])
      )
        state.anchors.set(agent, route.indexOf(requested));
      const selected = await selectionFor(
        agent,
        requested,
        input.sessionID,
        state.auto.get(agent) === requested,
      );
      if (!selected)
        throw new Error(
          `No available provider for ${agent}. Wait for cooldown or restore provider access.`,
        );
      if (selected !== requested) {
        // Clears the nested 1.18 variant along with legacy top-level variants.
        output.message.model = modelFor(agent, selected);
        if (selected === route[0] && variants.get(agent))
          output.message.model.variant = variants.get(agent);
        delete output.message.variant;
        state.auto.set(agent, selected);
        await report(`${agent}: using ${selected}`);
      }
    },
    "experimental.chat.messages.transform": async (_input, output) => {
      const parentID = output.messages.find((m) => m.info.sessionID)?.info
        .sessionID;
      if (!parentID) return;
      const parentState = stateFor(parentID);
      const lastUserIndex = output.messages.findLastIndex(
        (m) => m.info.role === "user",
      );
      for (const message of output.messages.slice(lastUserIndex + 1)) {
        for (const part of message.parts) {
          if (
            part.type !== "tool" ||
            part.tool !== "task" ||
            !(
              part.state?.status === "error" ||
              (part.state?.status === "completed" &&
                quotaNotice(
                  part.state.output?.match(
                    /<task_result>\s*([\s\S]*?)\s*<\/task_result>/,
                  )?.[1],
                ))
            )
          )
            continue;
          const childID =
            part.state.metadata?.sessionId ??
            part.state.error?.match(/task_id:\s*(ses_[\w-]+)/)?.[1];
          if (!childID) continue;
          const hadQuotaNotice = part.state.status === "completed";
          const token = `${parentID}:${part.id}`;
          if (!taskResults.has(token)) {
            const job = (async () => {
              const child = await sessionInfo(childID);
              if (child.parentID !== parentID) return;
              const childState = stateFor(childID);
              childState.parentID = parentID;
              const history = await messages(childID);
              const user = history.findLast((m) => m.info.role === "user");
              const assistant = history.findLast(
                (m) =>
                  m.info.role === "assistant" &&
                  m.info.parentID === user?.info.id,
              );
              const cause =
                childState.cause ??
                (recoverable(
                  assistant?.info.error ?? syntheticQuotaError(assistant),
                )
                  ? {
                      model: keyOf(assistant.info),
                      parentID: user.info.id,
                      error:
                        assistant.info.error ?? syntheticQuotaError(assistant),
                    }
                  : undefined);
              if (!cause || childState.cancelled || parentState.cancelled)
                return;
              return recover(childID, cause, parentState);
            })().catch(async (error) => {
              await report(`Subagent recovery stopped: ${error.message}`, true);
            });
            taskResults.set(token, job);
          }
          const recovered = await taskResults.get(token);
          if (!recovered || parentState.cancelled) {
            if (hadQuotaNotice)
              part.state = {
                status: "error",
                input: part.state.input,
                error: `Subagent failed (task_id: ${childID}): provider quota exhausted and recovery did not produce a valid answer. Reassess availability and task fit before a new delegation.`,
                metadata: {
                  ...part.state.metadata,
                  quotaFailure: true,
                  fallbackRecovered: false,
                },
                time: part.state.time,
              };
            continue;
          }
          const text = recovered.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n");
          // Change the model context only; retain the failed call for auditing.
          // The recovered response remains stored in the same child session.
          part.state = {
            status: "completed",
            input: part.state.input,
            title: `Recovered: ${part.state.input?.description ?? "subagent"}`,
            output: `<task id="${childID}" state="completed"><task_result>${text}</task_result></task>`,
            metadata: {
              ...part.state.metadata,
              fallbackRecovered: true,
              model: {
                providerID: recovered.info.providerID,
                modelID: recovered.info.modelID,
              },
            },
            time: {
              start: part.state.time?.start ?? Date.now(),
              end: Date.now(),
            },
          };
        }
      }
    },
    event: async ({ event }) => {
      const p = event.properties ?? {};
      const id = p.sessionID ?? p.info?.sessionID;
      if (event.type === "session.deleted") {
        const deleted = p.info?.id ?? id;
        const state = sessions.get(deleted);
        if (state) state.cancelled = true;
        sessions.delete(deleted);
        for (const key of taskResults.keys())
          if (key.startsWith(`${deleted}:`)) taskResults.delete(key);
        return;
      }
      const info = event.type === "message.updated" ? p.info : undefined;
      const error =
        info?.role === "assistant"
          ? info.error
          : event.type === "session.error"
            ? p.error
            : undefined;
      if (/Aborted|AbortError/.test(error?.name ?? "")) {
        const state = sessions.get(id);
        if (state && !state.internalAbort && !state.abortIDs.has(info?.id)) {
          state.cancelled = true;
          for (const [childID, child] of sessions) {
            if (child.parentID === id && child.recovery) {
              child.cancelled = true;
              void stop(childID, child).catch(() => {});
            }
          }
        }
        return;
      }
      const retry =
        event.type === "session.status" && p.status?.type === "retry";
      if (
        id &&
        (event.type === "session.idle" ||
          (event.type === "session.status" && p.status?.type === "idle"))
      ) {
        // Antigravity wraps quota failures in HTTP 200 text streams, so the host
        // emits idle rather than session.error. Read the persisted final result.
        void (async () => {
          const history = await messages(id);
          const user = history.findLast((m) => m.info.role === "user");
          const assistant = history.findLast(
            (m) =>
              m.info.role === "assistant" && m.info.parentID === user?.info.id,
          );
          const synthetic = syntheticQuotaError(assistant);
          if (synthetic) await failure(id, synthetic, assistant.info);
        })().catch((e) => report(`Quality Router stopped: ${e.message}`, true));
      }
      if (
        recoverable(error) ||
        (retry && recoverable({ message: p.status.message }))
      ) {
        // Do not hold the event bus while making HTTP calls back into it.
        void failure(
          id,
          retry ? { message: p.status.message } : error,
          info,
          retry,
        ).catch((e) => report(`Quality Router stopped: ${e.message}`, true));
      }
    },
    dispose: async () => {
      disposed = true;
      for (const state of sessions.values()) state.cancelled = true;
      sessions.clear();
      taskResults.clear();
    },
  };
}
