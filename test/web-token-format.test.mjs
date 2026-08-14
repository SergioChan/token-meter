import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

const pages = ["dashboard.html", "leaderboard.html", "profile.html"];

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} is missing`);
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`${name} is incomplete`);
}

const cases = [
  [999, "999"],
  [1_000, "1K"],
  [1_500, "1.5K"],
  [1_000_000, "1M"],
  [168_846_100, "168.8M"],
  [1_000_000_000, "1B"],
  [168_846_100_000, "168.8B"],
  [1_000_000_000_000, "1T"],
  [1_250_000_000_000, "1.3T"],
];

for (const page of pages) {
  test(`${page} formats token counts with K, M, B, and T magnitudes`, async () => {
    const source = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    const formatter = vm.runInNewContext(
      `(${extractFunction(source, "formatTokenCount")})`,
    );
    for (const [input, expected] of cases) {
      assert.equal(formatter(input), expected, String(input));
    }
  });
}
