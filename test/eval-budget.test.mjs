import test from "node:test";
import assert from "node:assert/strict";
import { ReferenceBudget } from "../evals/model-routing/budget.mjs";
test("concurrent evaluation attempts reserve budget before dispatch and settle once", () => {
  const b = new ReferenceBudget(1),
    first = b.reserve(0.6);
  assert.equal(b.reserve(0.5), undefined);
  b.settle(first, 0.1);
  b.settle(first, 0);
  assert.ok(Math.abs(b.reserved - 0.1) < 1e-9);
  assert.ok(b.reserve(0.5));
});
test("uncertain completion keeps the bound and unexpected larger cost stops further attempts", () => {
  const b = new ReferenceBudget(1),
    first = b.reserve(0.6);
  b.settle(first, undefined);
  assert.equal(b.reserve(0.5), undefined);
  const second = b.reserve(0.3);
  b.settle(second, 0.8);
  assert.equal(b.reserve(0), undefined);
  assert.throws(() => b.reserve(NaN));
  assert.throws(() => new ReferenceBudget(-1));
});
