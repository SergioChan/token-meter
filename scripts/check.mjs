import { readdir } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

async function collect(directory, result = []) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) await collect(target, result);
    else if (/\.(?:mjs|js)$/.test(entry.name)) result.push(target);
  }
  return result;
}

const files = [
  ...(await collect("src")),
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
const shellFiles = (await readdir("scripts"))
  .filter((file) => file.endsWith(".sh"))
  .map((file) => path.join("scripts", file));
for (const file of shellFiles) {
  const result = spawnSync("/bin/bash", ["-n", file], { encoding: "utf8" });
  if (result.status !== 0) {
    process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
}
process.stdout.write(
  `Checked ${files.length} JavaScript files and ${shellFiles.length} shell files.\n`,
);
