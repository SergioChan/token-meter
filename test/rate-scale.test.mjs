import assert from "node:assert/strict";
import test from "node:test";
import { rateBandFromIntensity } from "../src/core/rate-scale.mjs";

test("rate intensity advances from green through yellow and orange to red", () => {
  assert.deepEqual(
    [-1, 0.49, 0.5, 0.69, 0.7, 0.84, 0.85, 2].map(
      rateBandFromIntensity,
    ),
    ["green", "green", "yellow", "yellow", "orange", "orange", "red", "red"],
  );
});
