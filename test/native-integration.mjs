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
    body.model === "child-selected" ||
    (rootFailure && body.model === "coordinator")
  ) {
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
  let delta,
    finish = "stop";
  if (body.model === "coordinator") {
    const tools = body.tools ?? [];
    const def = tools.find((t) => t.function?.name === "task");
    if (permissionScenario) {
      assert.equal(def, undefined, "Denied task tool must remain hidden");
      delta = { content: "PERMISSION_PRESERVED" };
    } else {
      schemaSeen = !!def?.function?.parameters?.properties?.model;
      const results = body.messages?.filter((m) => m.role === "tool") ?? [];
      if (results.some((m) => JSON.stringify(m).includes("CHILD_RECOVERED"))) {
        parentReceived = true;
        delta = { content: "PARENT_RECEIVED_RESULT" };
      } else if (results.length) {
        delta = {
          tool_calls: [
            {
              index: 0,
              id: "call_task",
              type: "function",
              function: {
                name: "task",
                arguments: JSON.stringify({
                  description: "Synthetic quality task",
                  subagent_type: "frontend-specialist",
                  model: "synthetic/child-selected",
                  model_reason: "Selected for this test",
                  ...(orderScenario
                    ? {
                        model_order: [
                          "synthetic/child-parallel",
                          "synthetic/child-backup",
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
                model: "synthetic/child-parallel",
                model_reason: "Independent selection",
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
                arguments: JSON.stringify({ agent: "frontend-specialist" }),
              },
            },
          ],
        };
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
  build: { mode: "primary", model: "synthetic/coordinator" },
  "frontend-specialist": {
    mode: "subagent",
    description: "Synthetic frontend test",
    model: "synthetic/child-default",
    permission: { edit: "deny", bash: "deny" },
  },
};
const routing = {
  retryDelayMs: 10,
  quotaTtlMs: 60000,
  statePath: join(root, "quota.json"),
  quota: {},
  agents: {
    build: {
      candidates: ["coordinator", "coordinator-backup"].map((m) => ({
        model: "synthetic/" + m,
      })),
    },
    "frontend-specialist": {
      candidates: [
        "child-default",
        "child-selected",
        "child-backup",
        "child-parallel",
      ].map((m) => ({ model: "synthetic/" + m })),
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
      "synthetic/child-default": {
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
  model: "synthetic/coordinator",
  small_model: "synthetic/coordinator-backup",
  default_agent: "build",
  plugin: [plugin],
  agent,
  provider: {
    synthetic: {
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
            cost: { input: 0, output: 0 },
          },
        ]),
      ),
    },
  },
  enabled_providers: ["synthetic"],
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
const host = spawn(
  process.env.OPENCODE_BIN ?? "opencode",
  ["serve", "--hostname", "127.0.0.1", "--port", "0"],
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
      model: { providerID: "synthetic", modelID: "coordinator" },
      parts: [{ type: "text", text: "Run synthetic test." }],
    }),
    signal: AbortSignal.timeout(45000),
  });
  const result = await response.json();
  assert.ok(response.ok, JSON.stringify(result));
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
  else {
    assert.ok(schemaSeen, "Native task schema missing model");
    assert.ok(parentReceived, "Parent did not receive recovered child");
    assert.ok(calls.includes("child-selected"), "Explicit model ignored");
    assert.ok(
      calls.includes(orderScenario ? "child-parallel" : "child-backup"),
      "Child fallback missing",
    );
    if (orderScenario)
      assert.ok(
        !calls.includes("child-backup"),
        "Task-specific quality order ignored",
      );
    assert.ok(!calls.includes("child-default"), "Blocked default was used");
    const sessions = await (await fetch(base + "/session")).json();
    const child = sessions.find((s) => s.parentID === session.id);
    assert.ok(child);
    if (concurrentScenario) {
      assert.equal(sessions.filter((s) => s.parentID === session.id).length, 2);
      assert.ok(calls.includes("child-parallel"));
    }
    const history = await (
      await fetch(base + `/session/${child.id}/message`)
    ).json();
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
  console.log(
    JSON.stringify({
      passed: true,
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
