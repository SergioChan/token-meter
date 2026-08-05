import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ClaudeDesktopSessionStore,
  parseClaudeDesktopSession,
} from "../src/claude/desktop-session-store.mjs";

const desktopSessionId = "local_00000000-0000-4000-8000-000000000001";
const cliSessionId = "00000000-0000-4000-8000-000000000002";

function metadata(overrides = {}) {
  return {
    sessionId: desktopSessionId,
    cliSessionId,
    cwd: "/private/repository",
    createdAt: 100,
    lastActivityAt: 200,
    lastFocusedAt: 300,
    model: "claude-test",
    effort: "high",
    title: "private session title",
    summary: "private session summary",
    ...overrides,
  };
}

test("Claude Desktop metadata parser retains identity and timing only", () => {
  const parsed = parseClaudeDesktopSession(JSON.stringify(metadata()));

  assert.deepEqual(parsed, {
    desktopSessionId,
    cliSessionId,
    cwd: "/private/repository",
    createdAtMs: 100,
    lastActivityAtMs: 200,
    lastFocusedAtMs: 300,
    model: "claude-test",
    effort: "high",
  });
  assert.equal(JSON.stringify(parsed).includes("private session title"), false);
  assert.equal(JSON.stringify(parsed).includes("private session summary"), false);
});

test("Claude Desktop metadata parser rejects unsafe identity fields", () => {
  assert.equal(parseClaudeDesktopSession("not json"), null);
  assert.equal(
    parseClaudeDesktopSession(metadata({ sessionId: "local_latest" })),
    null,
  );
  assert.equal(
    parseClaudeDesktopSession(metadata({ cliSessionId: "../transcript" })),
    null,
  );
  assert.equal(parseClaudeDesktopSession(metadata({ cwd: "relative" })), null);
});

test("session store resolves one exact Desktop session and never substitutes another", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-claude-meta-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const accountDirectory = path.join(directory, "account", "workspace");
  await mkdir(accountDirectory, { recursive: true });
  await Promise.all([
    writeFile(
      path.join(accountDirectory, `${desktopSessionId}.json`),
      JSON.stringify(metadata()),
    ),
    writeFile(
      path.join(
        accountDirectory,
        "local_00000000-0000-4000-8000-000000000003.json",
      ),
      JSON.stringify(
        metadata({
          sessionId: "local_00000000-0000-4000-8000-000000000003",
          cliSessionId: "00000000-0000-4000-8000-000000000004",
        }),
      ),
    ),
  ]);

  const store = new ClaudeDesktopSessionStore({ sessionsDirectory: directory });
  const resolved = await store.resolve(desktopSessionId);
  assert.equal(resolved.status, "resolved");
  assert.equal(resolved.cliSessionId, cliSessionId);

  const missing = await store.resolve(
    "local_00000000-0000-4000-8000-000000000099",
  );
  assert.deepEqual(missing, {
    status: "unbound",
    desktopSessionId: "local_00000000-0000-4000-8000-000000000099",
    reason: "session-metadata-not-found",
  });
});

test("session store fails closed when a Desktop identity is ambiguous", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-claude-ambiguous-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(
    ["account-a/workspace", "account-b/workspace"].map(async (relative) => {
      const target = path.join(directory, relative);
      await mkdir(target, { recursive: true });
      await writeFile(
        path.join(target, `${desktopSessionId}.json`),
        JSON.stringify(metadata()),
      );
    }),
  );

  const store = new ClaudeDesktopSessionStore({ sessionsDirectory: directory });
  const result = await store.resolve(desktopSessionId);
  assert.deepEqual(result, {
    status: "unbound",
    desktopSessionId,
    reason: "ambiguous-session-metadata",
  });
});

test("the preferred exact metadata survives a bounded history index", async (context) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "token-meter-claude-limit-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(
    Array.from({ length: 5 }, async (_, index) => {
      const id = `local_00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      await writeFile(
        path.join(directory, `${id}.json`),
        JSON.stringify(
          metadata({
            sessionId: id,
            cliSessionId: `00000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
          }),
        ),
      );
    }),
  );
  await writeFile(
    path.join(directory, `${desktopSessionId}.json`),
    JSON.stringify(metadata()),
  );

  const store = new ClaudeDesktopSessionStore({
    sessionsDirectory: directory,
    metadataFileLimit: 1,
  });
  const result = await store.resolve(desktopSessionId);
  assert.equal(result.status, "resolved");
  assert.equal(result.cliSessionId, cliSessionId);
});
