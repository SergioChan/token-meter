import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function collect(directory, result = [], pattern = /\.(?:mjs|js)$/) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target, result, pattern);
    else if (pattern.test(entry.name)) result.push(target);
  }
  return result;
}

const files = [
  ...(await collect("src")),
  ...(await collect("integrations")),
  ...(await collect("runtime")),
  ...(await collect("scripts")),
  ...(await collect("test")),
];
for (const file of files) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
const shellFiles = [
  ...(await collect("scripts", [], /\.sh$/)),
  ...(await collect("integrations", [], /\.sh$/)),
];
for (const file of shellFiles) {
  const result = spawnSync("/bin/bash", ["-n", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}

const requiredPublicFiles = [
  "README.md",
  "LICENSE",
  "CONTRIBUTING.md",
  "SECURITY.md",
  "CODE_OF_CONDUCT.md",
  "CHANGELOG.md",
];
await Promise.all(requiredPublicFiles.map((file) => access(file)));

async function collectMarkdown(directory = ".", result = []) {
  const ignored = new Set([".git", "coverage", "dist", "node_modules"]);
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectMarkdown(target, result);
    else if (entry.name.endsWith(".md")) result.push(target);
  }
  return result;
}

function markdownAnchors(source) {
  const anchors = new Set();
  const occurrences = new Map();
  for (const line of source.split("\n")) {
    const heading = line.match(/^#{1,6}\s+(.+?)\s*#*\s*$/)?.[1];
    if (!heading) continue;
    const base = heading
      .replace(/<[^>]+>/g, "")
      .replace(/[`*_~]/g, "")
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .trim()
      .replace(/\s+/g, "-");
    const count = occurrences.get(base) ?? 0;
    occurrences.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

const markdownFiles = await collectMarkdown();
const markdownCache = new Map();
for (const markdownFile of markdownFiles) {
  const source = await readFile(markdownFile, "utf8");
  markdownCache.set(path.resolve(markdownFile), source);
  const hrefs = [
    ...[...source.matchAll(/!?\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1]),
    ...[...source.matchAll(/<img\s+[^>]*src="([^"]+)"/g)].map((match) => match[1]),
  ];
  for (const rawHref of hrefs) {
    if (/^(?:https?:|mailto:)/i.test(rawHref)) continue;
    const [rawTarget, rawFragment] = rawHref.split("#", 2);
    const targetPath = rawTarget
      ? path.resolve(path.dirname(markdownFile), decodeURIComponent(rawTarget))
      : path.resolve(markdownFile);
    await access(targetPath);
    if (!rawFragment || path.extname(targetPath).toLowerCase() !== ".md") continue;
    const targetSource =
      markdownCache.get(targetPath) ?? (await readFile(targetPath, "utf8"));
    markdownCache.set(targetPath, targetSource);
    const fragment = decodeURIComponent(rawFragment).toLowerCase();
    if (!markdownAnchors(targetSource).has(fragment)) {
      throw new Error(
        `Broken Markdown anchor in ${markdownFile}: ${rawHref}`,
      );
    }
  }
}

process.stdout.write(
  `Checked ${files.length} JavaScript files, ${shellFiles.length} shell files, and ${markdownFiles.length} Markdown files.\n`,
);
