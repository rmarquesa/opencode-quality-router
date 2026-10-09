import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { StateStore } from "../src/store.mjs";
import {
  normalizeGo,
  normalizeAntigravity,
  normalizeCopilot,
  normalizeOpenAI,
  QuotaService,
} from "../src/quotas.mjs";
test("Go contract contains independent windows and reset dates", () => {
  const w = { status: "ok", percent: 61, resetsAt: "2026-10-12T00:00:00Z" };
  const r = normalizeGo({
    usage: {
      rolling: w,
      weekly: w,
      monthly: { ...w, status: "rate-limited", percent: 100 },
    },
  });
  assert.equal(r[1].remainingPercent, 39);
  assert.equal(r[2].status, "exhausted");
  assert.throws(
    () => normalizeGo({ usage: { rolling: { ...w, resetsAt: "nonsense" } } }),
    /contract/,
  );
});
test("Antigravity normalization contains no emails or tokens and retains failed accounts", () => {
  const r = normalizeAntigravity({
    accounts: [
      {
        email: "private@example.test",
        status: "ok",
        groups: [
          {
            name: "gemini",
            remainingPercent: 18,
            resetTime: "2026-10-15T00:00:00Z",
          },
        ],
      },
      { status: "error", error: "secret" },
    ],
  });
  assert.equal(r.length, 3);
  assert.ok(!JSON.stringify(r).includes("private"));
  assert.ok(!JSON.stringify(r).includes("secret"));
  assert.equal(r[1].status, "unknown");
});
test("Copilot unlimited zero remaining is not exhausted", () => {
  const r = normalizeCopilot({
    quota_reset_date_utc: "2026-11-01T00:00:00Z",
    quota_snapshots: {
      chat: { unlimited: true, remaining: 0 },
      premium_interactions: {
        unlimited: false,
        has_quota: false,
        percent_remaining: 0,
      },
    },
  });
  assert.equal(r[0].status, "available");
  assert.equal(r[1].group, "premium");
  assert.equal(r[1].status, "exhausted");
});
test("OpenAI retains per-model blocks without identity and credit balance", () => {
  const r = normalizeOpenAI({
    user_id: "private",
    credits: { balance: "secret" },
    rate_limit: { primary_window: { used_percent: 96, reset_at: 1791953468 } },
    model_usage: {
      a: { available: false, available_at: "2026-10-14T00:00:00Z" },
    },
  });
  assert.equal(r[0].remainingPercent, 4);
  assert.equal(r[1].status, "exhausted");
  assert.ok(!JSON.stringify(r).includes("private"));
});
test("state persists and concurrent writers merge rather than lose updates", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "quality-state-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, "state.json");
  const stores = [new StateStore(path), new StateStore(path)];
  await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      stores[i % 2].update((s) => {
        s.blocks["m" + i] = { until: i };
      }),
    ),
  );
  assert.equal(Object.keys((await stores[0].read()).blocks).length, 12);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
});
test("concurrent quota refresh is deduplicated and errors cannot leak credentials", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "quality-quota-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authPath = join(dir, "auth.json");
  await writeFile(
    authPath,
    JSON.stringify({ "opencode-go": { key: "never-print-me" } }),
  );
  let calls = 0;
  const service = new QuotaService(
    {
      authPath,
      quotaTtlMs: 60000,
      quota: { "opencode-go": { enabled: true } },
    },
    new StateStore(join(dir, "state.json")),
    {
      fetchImpl: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 10));
        throw Error("never-print-me");
      },
    },
  );
  await Promise.all([
    service.refresh("opencode-go"),
    service.refresh("opencode-go"),
  ]);
  assert.equal(calls, 1);
  assert.ok(
    !(await readFile(join(dir, "state.json"), "utf8")).includes(
      "never-print-me",
    ),
  );
  await service.refresh("opencode-go");
  assert.equal(calls, 1);
});
test("a reset reached inside the cache TTL triggers a quota query", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "quality-reset-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new StateStore(join(dir, "state.json"));
  const now = Date.now();
  await store.update((s) => {
    s.observations.google = {
      checkedAt: now - 1000,
      windows: [
        {
          status: "exhausted",
          group: "gemini",
          account: 1,
          resetAt: new Date(now - 500).toISOString(),
        },
      ],
    };
  });
  let calls = 0;
  const service = new QuotaService(
    {
      quotaTtlMs: 60000,
      quota: { google: { enabled: true, command: ["synthetic"] } },
    },
    store,
    {
      clock: () => now,
      runCommand: async () => {
        calls++;
        return {
          stdout: JSON.stringify({
            accounts: [
              {
                status: "ok",
                groups: [{ name: "gemini", remainingPercent: 100 }],
              },
            ],
          }),
        };
      },
    },
  );
  const result = await service.refresh("google");
  assert.equal(calls, 1);
  assert.equal(result.windows[0].remainingPercent, 100);
});
