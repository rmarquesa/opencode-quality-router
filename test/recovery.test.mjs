import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(
  await readFile(new URL("./fixtures/routes.json", import.meta.url)),
);
const source = await readFile(new URL("../src/recovery.mjs", import.meta.url));
const model = (key) => {
  const [providerID, modelID] = key.split("/");
  return { providerID, modelID };
};
const key = (m) => `${m.providerID}/${m.modelID}`;
const apiError = (statusCode, message = "Provider unavailable") => ({
  name: "APIError",
  data: { statusCode, message },
});
const aborted = { name: "MessageAbortedError", data: { message: "Aborted" } };
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));
async function until(fn) {
  for (let i = 0; i < 200; i++) {
    if (fn()) return;
    await tick();
  }
  assert.fail("Timed out");
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "opencode-routing-test-"));
  await writeFile(join(dir, "ordered-fallback.mjs"), source);
  await writeFile(
    join(dir, "errors.mjs"),
    await readFile(new URL("../src/errors.mjs", import.meta.url)),
  );
  await writeFile(
    join(dir, "fallback-routes.json"),
    JSON.stringify({
      ...config,
      retryDelayMs: options.delay ?? 0,
      cooldownMs: options.cooldown ?? 900000,
    }),
  );
  const { createRecovery } = await import(
    pathToFileURL(join(dir, "ordered-fallback.mjs"))
  );
  const histories = new Map(),
    sessions = new Map(),
    prompts = [],
    logs = [],
    aborts = [];
  let seq = 0,
    h;
  const available = options.available ?? [
    ...new Set(Object.values(config.routes).flat()),
  ];
  const providers = Object.entries(
    Object.groupBy(available, (k) => k.split("/")[0]),
  ).map(([id, ids]) => ({
    id,
    models: Object.fromEntries(ids.map((x) => [x.split("/")[1], {}])),
  }));
  const client = {
    app: { log: async ({ body }) => logs.push(body.message) },
    config: {
      providers: async () =>
        options.catalogueError
          ? { error: { message: "offline" } }
          : { data: { providers } },
    },
    session: {
      get: async ({ path }) => ({ data: sessions.get(path.id) }),
      messages: async ({ path }) => ({
        data: structuredClone(histories.get(path.id) ?? []),
      }),
      status: async () => ({ data: {} }),
      abort: async ({ path }) => {
        aborts.push(path.id);
        const a = histories
          .get(path.id)
          ?.findLast((m) => m.info.role === "assistant");
        if (a) {
          a.info.error = aborted;
          await h.event({
            event: { type: "message.updated", properties: { info: a.info } },
          });
        }
        options.onAbort?.(path.id);
        return {};
      },
      prompt: async ({ path, body }) => {
        prompts.push({ id: path.id, body: structuredClone(body) });
        const user = await send(
          path.id,
          body.agent,
          key(body.model),
          body.parts,
        );
        const error = options.errors?.[key(body.model)];
        const result = {
          info: {
            id: `a${++seq}`,
            sessionID: path.id,
            parentID: user.id,
            role: "assistant",
            agent: body.agent,
            ...body.model,
            ...(error ? { error } : {}),
          },
          parts: [
            {
              type: "text",
              text:
                options.texts?.[key(body.model)] ?? "DONE: recovered result",
            },
          ],
        };
        histories.get(path.id).push(result);
        if (options.onPrompt) await options.onPrompt({ h, result, path, body });
        // Simulate the host publishing terminal events before the HTTP result.
        if (error)
          await h.event({
            event: {
              type: "message.updated",
              properties: { info: result.info },
            },
          });
        return { data: result };
      },
    },
  };
  const blocked = new Map();
  const select = (route, requested, attempted = new Set()) => {
    if (options.catalogueError) throw new Error("Cannot verify catalog");
    const eligible = route.filter(
      (k) =>
        available.includes(k) &&
        !attempted.has(k) &&
        (blocked.get(k) ?? 0) <= Date.now(),
    );
    return eligible.find((k) => k === requested) ?? eligible[0];
  };
  h = createRecovery({
    client,
    config: { ...config, retryDelayMs: options.delay ?? 0 },
    chooseModel: select,
    selectionFor: async (agent, requested, id, automatic) =>
      select(config.routes[agent], automatic ? undefined : requested),
    markFailure: async (k) => {
      blocked.set(k, Date.now() + (options.cooldown ?? 900000));
    },
  });
  await h.config({ agent: { build: { variant: "high" } } });
  t.after(async () => {
    await h.dispose();
    await rm(dir, { recursive: true, force: true });
  });
  async function send(
    id,
    agent,
    requested = config.routes[agent][0],
    parts = [{ type: "text", text: "Do the task" }],
  ) {
    if (!sessions.has(id)) sessions.set(id, { id });
    if (!histories.has(id)) histories.set(id, []);
    const info = {
      id: `u${++seq}`,
      role: "user",
      sessionID: id,
      agent,
      model: { ...model(requested), variant: "high" },
      system: "preserve system",
      format: { type: "text" },
    };
    await h["chat.message"](
      { sessionID: id, model: model(requested) },
      { message: info, parts },
    );
    histories.get(id).push({ info, parts });
    return info;
  }
  async function fail(id, error = apiError(429), event = true) {
    const user = histories.get(id).findLast((m) => m.info.role === "user").info;
    const info = {
      id: `a${++seq}`,
      role: "assistant",
      sessionID: id,
      parentID: user.id,
      agent: user.agent,
      ...user.model,
      error,
    };
    histories.get(id).push({ info, parts: [] });
    if (event)
      await h.event({
        event: { type: "message.updated", properties: { info } },
      });
    return info;
  }
  function parentContext(child = "child") {
    return {
      messages: [
        {
          info: { id: "parent-user", role: "user", sessionID: "parent" },
          parts: [],
        },
        {
          info: {
            id: "parent-assistant",
            role: "assistant",
            sessionID: "parent",
          },
          parts: [
            {
              id: "task-part",
              type: "tool",
              tool: "task",
              state: {
                status: "error",
                input: { description: "Implement bounded task" },
                error: `Subagent failed (task_id: ${child}): Provider unavailable`,
                metadata: { sessionId: child },
                time: { start: 1, end: 2 },
              },
            },
          ],
        },
      ],
    };
  }
  return {
    h,
    send,
    fail,
    histories,
    sessions,
    prompts,
    logs,
    aborts,
    parentContext,
  };
}

test("all ten agents select their assigned primary model", async (t) => {
  const f = await fixture(t);
  for (const [agent, route] of Object.entries(config.routes)) {
    const m = await f.send(agent, agent);
    assert.equal(key(m.model), route[0]);
  }
});
test("build fails from Gemini to Go, duplicate events do not duplicate work", async (t) => {
  const f = await fixture(t);
  await f.send("root", "build");
  const err = await f.fail("root");
  await f.h.event({
    event: { type: "message.updated", properties: { info: err } },
  });
  await until(() => f.prompts.length === 1);
  await tick();
  assert.equal(key(f.prompts[0].body.model), "opencode-go/gpt-5.6-luna");
  assert.equal(f.prompts[0].body.agent, "build");
  assert.equal(f.prompts[0].body.system, "preserve system");
  assert.deepEqual(f.prompts[0].body.format, { type: "text" });
  assert.equal(f.prompts[0].body.tools, undefined);
  assert.equal(f.prompts[0].body.parts.length, 1);
  assert.equal(f.prompts[0].body.parts[0].synthetic, true);
});
for (const status of [401, 402, 403, 404, 429, 503])
  test(`provider error ${status} advances route`, async (t) => {
    const f = await fixture(t);
    await f.send("root", "medium");
    await f.fail("root", apiError(status));
    await until(() => f.prompts.length === 1);
    assert.equal(
      key(f.prompts[0].body.model),
      "google/antigravity-claude-sonnet-4-6-thinking",
    );
  });
for (const error of [
  aborted,
  { name: "ContentFilterError", data: { message: "filtered" } },
  { name: "ContextOverflowError", data: { message: "too long" } },
  apiError(400, "Invalid tool schema"),
  apiError(403, "Blocked by safety policy"),
])
  test(`does not reroute ${error.name} ${error.data.message}`, async (t) => {
    const f = await fixture(t);
    await f.send("root", "build");
    await f.fail("root", error);
    await tick();
    assert.equal(f.prompts.length, 0);
  });
test("full provider failure exhausts the bounded route without a loop", async (t) => {
  const errors = Object.fromEntries(
    config.routes.medium.map((k) => [k, apiError(503)]),
  );
  const f = await fixture(t, { errors });
  await f.send("root", "medium");
  await f.fail("root");
  await until(() => f.logs.some((x) => x.includes("no remaining")));
  assert.deepEqual(
    f.prompts.map((x) => key(x.body.model)),
    config.routes.medium.slice(1),
  );
});
test("absent/unconnected models are skipped before dispatch", async (t) => {
  const f = await fixture(t, {
    available: ["opencode-go/gpt-5.6-luna", "github-copilot/gpt-5.6-luna"],
  });
  await f.send("root", "medium");
  await f.fail("root");
  await until(() => f.prompts.length === 1);
  assert.equal(f.prompts[0].body.model.providerID, "github-copilot");
});
test("catalogue failure stops rather than guessing a paid provider", async (t) => {
  const f = await fixture(t, { catalogueError: true });
  await assert.rejects(f.send("root", "build"), /Cannot verify/);
  assert.equal(f.prompts.length, 0);
});
test("cooldown applies across sessions and expires in same session", async (t) => {
  const f = await fixture(t, { cooldown: 50 });
  await f.send("root", "build");
  await f.fail("root");
  await until(() => f.prompts.length === 1);
  await tick();
  const during = await f.send("other", "build");
  assert.equal(during.model.providerID, "opencode-go");
  assert.equal(during.model.variant, undefined);
  await new Promise((r) => setTimeout(r, 60));
  const after = await f.send("root", "build", "opencode-go/gpt-5.6-luna");
  assert.equal(after.model.providerID, "google");
  assert.equal(after.model.variant, "high");
});
test("manual non-routed selection stays unchanged", async (t) => {
  const f = await fixture(t);
  const m = await f.send("root", "build", "opencode-go/deepseek-v4-flash");
  assert.equal(key(m.model), "opencode-go/deepseek-v4-flash");
});
test("new user input cancels a queued recovery", async (t) => {
  const f = await fixture(t, { delay: 40 });
  await f.send("root", "build");
  await f.fail("root");
  await tick();
  await f.send("root", "build");
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(f.prompts.length, 0);
});
test("user abort cancels a queued recovery", async (t) => {
  const f = await fixture(t, { delay: 40 });
  await f.send("root", "build");
  await f.fail("root");
  await tick();
  await f.h.event({
    event: {
      type: "session.error",
      properties: { sessionID: "root", error: aborted },
    },
  });
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(f.prompts.length, 0);
});
test("native child task recovery is awaited and returned to its parent exactly once", async (t) => {
  const f = await fixture(t);
  await f.send("parent", "build");
  f.sessions.set("child", { id: "child", parentID: "parent" });
  await f.send("child", "medium");
  await f.fail("child");
  await tick();
  assert.equal(f.prompts.length, 0);
  const context = f.parentContext();
  await f.h["experimental.chat.messages.transform"]({}, context);
  assert.equal(f.prompts.length, 1);
  assert.equal(f.prompts[0].id, "child");
  assert.equal(f.prompts[0].body.agent, "medium");
  const state = context.messages[1].parts[0].state;
  assert.equal(state.status, "completed");
  assert.match(state.output, /DONE: recovered result/);
  assert.equal(state.metadata.fallbackRecovered, true);
  await f.h["experimental.chat.messages.transform"]({}, f.parentContext());
  assert.equal(f.prompts.length, 1);
});
test("child failure can be recovered even if event delivery arrives late", async (t) => {
  const f = await fixture(t);
  await f.send("parent", "build");
  f.sessions.set("child", { id: "child", parentID: "parent" });
  await f.send("child", "fast");
  await f.fail("child", apiError(403), false);
  const context = f.parentContext();
  await f.h["experimental.chat.messages.transform"]({}, context);
  assert.equal(f.prompts[0].body.model.modelID, "antigravity-gemini-3.8-flash");
  assert.equal(context.messages[1].parts[0].state.status, "completed");
});
test("unrelated and historical child sessions are not resumed", async (t) => {
  const f = await fixture(t);
  f.sessions.set("child", { id: "child", parentID: "different" });
  await f.send("child", "medium");
  await f.fail("child", apiError(403), false);
  await f.h["experimental.chat.messages.transform"]({}, f.parentContext());
  assert.equal(f.prompts.length, 0);
  const historical = f.parentContext();
  historical.messages.push({
    info: { role: "user", sessionID: "parent" },
    parts: [],
  });
  await f.h["experimental.chat.messages.transform"]({}, historical);
  assert.equal(f.prompts.length, 0);
});
test("retry event interrupts native backoff and recovers without treating own abort as cancellation", async (t) => {
  const f = await fixture(t);
  await f.send("root", "build");
  await f.fail("root", undefined, false);
  await f.h.event({
    event: {
      type: "session.status",
      properties: {
        sessionID: "root",
        status: { type: "retry", message: "Rate limit exceeded" },
      },
    },
  });
  await until(() => f.prompts.length === 1);
  assert.deepEqual(f.aborts, ["root"]);
});
test("exhausted child remains an error, never a fabricated success", async (t) => {
  const f = await fixture(t, {
    errors: Object.fromEntries(
      config.routes.medium.map((k) => [k, apiError(403)]),
    ),
  });
  f.sessions.set("child", { id: "child", parentID: "parent" });
  await f.send("child", "medium");
  await f.fail("child", apiError(403), false);
  const context = f.parentContext();
  await f.h["experimental.chat.messages.transform"]({}, context);
  assert.equal(context.messages[1].parts[0].state.status, "error");
  assert.equal(f.prompts.length, 3);
});

const notice =
  "Quota protection: All 2 account(s) are over 80% usage for gemini. Quota resets in 143h 8m. Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable.";
async function syntheticFailure(f, id, text = notice) {
  const info = await f.fail(id, undefined, false);
  delete info.error;
  info.providerID = "google";
  const message = f.histories.get(id).at(-1);
  message.parts = [{ type: "text", text }];
  return message;
}

test("completed native task with Antigravity synthetic quota text recovers in the child session", async (t) => {
  const f = await fixture(t);
  f.sessions.set("child", { id: "child", parentID: "parent" });
  await f.send("child", "medium", config.routes.medium[1]);
  await syntheticFailure(f, "child");
  const context = f.parentContext();
  const part = context.messages[1].parts[0];
  part.state.status = "completed";
  part.state.output = `<task_result>${notice}</task_result>`;
  await f.h["experimental.chat.messages.transform"]({}, context);
  assert.equal(f.prompts.length, 1);
  assert.equal(part.state.metadata.fallbackRecovered, true);
  assert.match(part.state.output, /DONE: recovered result/);
});

test("root idle detects exact synthetic quota notices but leaves ordinary explanations alone", async (t) => {
  const f = await fixture(t);
  await f.send("root", "build");
  const message = await syntheticFailure(
    f,
    "root",
    `The provider said: ${notice}`,
  );
  config.routes.build.push(key(message.info));
  t.after(() => config.routes.build.pop());
  await f.h.event({
    event: { type: "session.idle", properties: { sessionID: "root" } },
  });
  await tick();
  assert.equal(f.prompts.length, 0);
  message.parts[0].text = notice;
  await f.h.event({
    event: { type: "session.idle", properties: { sessionID: "root" } },
  });
  await until(() => f.prompts.length === 1);
  await f.h.event({
    event: {
      type: "session.status",
      properties: { sessionID: "root", status: { type: "idle" } },
    },
  });
  await tick();
  assert.equal(f.prompts.length, 1);
});

for (const text of [
  notice,
  "All 2 account(s) rate-limited for gemini. Quota resets in 143h 8m. Add more accounts with `opencode auth login` or wait and retry.",
]) {
  test(`a synthetic quota failure during recovery continues the bounded chain: ${text.slice(0, 20)}`, async (t) => {
    const f = await fixture(t, { texts: { [config.routes.build[0]]: text } });
    await f.send("root", "build", config.routes.build[1]);
    await f.fail("root");
    await until(() => f.prompts.length === 2);
    assert.deepEqual(
      f.prompts.map((p) => key(p.body.model)),
      [config.routes.build[0], config.routes.build[2]],
    );
    await tick();
    assert.equal(f.prompts.length, 2);
  });
}

for (const error of [
  apiError(400, "Unsupported service_tier: flex"),
  apiError(410, "Model exo-free has been deprecated."),
])
  test(`observed compatibility error ${error.data.statusCode} advances the route`, async (t) => {
    const f = await fixture(t);
    await f.send("root", "medium");
    await f.fail("root", error);
    await until(() => f.prompts.length === 1);
    assert.equal(key(f.prompts[0].body.model), config.routes.medium[1]);
  });

test("an old completed quota task becomes an error in parent context when all recovery attempts fail", async (t) => {
  const f = await fixture(t, {
    errors: Object.fromEntries(
      config.routes.medium.map((m) => [
        m,
        apiError(410, "Model backup has been deprecated."),
      ]),
    ),
  });
  f.sessions.set("child", { id: "child", parentID: "parent" });
  await f.send("child", "medium", config.routes.medium[1]);
  await syntheticFailure(f, "child");
  const context = f.parentContext(),
    part = context.messages[1].parts[0];
  part.state.status = "completed";
  part.state.output = `<task_result>${notice}</task_result>`;
  await f.h["experimental.chat.messages.transform"]({}, context);
  assert.equal(part.state.status, "error");
  assert.match(part.state.error, /quota exhausted/);
  assert.equal(part.state.output, undefined);
  assert.equal(part.state.metadata.fallbackRecovered, false);
  const attempts = f.prompts.length;
  await f.h["experimental.chat.messages.transform"]({}, context);
  assert.equal(
    f.prompts.length,
    attempts,
    "Failed historical recovery must not repeat on every parent call",
  );
});
