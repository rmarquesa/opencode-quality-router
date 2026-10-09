import test from "node:test";
import assert from "node:assert/strict";
import {
  candidateDetails,
  selectionPolicy,
  taskDecision,
} from "../src/decision.mjs";
import { validateConfig } from "../src/routing.mjs";
const config = (objective = "value") =>
  validateConfig({
    objective,
    agents: {
      frontend: {
        candidates: [
          { model: "x/expensive" },
          { model: "x/adequate" },
          { model: "x/backup" },
        ],
      },
    },
  });

test("value policy requires a task-specific quality/cost comparison rather than price-as-quality", () => {
  assert.match(selectionPolicy(config()), /quality\/cost tradeoff/);
  assert.match(
    selectionPolicy(config()),
    /Model size, price, provider and configured rank are not evidence of quality/,
  );
  assert.match(
    selectionPolicy(config("quality")),
    /Cost and latency do not rank models/,
  );
  assert.equal(
    validateConfig({ agents: config().agents }).objective,
    "quality",
  );
  assert.throws(() => config("cheapest"), /objective/);
});
test("catalog API rates are separate from included plan economics and private options", () => {
  const c = config();
  c.providerEconomics = {
    x: {
      billing: "included",
      source: "operator",
      notes: "Subscription capacity",
    },
  };
  const result = candidateDetails(
    c,
    { model: "x/adequate" },
    {
      name: "Example",
      cost: {
        input: 1,
        output: 2,
        cache: { read: 0.1, write: 0.2 },
        tiers: [{ input: 2, output: 3, tier: { size: 200000 } }],
      },
      limit: { context: 200000, output: 10000 },
      capabilities: { reasoning: true, toolcall: true, input: { image: true } },
      options: { apiKey: "secret" },
      headers: { Authorization: "secret" },
    },
  );
  assert.equal(result.economics.billing, "included");
  assert.equal(result.economics.apiReferencePrice.input, 1);
  assert.equal(result.economics.apiReferencePrice.actualChargeConfirmed, false);
  assert.equal(
    result.economics.apiReferencePrice.contextTiers[0].contextTokens,
    200000,
  );
  assert.equal(result.economics.quotaUnitsPerRequest, undefined);
  assert.equal(result.catalog.imageInput, true);
  assert.ok(!JSON.stringify(result).includes("secret"));
});
test("unknown costs remain unknown and explicit candidate economics override provider defaults", () => {
  const c = config();
  assert.equal(
    candidateDetails(c, { model: "x/backup" }, {}).economics.billing,
    "unknown",
  );
  assert.equal(
    candidateDetails(c, { model: "x/backup" }, {}).economics.apiReferencePrice
      .input,
    undefined,
  );
  c.providerEconomics = { x: { billing: "included" } };
  const r = candidateDetails(
    c,
    {
      model: "x/backup",
      economics: { billing: "metered", quotaUnitsPerRequest: 2 },
    },
    {},
  );
  assert.equal(r.economics.billing, "metered");
  assert.equal(r.economics.quotaUnitsPerRequest, 2);
});
test("value tasks require explicit decisions and preserve only assessed alternatives", () => {
  const c = config();
  assert.throws(
    () => taskDecision(c, "frontend", {}),
    /Value routing requires/,
  );
  assert.throws(
    () =>
      taskDecision(c, "frontend", {
        model: "x/adequate",
        model_reason: " ",
        model_order: [],
      }),
    /Value routing requires/,
  );
  assert.throws(
    () =>
      taskDecision(c, "frontend", {
        model: "x/adequate",
        model_reason: "UI change needs no expensive reasoning",
      }),
    /Value routing requires/,
  );
  assert.deepEqual(
    taskDecision(c, "frontend", {
      model: "x/adequate",
      model_reason: "Meets the checks at a lower reference cost",
      model_order: ["x/backup"],
    }),
    ["x/adequate", "x/backup"],
  );
  assert.deepEqual(
    taskDecision(c, "frontend", {
      model: "x/adequate",
      model_reason: "Only acceptable model",
      model_order: [],
    }),
    ["x/adequate"],
  );
  assert.throws(
    () =>
      taskDecision(c, "frontend", {
        model: "x/adequate",
        model_order: ["x/not-allowed"],
      }),
    /model order/,
  );
  assert.throws(
    () =>
      taskDecision(c, "frontend", {
        model: "x/adequate",
        model_order: ["x/backup", "x/backup"],
      }),
    /model order/,
  );
  assert.equal(taskDecision(config("quality"), "frontend", {}), undefined);
});
test("invalid billing claims and quota multipliers are rejected", () => {
  assert.throws(
    () =>
      validateConfig({
        ...config(),
        providerEconomics: { x: { billing: "invalid" } },
      }),
    /billing/,
  );
  assert.throws(
    () =>
      validateConfig({
        ...config(),
        providerEconomics: { x: { quotaUnitsPerRequest: -1 } },
      }),
    /quota units/,
  );
});

test("value delegation requires consulting candidates in the same parent session", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { default: plugin } = await import("../src/index.mjs");
  const dir = await mkdtemp(join(tmpdir(), "quality-decision-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "routing.json");
  await writeFile(
    configPath,
    JSON.stringify({
      ...config(),
      quota: {},
      statePath: join(dir, "state.json"),
    }),
  );
  const h = await plugin(
    {
      directory: dir,
      client: {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "x",
                  models: { expensive: {}, adequate: {}, backup: {} },
                },
              ],
            },
          }),
        },
        app: { log: async () => {} },
      },
    },
    { configPath },
  );
  t.after(() => h.dispose());
  const args = {
    subagent_type: "frontend",
    task_domain: "frontend",
    task_complexity: "simple",
    model: "x/adequate",
    model_reason: "Meets bounded UI checks with lower cost than expensive",
    model_order: ["x/backup"],
    prompt: "Implement a UI change",
  };
  const input = { tool: "task", sessionID: "parent", callID: "call" };
  await assert.rejects(
    () => h["tool.execute.before"](input, { args: { ...args } }),
    /Consult quota_candidates/,
  );
  await h.tool.quota_candidates.execute(
    {
      agent: "frontend",
      task: "Bounded UI change",
      task_domain: "frontend",
      task_complexity: "simple",
    },
    { sessionID: "other-parent" },
  );
  await assert.rejects(
    () => h["tool.execute.before"](input, { args: { ...args } }),
    /Consult quota_candidates/,
  );
  await h.tool.quota_candidates.execute(
    {
      agent: "frontend",
      task: "Bounded UI change",
      task_domain: "frontend",
      task_complexity: "simple",
    },
    { sessionID: "parent" },
  );
  const output = { args: { ...args } };
  await assert.rejects(
    () =>
      h["tool.execute.before"](input, {
        args: { ...args, task_complexity: "complex" },
      }),
    /Consult quota_candidates/,
  );
  await h["tool.execute.before"](input, output);
  assert.match(output.args.prompt, /^\[quality-router-ticket:/);
  await assert.rejects(
    () =>
      h["tool.execute.before"](
        { ...input, callID: "second" },
        { args: { ...args } },
      ),
    /Consult quota_candidates/,
  );
  for (let i = 0; i < 2; i++)
    await h.tool.quota_candidates.execute(
      {
        agent: "frontend",
        task: "Two bounded tasks",
        task_domain: "frontend",
        task_complexity: "simple",
      },
      { sessionID: "parent" },
    );
  for (let i = 0; i < 2; i++)
    await h["tool.execute.before"](
      { ...input, callID: "parallel-" + i },
      { args: { ...args } },
    );
});

test("verified free economics require live zero prices and do not infer free from OAuth zero rates", () => {
  const candidate = {
    model: "opencode/example",
    economics: { billing: "free", source: "Verified provider promotion" },
  };
  assert.equal(
    candidateDetails(config(), candidate, { cost: { input: 0, output: 0 } })
      .economics.billing,
    "free",
  );
  assert.equal(
    candidateDetails(config(), candidate, { cost: { input: 1, output: 2 } })
      .economics.billing,
    "unknown",
  );
  assert.equal(
    candidateDetails(config(), candidate, {}).economics.billing,
    "unknown",
  );
  assert.equal(
    candidateDetails(
      config(),
      { model: "openai/example" },
      { cost: { input: 0, output: 0 } },
    ).economics.billing,
    "unknown",
  );
});

test("a 177-model catalog stays discoverable without overflowing native output limits", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { default: plugin } = await import("../src/index.mjs");
  const dir = await mkdtemp(join(tmpdir(), "quality-paging-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const candidates = Array.from({ length: 177 }, (_, i) => ({
    model: "x/model-" + String(i).padStart(3, "0"),
  }));
  candidates[176].economics = { billing: "free", source: "Verified fixture" };
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      objective: "value",
      agents: { frontend: { candidates } },
      quota: {},
      statePath: join(dir, "state.json"),
    }),
  );
  const h = await plugin(
    {
      directory: dir,
      client: {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "x",
                  models: Object.fromEntries(
                    candidates.map((c, i) => [
                      c.model.split("/")[1],
                      {
                        limit: { context: 128000, output: 4096 },
                        cost: {
                          input: i === 176 ? 0 : 1,
                          output: i === 176 ? 0 : 2,
                        },
                        capabilities: {
                          reasoning: true,
                          toolcall: true,
                          input: { image: false },
                        },
                      },
                    ]),
                  ),
                },
              ],
            },
          }),
        },
        app: { log: async () => {} },
      },
    },
    { configPath },
  );
  t.after(() => h.dispose());
  const args = {
    agent: "frontend",
    task: "A bounded UI change",
    task_domain: "frontend",
    task_complexity: "simple",
  };
  const raw = await h.tool.quota_candidates.execute(args, {
    sessionID: "parent",
  });
  const page = JSON.parse(raw);
  assert.ok(Buffer.byteLength(raw) < 16384);
  assert.equal(page.candidate_index.length, 177);
  assert.equal(page.candidates.length, 12);
  assert.equal(page.next_offset, 12);
  assert.equal(page.candidate_index.at(-1).billing, "free");
  const detail = JSON.parse(
    await h.tool.quota_candidates.execute(
      { ...args, models: ["x/model-176"] },
      { sessionID: "parent" },
    ),
  );
  assert.equal(detail.candidates[0].model, "x/model-176");
  assert.equal(detail.candidates[0].economics.billing, "free");
  assert.equal(detail.next_offset, null);
  await assert.rejects(
    () =>
      h.tool.quota_candidates.execute(
        { ...args, models: ["x/not-allowed"] },
        { sessionID: "parent" },
      ),
    /outside/,
  );
});

test("a resumed child without retained task choices cannot silently use unassessed value alternatives", async (t) => {
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { default: plugin } = await import("../src/index.mjs");
  const dir = await mkdtemp(join(tmpdir(), "quality-resumed-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const configPath = join(dir, "config.json");
  await writeFile(
    configPath,
    JSON.stringify({
      ...config(),
      quota: {},
      statePath: join(dir, "state.json"),
    }),
  );
  let prompts = 0;
  const history = [
    {
      info: {
        id: "user",
        role: "user",
        agent: "frontend",
        sessionID: "child",
        model: { providerID: "x", modelID: "adequate" },
      },
      parts: [],
    },
    {
      info: {
        id: "assistant",
        role: "assistant",
        parentID: "user",
        sessionID: "child",
        agent: "frontend",
        providerID: "x",
        modelID: "adequate",
        error: {
          name: "APIError",
          data: { statusCode: 429, message: "Quota exhausted" },
        },
      },
      parts: [],
    },
  ];
  const h = await plugin(
    {
      directory: dir,
      client: {
        config: {
          providers: async () => ({
            data: {
              providers: [
                {
                  id: "x",
                  models: { adequate: {}, backup: {}, expensive: {} },
                },
              ],
            },
          }),
        },
        app: { log: async () => {} },
        session: {
          get: async () => ({ data: { id: "child", parentID: "parent" } }),
          messages: async () => ({ data: history }),
          prompt: async () => {
            prompts++;
            throw Error("Unexpected dispatch");
          },
        },
      },
    },
    { configPath },
  );
  t.after(() => h.dispose());
  const output = {
    messages: [
      { info: { role: "user", sessionID: "parent" }, parts: [] },
      {
        info: { role: "assistant", sessionID: "parent" },
        parts: [
          {
            id: "old-task",
            type: "tool",
            tool: "task",
            state: {
              status: "error",
              input: { subagent_type: "frontend" },
              metadata: { sessionId: "child" },
              error: "Subagent failed (task_id: child): quota",
            },
          },
        ],
      },
    ],
  };
  await h["experimental.chat.messages.transform"]({}, output);
  assert.equal(prompts, 0);
  assert.equal(output.messages[1].parts[0].state.status, "error");
});
