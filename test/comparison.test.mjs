import test from "node:test";
import assert from "node:assert/strict";
import {
  accessEvidence,
  requirementsFor,
  suitability,
  comparisonShortlist,
  validateComparison,
} from "../src/comparison.mjs";

function candidate(model, billing = "included", extra = {}) {
  return {
    model,
    availability: { status: "available" },
    catalog: { toolCalling: true, reasoning: true, contextTokens: 200000 },
    economics: { billing, apiReferencePrice: { input: 0, output: 0 } },
    assessment: { status: "unmeasured" },
    access: { status: "unconfirmed" },
    suitability: { status: "compatible" },
    ...extra,
  };
}
test("recent successful access expires and is not quota or task quality; a later failure invalidates it", () => {
  const state = { access: { "p/free": { lastSuccessAt: 1000 } } };
  assert.equal(
    accessEvidence(state, "p/free", 100, 1050).status,
    "recent_success",
  );
  assert.equal(
    accessEvidence(state, "p/free", 100, 1200).status,
    "unconfirmed",
  );
  state.access["p/free"].lastFailureAt = 1040;
  assert.equal(
    accessEvidence(state, "p/free", 100, 1050).status,
    "unconfirmed",
  );
  assert.match(
    accessEvidence(state, "p/free", 100, 1050).meaning,
    /not remaining quota or verified task quality/,
  );
  assert.equal(
    accessEvidence({}, "p/unknown", 100, 1050).status,
    "unconfirmed",
  );
});
test("declared requirements exclude known incompatibility but preserve explicit unknown capabilities", () => {
  const req = requirementsFor({ contextTokens: 300000, imageInput: true });
  assert.equal(suitability(candidate("p/a"), req).status, "incompatible");
  assert.deepEqual(suitability(candidate("p/a"), req).missing, [
    "contextTokens",
  ]);
  assert.equal(suitability({ catalog: {} }, req).status, "unknown");
  assert.deepEqual(
    requirementsFor({ reasoning: true, contextTokens: 10 }),
    requirementsFor({ contextTokens: 10, reasoning: true }),
  );
  assert.throws(() => requirementsFor({ contextTokens: -1 }));
});
test("task shortlist surfaces measured free alternatives and recent access without ranking by price or forcing winners", () => {
  const rows = Array.from({ length: 30 }, (_, i) => candidate("p/a" + i));
  rows.push(
    candidate("z/measured-free", "free", {
      assessment: { status: "measured", trials: 1, passRate: 1 },
      availability: { status: "unknown" },
    }),
  );
  rows.push(
    candidate("z/recent-free", "free", {
      access: { status: "recent_success" },
      availability: { status: "unknown" },
    }),
  );
  rows.push(
    candidate("z/blocked", "free", { availability: { status: "blocked" } }),
  );
  rows.push(
    candidate("z/too-small", "free", {
      suitability: { status: "incompatible" },
    }),
  );
  const shortlist = comparisonShortlist(rows);
  assert.equal(shortlist.length, 12);
  assert.ok(shortlist.some((c) => c.model === "z/measured-free"));
  assert.ok(shortlist.some((c) => c.model === "z/recent-free"));
  assert.ok(
    !shortlist.some((c) => ["z/blocked", "z/too-small"].includes(c.model)),
  );
  assert.deepEqual(
    shortlist.map((c) => c.model),
    shortlist.map((c) => c.model).sort((a, b) => a.localeCompare(b)),
  );
  assert.deepEqual(
    comparisonShortlist(rows),
    shortlist,
    "No randomness, rotation or selection history penalty",
  );
});
test("comparison rejects unseen fallbacks and absent alternatives, permits repeated winner and explicit rejection", () => {
  const a = candidate("p/a"),
    b = candidate("p/b");
  const consultation = {
    eligibleCount: 3,
    inspected: new Map([
      [a.model, a],
      [b.model, b],
    ]),
  };
  const row = (model) => ({
    model,
    fit: "suitable",
    reason: "Specific task fits context/tools; economics considered separately",
  });
  const args = {
    model: a.model,
    model_order: [],
    model_comparison: [row(a.model), row(b.model)],
  };
  assert.deepEqual(
    validateComparison(args, consultation),
    args.model_comparison,
  );
  assert.deepEqual(
    validateComparison(args, consultation),
    args.model_comparison,
    "Same winner remains valid",
  );
  assert.throws(
    () =>
      validateComparison(
        { ...args, model_comparison: [row(a.model)] },
        consultation,
      ),
    /alternative/,
  );
  assert.throws(
    () =>
      validateComparison({ ...args, model_order: ["p/unseen"] }, consultation),
    /inspected/,
  );
  assert.throws(
    () =>
      validateComparison(
        { ...args, model_comparison: [row(a.model), row("p/unseen")] },
        consultation,
      ),
    /distinct inspected/,
  );
  args.model_comparison[1].fit = "unsuitable";
  assert.doesNotThrow(() => validateComparison(args, consultation));
  assert.throws(
    () => validateComparison({ ...args, model_order: [b.model] }, consultation),
    /suitable/,
  );
  a.suitability.status = "incompatible";
  assert.throws(() => validateComparison(args, consultation), /requirements/);
});
test("a genuinely single eligible model needs no invented comparison partner", () => {
  const c = candidate("p/only");
  const context = { eligibleCount: 1, inspected: new Map([[c.model, c]]) };
  assert.doesNotThrow(() =>
    validateComparison(
      {
        model: c.model,
        model_order: [],
        model_comparison: [
          {
            model: c.model,
            fit: "suitable",
            reason: "Only eligible model meets required tool support",
          },
        ],
      },
      context,
    ),
  );
});

test("old failed access trials remain dated evidence without becoming a permanent quota block or quality grade", () => {
  const old = {
    evaluations: {
      "p/free": [
        {
          status: "unavailable",
          reason: "auth",
          checkedAt: "2026-10-09T12:00:00Z",
        },
      ],
    },
  };
  const now = Date.parse("2026-10-13T12:00:00Z");
  const access = accessEvidence(old, "p/free", 86400000, now);
  assert.equal(access.failureReason, "auth");
  assert.equal(access.status, "unconfirmed");
  assert.equal(access.lastFailureAt, "2026-10-09T12:00:00.000Z");
  old.access = { "p/free": { lastSuccessAt: now - 1000 } };
  assert.equal(
    accessEvidence(old, "p/free", 86400000, now).status,
    "recent_success",
  );
});
