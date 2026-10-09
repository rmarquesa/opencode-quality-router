import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../src/config.mjs";
import { StateStore } from "../../src/store.mjs";
import { matrixRows } from "../../src/matrix.mjs";
import { modelOf, classifyError } from "../../src/routing.mjs";
import { CASES, parseAnswer } from "./cases.mjs";
import { ReferenceBudget } from "./budget.mjs";
const args = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = args.indexOf(name);
  return i < 0 ? fallback : args[i + 1];
};
const config = await loadConfig({ configPath: arg("--config") });
const catalog = new Map(
  Object.entries(JSON.parse(await readFile(arg("--catalog"), "utf8"))),
);
const store = new StateStore(config.statePath);
const reportDir = arg("--report-dir");
if (!reportDir) throw Error("--report-dir required");
await mkdir(reportDir, { recursive: true, mode: 0o700 });
const budget = Number(arg("--max-reference-usd", 0));
if (!Number.isFinite(budget) || budget < 0)
  throw Error("Invalid reference budget");
const referenceBudget = new ReferenceBudget(budget);
const startingState = await store.read();
const rows = matrixRows(config, catalog, startingState);
const evalRoot = await mkdtemp(join(tmpdir(), "opencode-quality-live-"));
const providers = {};
for (const [key, m] of catalog) {
  const { providerID, modelID } = modelOf(key);
  (providers[providerID] ??= { models: {} }).models[modelID] = {
    limit: { context: m.limit?.context ?? 128000, output: 1024 },
  };
}
const env = {
  ...process.env,
  OPENCODE_DISABLE_PROJECT_CONFIG: "true",
  OPENCODE_DISABLE_EXTERNAL_SKILLS: "true",
  OPENCODE_DISABLE_CLAUDE_CODE: "true",
  OPENCODE_CONFIG_CONTENT: JSON.stringify({
    provider: providers,
    share: "disabled",
    autoupdate: false,
    agent: {
      "router-evaluation": {
        mode: "primary",
        prompt:
          "Respond to the supplied reasoning task. Use no tools and make no external changes. Return the requested JSON only.",
        permission: { "*": "deny" },
      },
    },
  }),
};
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
  { cwd: evalRoot, env, stdio: ["ignore", "pipe", "pipe"] },
);
let logs = "";
host.stdout.on("data", (x) => (logs += x));
host.stderr.on("data", (x) => (logs += x));
let base;
const deadline = Date.now() + 30000;
while (!base) {
  base = logs.match(/http:\/\/127\.0\.0\.1:\d+/)?.[0];
  if (Date.now() > deadline) throw Error("Evaluation server start timeout");
  await new Promise((r) => setTimeout(r, 100));
}
const api = async (path, method = "GET", body, timeout = 35000) => {
  const response = await fetch(base + path, {
    method,
    headers: { "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(timeout),
  });
  if (!response.ok) throw Error("Native API HTTP " + response.status);
  return response.status === 204 ? undefined : response.json();
};
const records = [];
const save = async () => {
  const state = await store.read();
  const matrix = {
    version: 1,
    generatedAt: new Date().toISOString(),
    scope:
      "Every currently configured provider/model; limited case evidence only",
    rows: matrixRows(config, catalog, state),
  };
  await writeFile(
    join(reportDir, "matrix.json"),
    JSON.stringify(matrix, null, 2) + "\n",
    { mode: 0o600 },
  );
  await writeFile(
    join(reportDir, "results.json"),
    JSON.stringify(
      {
        referenceBudgetUSD: budget,
        reservedReferenceUSD: referenceBudget.reserved,
        records,
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
};
const persist = async (record) => {
  records.push(record);
  await store.update((s) => {
    s.evaluations ??= {};
    const list = (s.evaluations[record.model] ??= []);
    list.push(record);
    s.evaluations[record.model] = list.slice(-40);
  });
  await save();
  console.log(
    JSON.stringify({
      model: record.model,
      case: record.case,
      status: record.status,
      passed: record.passed,
      reason: record.reason,
    }),
  );
  return record;
};
async function trial(row, c) {
  const record = {
    model: row.model,
    case: c.id,
    method: c.id,
    domain: c.domain,
    complexity: c.complexity,
    checkedAt: new Date().toISOString(),
  };
  if (row.availability.status === "blocked")
    return persist({
      ...record,
      status: "unavailable",
      reason: row.availability.reason,
    });
  const rate = row.economics.apiReferencePrice;
  let reservation;
  if (!["free", "included"].includes(row.economics.billing)) {
    const tiers = [rate, ...(rate.contextTiers ?? []), rate.over200k].filter(
      Boolean,
    );
    if (
      !tiers.length ||
      tiers.some((t) => !Number.isFinite(t.input) || !Number.isFinite(t.output))
    )
      return persist({
        ...record,
        status: "unavailable",
        reason: "Unconfirmed metered reference rates",
      });
    const bound = Math.max(
      ...tiers.map((t) => (8192 * t.input + 1024 * t.output) / 1e6),
    );
    reservation = referenceBudget.reserve(bound);
    if (!reservation)
      return persist({
        ...record,
        status: "unavailable",
        reason: "Reference-price evaluation budget reached",
      });
  }
  let session;
  const started = Date.now();
  try {
    session = await api("/session", "POST", {
      title: "Quality Router evaluation: " + row.model + " " + c.id,
    });
    const m = catalog.get(row.model);
    const variant = ["minimal", "low"].find((v) => m.variants?.[v]);
    const response = await api(`/session/${session.id}/message`, "POST", {
      agent: "router-evaluation",
      model: { ...modelOf(row.model), ...(variant ? { variant } : {}) },
      parts: [{ type: "text", text: c.instruction }],
    });
    const text = (response.parts ?? [])
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join("\n");
    if (reservation) referenceBudget.settle(reservation, response.info?.cost);
    const error = response.info?.error;
    const synthetic =
      /^(Quota protection: All \d+ account|All \d+ account\(s\) rate-limited)/.test(
        text.trim(),
      );
    const trace = {
      model: row.model,
      case: c.id,
      variant,
      finish: response.info?.finish,
      cost: response.info?.cost,
      tokens: response.info?.tokens,
      parts: (response.parts ?? [])
        .filter((p) => ["text", "reasoning"].includes(p.type))
        .map((p) => ({ type: p.type, text: p.text })),
    };
    await writeFile(
      join(reportDir, row.model.replaceAll("/", "__") + "__" + c.id + ".json"),
      JSON.stringify(trace, null, 2) + "\n",
      { mode: 0o600 },
    );
    const common = {
      ...record,
      elapsedMs: Date.now() - started,
      variant,
      reportedUSD: response.info?.cost,
      tokens: response.info?.tokens,
    };
    if (error || synthetic) {
      const failure = synthetic ? "quota" : classifyError(error);
      if (failure)
        await store.update((s) => {
          s.blocks[row.model] = {
            reason: failure,
            until: Date.now() + config.failureCooldownMs,
            observedAt: Date.now(),
          };
        });
      return persist({
        ...common,
        status: "unavailable",
        reason: synthetic
          ? "Provider synthetic quota notice"
          : (classifyError(error) ?? "Native provider error"),
      });
    }
    if (response.info?.finish === "length" || !text.trim())
      return persist({
        ...common,
        status: "invalid",
        reason: "Output budget reached or no complete answer",
      });
    let passed = false;
    try {
      passed = c.verify(parseAnswer(text));
    } catch {}
    return persist({ ...common, status: "scored", passed });
  } catch {
    return persist({
      ...record,
      status: "invalid",
      reason: "Native API/timeout failure",
      elapsedMs: Date.now() - started,
    });
  } finally {
    if (session) {
      await api(`/session/${session.id}/abort`, "POST", undefined, 5000).catch(
        () => {},
      );
      await api(`/session/${session.id}`, "DELETE", undefined, 5000).catch(
        () => {},
      );
    }
  }
}
try {
  // Probe a low-cost metered row first, then retain every row even when quota or
  // budget prevents generation. Two workers avoid spiking provider rate limits.
  rows.sort((a, b) => {
    const weight = (r) =>
      r.model === "opencode/gpt-6-luna"
        ? -2
        : r.model === "openai/gpt-6.1-sol"
          ? -1
          : 0;
    return weight(a) - weight(b);
  });
  let index = 0;
  const worker = async () => {
    while (index < rows.length) {
      const row = rows[index++];
      let previous;
      for (const c of CASES) {
        if (previous?.status === "unavailable")
          previous = await persist({
            model: row.model,
            case: c.id,
            method: c.id,
            domain: c.domain,
            complexity: c.complexity,
            checkedAt: new Date().toISOString(),
            status: "unavailable",
            reason: previous.reason,
          });
        else previous = await trial(row, c);
      }
    }
  };
  await Promise.all([worker(), worker()]);
  await save();
  const counts = records.reduce(
    (a, r) => ((a[r.status] = (a[r.status] ?? 0) + 1), a),
    {},
  );
  console.log(
    JSON.stringify({
      complete: true,
      models: rows.length,
      counts,
      passed: records.filter((r) => r.passed).length,
      reservedReferenceUSD: referenceBudget.reserved,
      reportDir,
    }),
  );
} finally {
  host.kill("SIGTERM");
  if (host.exitCode === null && host.signalCode === null) {
    await Promise.race([
      new Promise((resolve) => host.once("exit", resolve)),
      new Promise((resolve) => setTimeout(resolve, 5000)),
    ]);
    if (host.exitCode === null && host.signalCode === null)
      host.kill("SIGKILL");
  }
}
