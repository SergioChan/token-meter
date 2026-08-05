import assert from "node:assert/strict";
import test from "node:test";
import {
  mean,
  median,
  medianAbsoluteDeviation,
  percentile,
} from "../src/core/statistics.mjs";

test("statistics produce stable historical baselines", () => {
  assert.equal(median([9, 1, 5, 3]), 4);
  assert.equal(mean([2, 4, 6]), 4);
  assert.equal(medianAbsoluteDeviation([1, 2, 3, 100]), 1);
  assert.equal(percentile([0, 10, 20], 0.95), 19);
});

