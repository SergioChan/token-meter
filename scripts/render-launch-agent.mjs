#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import path from "node:path";

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--")) throw new Error(`Unexpected argument: ${key}`);
    const value = argv[++index];
    if (value == null) throw new Error(`Missing value for ${key}`);
    options[key.slice(2)] = value;
  }
  return options;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

const options = parseArguments(process.argv.slice(2));
const required = [
  "output",
  "label",
  "service",
  "root",
  "app-path",
  "port",
  "stdout",
  "stderr",
];
for (const key of required) {
  if (!options[key]) throw new Error(`--${key} is required`);
}
for (const key of ["output", "service", "root", "app-path", "stdout", "stderr"]) {
  if (!path.isAbsolute(options[key])) throw new Error(`--${key} must be absolute`);
  if (/[\0\r\n]/.test(options[key])) throw new Error(`--${key} contains invalid characters`);
}
if (!/^[a-z0-9.-]+$/i.test(options.label)) throw new Error("--label is invalid");
const port = Number(options.port);
if (!Number.isInteger(port) || port < 1024 || port > 65535) {
  throw new Error("--port must be between 1024 and 65535");
}

const argumentsList = [
  "/bin/bash",
  options.service,
  "--root",
  options.root,
  "--app-path",
  options["app-path"],
  "--port",
  String(port),
];
const argumentsXml = argumentsList
  .map((value) => `    <string>${xml(value)}</string>`)
  .join("\n");
const source = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xml(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
${argumentsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>ThrottleInterval</key>
  <integer>30</integer>
  <key>LimitLoadToSessionType</key>
  <string>Aqua</string>
  <key>StandardOutPath</key>
  <string>${xml(options.stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.stderr)}</string>
</dict>
</plist>
`;

await writeFile(options.output, source, { mode: 0o600 });
