import test from "node:test";
import assert from "node:assert/strict";
import {
  matrixRows,
  capabilityEvidence,
  validateAssessment,
} from "../src/matrix.mjs";
test("matrix blocks a free promotion that now has paid catalog rates", () => {
  const [row] = matrixRows(
    {
      agents: {
        x: { candidates: [{ model: "a/one", economics: { billing: "free" } }] },
      },
      quotaTtlMs: 60000,
    },
    new Map([["a/one", { cost: { input: 1, output: 2 } }]]),
    { observations: {}, blocks: {} },
  );
  assert.equal(row.economics.billing, "unknown");
  assert.equal(row.availability.status, "blocked");
});
test("matrix includes every provider/model and does not invent unmeasured ability", () => {
  const rows = matrixRows(
    { agents: { x: { candidates: [{ model: "a/one" }] } }, quotaTtlMs: 60000 },
    new Map([
      ["a/one", {}],
      ["b/two", {}],
    ]),
    { observations: {}, blocks: {} },
  );
  assert.equal(rows.length, 2);
  assert.equal(rows[1].selectable, false);
  assert.equal(rows[0].capabilities.frontend.complex.status, "unmeasured");
  assert.equal(rows[0].capabilities.frontend.complex.passRate, undefined);
});
test("capability evidence stays in its domain, complexity and provider; quota failures are not zero grades", () => {
  const state = {
    evaluations: {
      "a/one": [
        {
          domain: "analysis",
          complexity: "simple",
          status: "scored",
          passed: true,
          method: "case-v1",
        },
        { domain: "analysis", complexity: "simple", status: "unavailable" },
      ],
    },
  };
  assert.equal(
    capabilityEvidence(state, "a/one", "analysis", "simple").passRate,
    1,
  );
  assert.equal(
    capabilityEvidence(state, "a/one", "analysis", "simple").trials,
    1,
  );
  assert.equal(
    capabilityEvidence(state, "a/one", "analysis", "simple").unavailableTrials,
    1,
  );
  assert.equal(
    capabilityEvidence(state, "a/one", "analysis", "complex").status,
    "unmeasured",
  );
  assert.equal(
    capabilityEvidence(state, "b/one", "analysis", "simple").status,
    "unmeasured",
  );
  assert.throws(() => validateAssessment("frontend", "largest"), /Classify/);
});
