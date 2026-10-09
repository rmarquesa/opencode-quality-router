import test from "node:test";
import assert from "node:assert/strict";
import { CASES, parseAnswer } from "../evals/model-routing/cases.mjs";
import { evaluationRequest } from "../evals/model-routing/request.mjs";
test("evaluation variant uses the native prompt field rather than the ignored nested model field", () => {
  const request = evaluationRequest("openai/example", "low", "Return JSON");
  assert.equal(request.variant, "low");
  assert.deepEqual(request.model, { providerID: "openai", modelID: "example" });
  assert.equal(
    evaluationRequest("openai/example", undefined, "Return JSON").variant,
    undefined,
  );
});
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
