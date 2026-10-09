import test from "node:test";
import assert from "node:assert/strict";
import {
  availability,
  selectCandidate,
  candidatesFor,
  validateConfig,
  classifyError,
} from "../src/routing.mjs";
const now = Date.parse("2026-10-09T12:00:00Z");
const resetAt = "2026-10-17T12:00:00Z";
const observation = (windows) => ({ checkedAt: now, windows });
const status = (model, windows, extra = {}) =>
  availability(
    { model, ...extra },
    observation(windows),
    undefined,
    now,
    60000,
  );
test("Go monthly exhaustion dominates available shorter windows", () => {
  const r = status("opencode-go/a", [
    { group: "weekly", status: "available", remainingPercent: 39 },
    { group: "monthly", status: "exhausted", resetAt },
  ]);
  assert.equal(r.status, "blocked");
  assert.equal(r.retryAt, new Date(resetAt).toISOString());
});
test("Google uses any available account in the selected group only", () => {
  const w = [
    { account: 1, group: "gemini", status: "available" },
    { account: 1, group: "non-gemini", status: "exhausted", resetAt },
    { account: 2, group: "non-gemini", status: "exhausted", resetAt },
  ];
  assert.equal(status("google/antigravity-gemini-pro", w).status, "available");
  assert.equal(status("google/antigravity-claude-opus", w).status, "blocked");
  w.push({ account: 3, group: "non-gemini", status: "available" });
  assert.equal(status("google/antigravity-claude-opus", w).status, "available");
});
test("Google group unavailability with unknown account is not falsely global", () => {
  assert.equal(
    status("google/claude", [
      { account: 1, group: "non-gemini", status: "exhausted", resetAt },
      { account: 2, group: "non-gemini", status: "unknown" },
    ]).status,
    "unknown",
  );
});
test("Copilot REST limits are not model limits and premium is the conservative default", () => {
  const w = [
    { group: "premium", status: "exhausted", resetAt },
    { group: "chat", status: "available", unlimited: true },
  ];
  assert.equal(status("github-copilot/a", w).status, "blocked");
  assert.equal(
    status("github-copilot/b", w, { billingGroup: "chat" }).status,
    "available",
  );
});
test("OpenAI model availability cannot override exhausted account window", () => {
  assert.equal(
    status("openai/a", [
      { group: "weekly", status: "exhausted", resetAt },
      { group: "model", model: "a", status: "available" },
    ]).status,
    "blocked",
  );
});
test("reset date in the past requires rechecking", () => {
  assert.equal(
    status("opencode-go/a", [
      { status: "exhausted", resetAt: "2026-10-01T00:00:00Z" },
    ]).status,
    "unknown",
  );
});
test("expired quota does not claim availability", () => {
  assert.equal(
    availability(
      { model: "x/a" },
      { checkedAt: now - 60001, windows: [{ status: "available" }] },
      undefined,
      now,
      60000,
    ).status,
    "unknown",
  );
});
test("failed refresh retains a known exhausted window until its future reset", () => {
  const result = availability(
    { model: "opencode-go/a" },
    {
      checkedAt: now - 70000,
      error: "Network error",
      windows: [{ status: "exhausted", resetAt }],
    },
    undefined,
    now,
    60000,
  );
  assert.equal(result.status, "blocked");
});
test("Google exhaustion without reset blocks until the next fresh observation", () => {
  assert.equal(
    status("google/claude", [
      { account: 1, group: "non-gemini", status: "exhausted" },
    ]).status,
    "blocked",
  );
});
test("quality preference is not quota percentage or price", () => {
  const c = [
    { model: "a", availability: { status: "unknown" } },
    {
      model: "b",
      availability: { status: "available", remainingPercent: 100 },
    },
  ];
  assert.equal(selectCandidate(c).model, "a");
  assert.equal(selectCandidate(c, "b").model, "b");
  assert.equal(selectCandidate(c, undefined, new Set(), false).model, "b");
});
test("blocked and attempted models are excluded", () => {
  const c = [
    { model: "a", availability: { status: "blocked" } },
    { model: "b", availability: { status: "available" } },
    { model: "c", availability: { status: "unknown" } },
  ];
  assert.equal(selectCandidate(c, "a", new Set(["b"])).model, "c");
});
test("catalog membership does not imply quota", () => {
  const config = validateConfig({
    agents: { build: { candidates: [{ model: "x/a" }, { model: "x/b" }] } },
  });
  const c = candidatesFor(
    config,
    "build",
    new Set(["x/a"]),
    { observations: {}, blocks: {} },
    now,
  );
  assert.equal(c.length, 1);
  assert.equal(c[0].availability.status, "unknown");
});
test("configuration rejects ambiguous candidate sets and invalid times", () => {
  assert.throws(
    () =>
      validateConfig({
        agents: { x: { candidates: [{ model: "x/a" }, { model: "x/a" }] } },
      }),
    /Duplicate/,
  );
  assert.throws(
    () =>
      validateConfig({
        quotaTtlMs: -1,
        agents: { x: { candidates: [{ model: "x/a" }] } },
      }),
    /quotaTtlMs/,
  );
});
test("safety, context, schema and cancellation errors do not switch providers", () => {
  for (const message of [
    "Blocked by safety policy",
    "Maximum context length exceeded",
    "Invalid schema",
    "User canceled",
  ])
    assert.equal(
      classifyError({ data: { statusCode: 400, message } }),
      undefined,
    );
  assert.equal(classifyError({ name: "MessageAbortedError" }), undefined);
  assert.equal(
    classifyError({ data: { statusCode: 429, message: "Quota exhausted" } }),
    "quota",
  );
  assert.equal(classifyError({ data: { statusCode: 401 } }), "auth");
});
