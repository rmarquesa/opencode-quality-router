import test from "node:test";
import assert from "node:assert/strict";
import { CASES, parseAnswer } from "../evals/model-routing/cases.mjs";
test("smoke verifiers accept explicit outcomes and reject plausible wrong, shortcut and corrupt results", () => {
  assert.ok(
    CASES[0].verify(parseAnswer('```json\n{"ids":["b","a","c","d"]}\n```')),
  );
  assert.ok(!CASES[0].verify({ ids: ["a", "b", "c", "d"] }));
  assert.ok(
    CASES[1].verify({
      blocked: ["D", "E", "F", "G"],
      order: ["A", "B", "C", "H"],
    }),
  );
  assert.ok(
    !CASES[1].verify({ order: ["A", "B", "C", "D", "H"], blocked: ["F", "G"] }),
  );
  assert.ok(!CASES[1].verify({ passed: true }));
  assert.throws(() => parseAnswer("DONE"));
});
