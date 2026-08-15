import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";

// Both surfaces build identical share targets; the install link must ride
// along so every share doubles as an invitation.
const pages = ["dashboard.html", "profile.html"];

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

for (const page of pages) {
  test(`${page} share links target X and LinkedIn and carry the install link`, async () => {
    const source = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    const build = vm.runInNewContext(`(${extractFunction(source, "buildShareLinks")})`);
    const links = build("chandler", "1.9B");

    assert.equal(links.url, "https://www.tokenwidget.app/u/chandler");
    const x = new URL(links.x);
    assert.equal(x.origin + x.pathname, "https://twitter.com/intent/tweet");
    assert.equal(x.searchParams.get("url"), links.url);
    assert.match(x.searchParams.get("text"), /1\.9B lifetime tokens/);
    assert.match(x.searchParams.get("text"), /tokenwidget\.app/); // the invitation
    const linkedin = new URL(links.linkedin);
    assert.equal(linkedin.origin + linkedin.pathname, "https://www.linkedin.com/sharing/share-offsite/");
    assert.equal(linkedin.searchParams.get("url"), links.url);

    // Handles are URL-encoded, never string-interpolated raw.
    assert.equal(
      build("we?ird", "1").url,
      "https://www.tokenwidget.app/u/we%3Fird",
    );
  });

  test(`${page} ships the share card renderer with the baked-in install invite`, async () => {
    const source = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    const card = extractFunction(source, "drawShareCard");
    assert.match(card, /1200/);
    assert.match(card, /Get your own widget → tokenwidget\.app/);
  });
}

test("index.html and profile.html carry social preview tags", async () => {
  for (const page of ["index.html", "profile.html"]) {
    const source = await readFile(new URL(`../web/${page}`, import.meta.url), "utf8");
    assert.match(source, /property="og:title"/, page);
    assert.match(source, /property="og:image" content="https:\/\/www\.tokenwidget\.app\/assets\//, page);
    assert.match(source, /name="twitter:card" content="summary_large_image"/, page);
  }
});
