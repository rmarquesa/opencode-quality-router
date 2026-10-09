import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { classifyError, failureBlock } from "../src/errors.mjs";
import {
  availability,
  candidatesFor,
  validateConfig,
} from "../src/routing.mjs";
const api = (statusCode, message) => ({
  name: "APIError",
  data: { statusCode, message },
});
const config = () =>
  validateConfig({
    agents: { x: { candidates: [{ model: "p/a" }, { model: "p/b" }] } },
  });
test("observed unsupported tier and retired model errors are provider failures; unrelated 400 errors remain terminal", () => {
  assert.equal(
    classifyError(
      api(400, 'Bad Request: {"detail":"Unsupported service_tier: flex"}'),
    ),
    "incompatible",
  );
  assert.equal(
    classifyError(api(410, "Model exo-free has been deprecated.")),
    "retired",
  );
  assert.equal(classifyError(api(410, "Endpoint is gone")), "unavailable");
  for (const e of [
    api(400, "Invalid tool schema"),
    api(400, "Invalid input"),
    api(403, "Blocked by safety policy"),
    { name: "MessageAbortedError", data: { message: "Aborted" } },
  ])
    assert.equal(classifyError(e), undefined);
});
test("retirement survives cooldown expiration, while incompatible account tiers can be retried after 24h", () => {
  const cfg = config(),
    now = 1000;
  const retired = failureBlock(
    cfg,
    api(410, "Model exo-free has been deprecated."),
    now,
  );
  const incompatible = failureBlock(
    cfg,
    api(400, "Unsupported service_tier: flex"),
    now,
  );
  assert.equal(retired.permanent, true);
  assert.equal(
    availability(
      { model: "p/a" },
      undefined,
      retired,
      now + 2 * 365 * 86400000,
      60000,
    ).status,
    "blocked",
  );
  assert.equal(
    availability({ model: "p/a" }, undefined, retired, now, 60000).retryAt,
    undefined,
  );
  assert.equal(incompatible.until, now + 86400000);
  assert.equal(
    availability(
      { model: "p/a" },
      undefined,
      incompatible,
      now + 86400000,
      60000,
    ).status,
    "unknown",
  );
  assert.throws(() =>
    validateConfig({ ...config(), compatibilityCooldownMs: -1 }),
  );
});
test("native deprecated catalog entries are blocked even with available provider quota", () => {
  const rows = candidatesFor(
    config(),
    "x",
    new Map([
      ["p/a", { status: "deprecated" }],
      ["p/b", { status: "active" }],
    ]),
    {
      observations: {
        p: { checkedAt: 1000, windows: [{ status: "available" }] },
      },
      blocks: {},
    },
    1000,
  );
  assert.equal(rows[0].availability.status, "blocked");
  assert.equal(rows[1].availability.status, "available");
});
test("operator unblocking clears only the named model and leaves quotas and other model blocks intact", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "quality-unblock-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const statePath = join(dir, "state.json"),
    configPath = join(dir, "config.json");
  await writeFile(configPath, JSON.stringify({ ...config(), statePath }));
  const original = {
    version: 1,
    observations: {
      p: { checkedAt: 1000, windows: [{ status: "exhausted" }] },
    },
    blocks: { "p/a": { permanent: true }, "p/b": { until: 9999999999999 } },
  };
  await writeFile(statePath, JSON.stringify(original));
  const run = promisify(execFile);
  const { stdout } = await run(process.execPath, [
    "src/cli.mjs",
    "unblock",
    "--config",
    configPath,
    "--model",
    "p/a",
  ]);
  assert.equal(JSON.parse(stdout).blockCleared, true);
  const state = JSON.parse(await readFile(statePath));
  assert.equal(state.blocks["p/a"], undefined);
  assert.deepEqual(state.blocks["p/b"], original.blocks["p/b"]);
  assert.deepEqual(state.observations, original.observations);
  await assert.rejects(() =>
    run(process.execPath, ["src/cli.mjs", "unblock", "--config", configPath]),
  );
});
