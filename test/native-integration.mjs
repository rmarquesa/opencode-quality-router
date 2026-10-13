// Real OpenCode server + synthetic loopback LLM; no credentials or paid calls.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  writeFile,
  copyFile,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import assert from "node:assert/strict";
const root = await mkdtemp(join(tmpdir(), "quality-router-native-"));
const calls = [];
let schemaSeen = false,
  parentReceived = false;
const migration = process.argv.includes("--migration");
const compatibilityScenario = process.argv.includes("--compatibility");
const syntheticExhausted = process.argv.includes("--synthetic-exhausted");
const comparisonGuard = process.argv.includes("--comparison-guard");
const valueFree = process.argv.includes("--value-free") || comparisonGuard;
const valueExhausted =
  process.argv.includes("--value-exhausted") || syntheticExhausted;
const valueScenario =
  valueFree ||
  valueExhausted ||
  compatibilityScenario ||
  process.argv.includes("--value");
let economicsSeen = false;
const syntheticScenario =
  process.argv.includes("--synthetic") || syntheticExhausted;
const providerID = syntheticScenario ? "google" : "synthetic";
const rootFailure = process.argv.includes("--root");
const orderScenario = process.argv.includes("--order");
const concurrentScenario = process.argv.includes("--concurrent");
const permissionScenario = process.argv.includes("--permissions");
const llm = createServer(async (req, res) => {
  let raw = "";
  for await (const c of req) raw += c;
  const body = JSON.parse(raw || "{}");
  calls.push(body.model);
  if (
    (compatibilityScenario &&
      ["child-selected", "child-backup"].includes(body.model)) ||
    (syntheticExhausted && body.model === "child-backup")
  ) {
    const retired = body.model === "child-backup";
    res.writeHead(retired ? 410 : 400, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          message: retired
            ? "Model child-backup has been deprecated."
            : "Unsupported service_tier: flex",
          type: "invalid_request_error",
        },
      }),
    );
    return;
  }
  if (
    (body.model === "child-selected" && !valueFree) ||
    (valueExhausted && body.model === "child-backup") ||
    (rootFailure && body.model === "coordinator")
  ) {
    if (!syntheticScenario) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: "Quota exhausted (synthetic)",
            type: "rate_limit_error",
          },
        }),
      );
      return;
    }
  }
  let delta,
    finish = "stop";
  if (
    syntheticScenario &&
    (body.model === "child-selected" ||
      (rootFailure && body.model === "coordinator"))
  ) {
    delta = {
      content:
        "Quota protection: All 2 account(s) are over 80% usage for gemini. Quota resets in 143h 8m. Add more accounts, wait for quota reset, or set soft_quota_threshold_percent: 100 to disable.",
    };
  } else if (body.model === "coordinator") {
    const tools = body.tools ?? [];
    const def = tools.find((t) => t.function?.name === "task");
    if (permissionScenario) {
      assert.equal(def, undefined, "Denied task tool must remain hidden");
      delta = { content: "PERMISSION_PRESERVED" };
    } else {
      schemaSeen = !!def?.function?.parameters?.properties?.model;
      const results = body.messages?.filter((m) => m.role === "tool") ?? [];
      if (valueScenario && results.length) {
        const comparison = JSON.parse(results[0].content);
        assert.equal(comparison.objective, "value");
        assert.ok(
          comparison.candidates.every((c) => !("rank" in c)),
          "Value context must not imply a fixed quality ranking",
        );
        assert.deepEqual(
          comparison.candidates.map((c) => c.model),
          comparison.candidates
            .map((c) => c.model)
            .sort((a, b) => a.localeCompare(b)),
        );
        const selected = comparison.candidates.find((c) =>
          c.model.endsWith("/child-selected"),
        );
        const expensive = comparison.candidates.find((c) =>
          c.model.endsWith("/child-parallel"),
        );
        assert.equal(
          selected.economics.billing,
          valueFree ? "free" : "metered",
        );
        assert.ok(
          selected.economics.apiReferencePrice.output <
            expensive.economics.apiReferencePrice.output,
        );
        assert.equal(
          selected.economics.apiReferencePrice.actualChargeConfirmed,
          false,
        );
        economicsSeen = true;
      }
      if (
        valueExhausted &&
        results.some((m) => m.tool_call_id === "call_task")
      ) {
        delta = { content: "VALUE_EXHAUSTED" };
      } else if (
        results.some((m) => JSON.stringify(m).includes("CHILD_RECOVERED"))
      ) {
        parentReceived = true;
        delta = { content: "PARENT_RECEIVED_RESULT" };
      } else if (results.length) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id:
                comparisonGuard &&
                results.some((r) => r.tool_call_id === "call_task")
                  ? "call_task_corrected"
                  : "call_task",
              type: "function",
              function: {
                name: "task",
                arguments: JSON.stringify({
                  description: "Synthetic quality task",
                  subagent_type: "frontend-specialist",
                  task_domain: "frontend",
                  task_complexity: "simple",
                  model: `${providerID}/child-selected`,
                  model_reason: valueScenario
                    ? "Bounded UI task: selected can meet the checks at a lower reference cost than the configured default; backup is an adequate assessed alternative."
                    : "Selected for this test",
                  ...(valueScenario
                    ? {
                        comparison_id: JSON.parse(
                          results.find((r) => r.tool_call_id === "call_quota")
                            .content,
                        ).comparison_id,
                        model_comparison: JSON.parse(
                          results.find((r) => r.tool_call_id === "call_quota")
                            .content,
                        )
                          .candidates.filter(
                            (c) =>
                              !comparisonGuard ||
                              results.some(
                                (r) => r.tool_call_id === "call_task",
                              ) ||
                              c.model.endsWith("/child-selected"),
                          )
                          .map((c) => ({
                            model: c.model,
                            fit: "suitable",
                            reason:
                              "Concrete bounded UI task fits tools/context; compare reference costs without assuming quality from price.",
                          })),
                        model_order: [
                          `${providerID}/child-backup`,
                          ...(compatibilityScenario
                            ? [`${providerID}/child-parallel`]
                            : []),
                        ],
                      }
                    : {}),
                  ...(orderScenario
                    ? {
                        model_order: [
                          `${providerID}/child-parallel`,
                          `${providerID}/child-backup`,
                        ],
                      }
                    : {}),
                  prompt: "Return CHILD_RECOVERED. Do not use tools.",
                }),
              },
            },
          ],
        };
        if (concurrentScenario)
          delta.tool_calls.push({
            index: 1,
            id: "call_parallel",
            type: "function",
            function: {
              name: "task",
              arguments: JSON.stringify({
                description: "Parallel quality task",
                subagent_type: "frontend-specialist",
                task_domain: "frontend",
                task_complexity: "complex",
                model: `${providerID}/child-parallel`,
                model_reason: valueScenario
                  ? "This independent task has complex cross-component requirements; select this model for task fit, with cost considered after expected quality."
                  : "Independent selection",
                ...(valueScenario
                  ? {
                      model_order: [],
                      comparison_id: JSON.parse(
                        results.find(
                          (r) => r.tool_call_id === "call_quota_complex",
                        ).content,
                      ).comparison_id,
                      model_comparison: JSON.parse(
                        results.find(
                          (r) => r.tool_call_id === "call_quota_complex",
                        ).content,
                      ).candidates.map((c) => ({
                        model: c.model,
                        fit: "suitable",
                        reason:
                          "Independent complex task fits tools/context; cost considered after suitability.",
                      })),
                    }
                  : {}),
                prompt: "Return CHILD_RECOVERED.",
              }),
            },
          });
        finish = "tool_calls";
      } else {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "call_quota",
              type: "function",
              function: {
                name: "quota_candidates",
                arguments: JSON.stringify({
                  agent: "frontend-specialist",
                  task: "Implement bounded UI change and verify acceptance checks",
                  task_domain: "frontend",
                  task_complexity: "simple",
                }),
              },
            },
          ],
        };
        if (valueScenario && concurrentScenario)
          delta.tool_calls.push({
            index: 1,
            id: "call_quota_complex",
            type: "function",
            function: {
              name: "quota_candidates",
              arguments: JSON.stringify({
                agent: "frontend-specialist",
                task: "Complex cross-component task with verification",
                task_domain: "frontend",
                task_complexity: "complex",
              }),
            },
          });
        finish = "tool_calls";
      }
    }
  } else {
    delta = { content: rootFailure ? "ROOT_RECOVERED" : "CHILD_RECOVERED" };
  }
  const chunk = (d, f) => ({
    id: "chatcmpl-synthetic",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: body.model,
    choices: [{ index: 0, delta: d, finish_reason: f }],
  });
  res.writeHead(200, { "content-type": "text/event-stream" });
  res.write(
    `data: ${JSON.stringify(chunk({ role: "assistant", ...delta }, null))}\n\n`,
  );
  res.write(
    `data: ${JSON.stringify({ ...chunk({}, finish), usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })}\n\n`,
  );
  res.end("data: [DONE]\n\n");
});
await new Promise((r, j) => llm.once("error", j).listen(0, "127.0.0.1", r));
const models = [
  "coordinator",
  "coordinator-backup",
  "child-default",
  "child-selected",
  "child-backup",
  "child-parallel",
];
const agent = {
  build: { mode: "primary", model: `${providerID}/coordinator` },
  "frontend-specialist": {
    mode: "subagent",
    description: "Synthetic frontend test",
    model: `${providerID}/child-default`,
    permission: { edit: "deny", bash: "deny" },
  },
};
const routing = {
  objective: valueScenario ? "value" : "quality",
  preserveManualSelection: !migration,
  providerEconomics: {
    [providerID]: { billing: "metered", source: "synthetic contract" },
  },
  retryDelayMs: 10,
  quotaTtlMs: 60000,
  statePath: join(root, "quota.json"),
  quota: {},
  agents: {
    build: {
      candidates: ["coordinator", "coordinator-backup"].map((m) => ({
        model: providerID + "/" + m,
      })),
    },
    "frontend-specialist": {
      candidates: [
        "child-default",
        "child-selected",
        "child-backup",
        "child-parallel",
      ].map((m) => ({
        model: providerID + "/" + m,
        ...(valueFree && m === "child-selected"
          ? {
              economics: {
                billing: "free",
                source: "verified synthetic free offer",
              },
            }
          : {}),
      })),
    },
  },
};
// Exclude the default from fallback with an observed failure so selected->backup is deterministic.
await writeFile(
  routing.statePath,
  JSON.stringify({
    version: 1,
    observations: {},
    blocks: {
      [`${providerID}/child-default`]: {
        until: Date.now() + 600000,
        reason: "synthetic test block",
      },
    },
  }),
);
await writeFile(join(root, "routing.json"), JSON.stringify(routing));
await mkdir(join(root, "config", "opencode"), { recursive: true });
await mkdir(join(root, "cache", "opencode"), { recursive: true });
const cache = process.env.XDG_CACHE_HOME ?? join(process.env.HOME, ".cache");
try {
  await copyFile(
    join(cache, "opencode", "models.json"),
    join(root, "cache", "opencode", "models.json"),
  );
} catch {}
const plugin = resolve("src/index.mjs");
const config = {
  model: `${providerID}/coordinator`,
  small_model: `${providerID}/coordinator-backup`,
  default_agent: "build",
  plugin: [plugin],
  agent,
  provider: {
    [providerID]: {
      npm: "@ai-sdk/openai-compatible",
      options: {
        apiKey: "fake",
        baseURL: `http://127.0.0.1:${llm.address().port}/v1`,
      },
      models: Object.fromEntries(
        models.map((m) => [
          m,
          {
            name: m,
            limit: { context: 128000, output: 4096 },
            tool_call: true,
            cost: {
              input: m === "child-selected" ? (valueFree ? 0 : 1) : 50,
              output: m === "child-selected" ? (valueFree ? 0 : 2) : 100,
            },
          },
        ]),
      ),
    },
  },
  enabled_providers: [providerID],
  permission: {
    "*": "deny",
    task: permissionScenario ? "deny" : "allow",
    quota_candidates: "allow",
  },
  share: "disabled",
  autoupdate: false,
};
await writeFile(
  join(root, "config", "opencode", "opencode.json"),
  JSON.stringify(config),
);
const env = {
  ...process.env,
  OPENCODE_QUALITY_ROUTER_CONFIG: join(root, "routing.json"),
  OPENCODE_TEST_HOME: root,
  XDG_CONFIG_HOME: join(root, "config"),
  XDG_DATA_HOME: join(root, "data"),
  XDG_CACHE_HOME: join(root, "cache"),
  XDG_STATE_HOME: join(root, "state"),
  OPENCODE_CONFIG_DIR: join(root, "config", "opencode"),
  OPENCODE_CONFIG: join(root, "config", "opencode", "opencode.json"),
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_DEFAULT_PLUGINS: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_DISABLE_MODELS_FETCH: "true",
};
delete env.OPENCODE_CONFIG_CONTENT;
delete env.OPENCODE_SERVER_PASSWORD;
delete env.OPENCODE_SERVER_USERNAME;
const portProbe = createServer();
await new Promise((r, j) =>
  portProbe.once("error", j).listen(0, "127.0.0.1", r),
);
const hostPort = portProbe.address().port;
await new Promise((r) => portProbe.close(r));
const host = spawn(
  process.env.OPENCODE_BIN ?? "opencode",
  ["serve", "--hostname", "127.0.0.1", "--port", String(hostPort)],
  { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
);
let output = "";
host.stdout.on("data", (x) => (output += x));
host.stderr.on("data", (x) => (output += x));
try {
  const deadline = Date.now() + 30000;
  let base;
  while (!base) {
    base = output.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
    if (Date.now() > deadline) throw Error("Server start timeout: " + output);
    await new Promise((r) => setTimeout(r, 100));
  }
  const create = await fetch(base + "/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "Quality Router synthetic test" }),
  });
  const session = await create.json();
  const response = await fetch(base + `/session/${session.id}/message`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      agent: "build",
      model: {
        providerID,
        modelID: migration ? "coordinator-backup" : "coordinator",
      },
      parts: [{ type: "text", text: "Run synthetic test." }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
  if (migration)
    assert.equal(
      calls[0],
      "coordinator",
      "Old session model must yield to the new configured workhorse",
    );
  if (rootFailure) {
    let done = false;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      const history = await (
        await fetch(base + `/session/${session.id}/message`)
      ).json();
      done = history.some((m) =>
        m.parts.some((p) => p.type === "text" && p.text === "ROOT_RECOVERED"),
      );
      if (done) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(done, "Root did not recover");
  } else if (permissionScenario)
    assert.ok(JSON.stringify(result).includes("PERMISSION_PRESERVED"));
  else if (valueExhausted) {
    assert.ok(JSON.stringify(result).includes("VALUE_EXHAUSTED"));
    assert.ok(economicsSeen);
    assert.equal(calls.filter((m) => m === "child-selected").length, 1);
    assert.equal(calls.filter((m) => m === "child-backup").length, 1);
    assert.ok(
      !calls.includes("child-parallel"),
      "Unassessed expensive alternative must not run",
    );
    assert.ok(!calls.includes("child-default"));
    if (syntheticExhausted) {
      const history = await (
        await fetch(base + `/session/${session.id}/message`)
      ).json();
      const task = history
        .flatMap((m) => m.parts)
        .find((p) => p.type === "tool" && p.tool === "task");
      assert.equal(
        task.state.status,
        "error",
        "A quota notice must not persist as a completed task",
      );
      const state = JSON.parse(await readFile(routing.statePath, "utf8"));
      assert.equal(state.blocks[`${providerID}/child-backup`].permanent, true);
    }
  } else {
    assert.ok(schemaSeen, "Native task schema missing model");
    if (valueScenario) assert.ok(economicsSeen);
    assert.ok(parentReceived, "Parent did not receive recovered child");
    assert.ok(calls.includes("child-selected"), "Explicit model ignored");
    if (valueFree)
      assert.ok(
        !calls.includes("child-backup"),
        "Healthy free selection must not be replaced with a paid backup",
      );
    else
      assert.ok(
        calls.includes(
          orderScenario || compatibilityScenario
            ? "child-parallel"
            : "child-backup",
        ),
        "Child fallback missing",
      );
    if (orderScenario)
      assert.ok(
        !calls.includes("child-backup"),
        "Task-specific quality order ignored",
      );
    assert.ok(!calls.includes("child-default"), "Blocked default was used");
    if (compatibilityScenario) {
      const state = JSON.parse(await readFile(routing.statePath, "utf8"));
      assert.equal(
        state.blocks[`${providerID}/child-selected`].reason,
        "incompatible",
      );
      assert.equal(state.blocks[`${providerID}/child-backup`].permanent, true);
      for (const model of ["child-selected", "child-backup", "child-parallel"])
        assert.equal(calls.filter((x) => x === model).length, 1);
    }
    const sessions = await (await fetch(base + "/session")).json();
    const childSessions = sessions.filter((s) => s.parentID === session.id);
    const histories = await Promise.all(
      childSessions.map(async (child) => ({
        child,
        history: await (
          await fetch(base + `/session/${child.id}/message`)
        ).json(),
      })),
    );
    const selectedHistory = histories.find((x) =>
      x.history.some(
        (m) =>
          m.info.role === "assistant" && m.info.modelID === "child-selected",
      ),
    );
    const child = selectedHistory?.child;
    assert.ok(child);
    if (concurrentScenario) {
      assert.equal(sessions.filter((s) => s.parentID === session.id).length, 2);
      assert.ok(calls.includes("child-parallel"));
    }
    const history = selectedHistory.history;
    assert.ok(
      history.some(
        (m) =>
          m.info.role === "assistant" && m.info.modelID === "child-selected",
      ),
    );
    assert.ok(
      !history.some((m) =>
        m.parts.some(
          (p) =>
            p.type === "text" && p.text.includes("[quality-router-ticket:"),
        ),
      ),
      "Routing marker leaked into child history",
    );
  }
  if (valueFree || syntheticExhausted) {
    const observed = JSON.parse(await readFile(routing.statePath, "utf8"));
    if (valueFree)
      assert.ok(
        observed.access?.[`${providerID}/child-selected`]?.lastSuccessAt,
        "A successful native response records access without a quality grade",
      );
    if (syntheticExhausted)
      assert.equal(
        observed.access?.[`${providerID}/child-selected`]?.lastSuccessAt,
        undefined,
        "Quota-only text must not count as access success",
      );
    assert.equal(
      observed.evaluations,
      undefined,
      "Successful task execution does not invent capability grades",
    );
  }
  if (comparisonGuard) {
    const transcript = await fetch(
      base + "/session/" + session.id + "/message",
    ).then((r) => r.json());
    const parts = transcript.flatMap((m) => m.parts ?? []);
    assert.ok(
      parts.some(
        (p) =>
          p.type === "tool" &&
          p.tool === "task" &&
          p.state?.status === "error" &&
          /alternative/.test(p.state.error),
      ),
    );
    assert.equal(calls.filter((m) => m === "child-selected").length, 1);
  }
  console.log(
    JSON.stringify({
      passed: true,
      syntheticQuotaResponse: syntheticScenario,
      valueScenario,
      valueExhausted,
      valueFree,
      economicsSeen,
      scenario: rootFailure
        ? "root"
        : permissionScenario
          ? "permissions"
          : concurrentScenario
            ? "concurrent"
            : orderScenario
              ? "task-quality-order"
              : "explicit-child-fallback",
      calls,
      schemaSeen,
      parentReceived,
    }),
  );
} catch (e) {
  console.error(
    JSON.stringify({
      passed: false,
      error: String(e),
      calls,
      hostOutput: output,
      artifacts: root,
    }),
  );
  process.exitCode = 1;
} finally {
  host.kill("SIGTERM");
  llm.closeAllConnections();
  await new Promise((r) => llm.close(r));
}
