import { afterEach, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPiSessions } from "./pi.ts";
import { closeStateDb, getPendingMetricPoints, ingestUsageEvents, openStateDb } from "./state.ts";
import type { PiFileCursor } from "./types.ts";

const directories: string[] = [];

function tempDir(): string {
  const path = mkdtempSync(join(tmpdir(), "harness-pi-test-"));
  directories.push(path);
  return path;
}

function sessionHeader(id: string, timestamp: string, parentSession?: string): string {
  return JSON.stringify({
    type: "session", version: 3, id, timestamp,
    cwd: "/project", ...(parentSession ? { parentSession } : {}),
  });
}

function cursorsFrom(batches: ReturnType<typeof scanPiSessions>): ReadonlyMap<string, PiFileCursor> {
  return new Map(batches.map((batch) => [batch.cursor.fileKey, batch.cursor]));
}

afterEach(() => {
  closeStateDb();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test("imports assistant, nested-tool, auxiliary and compaction usage with safe attribution", () => {
  const root = tempDir();
  const directory = join(root, "--project--");
  mkdirSync(directory);
  const file = join(directory, "2025-01-01T00-00-00-000Z_session-1.jsonl");
  const header = sessionHeader("session-1", "2025-01-01T00:00:00.000Z");
  const entries = [
    {
      type: "message", id: "assistant-1", parentId: null, timestamp: "2025-01-01T00:00:01.000Z",
      message: { role: "assistant", provider: "anthropic", model: "claude-sonnet-4-6", timestamp: 1_735_689_601_000,
        usage: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, cacheWrite1h: 10, reasoning: 5,
          cost: { input: 0.1, output: 0.2, cacheRead: 0.03, cacheWrite: 0.04, total: 0.37 } },
        stopReason: "stop" },
    },
    {
      type: "message", id: "tool-1", parentId: "assistant-1", timestamp: "2025-01-01T00:00:02.000Z",
      message: { role: "toolResult", timestamp: 1_735_689_602_000, usage: {
        input: 2, output: 3, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 },
      } },
    },
    {
      type: "usage", id: "cache-1", parentId: "tool-1", timestamp: "2025-01-01T00:00:03.000Z",
      kind: "cache_warm", provider: "openai", model: "gpt-4.1", usage: {
        input: 0, output: 0, cacheRead: 50, cacheWrite: 0, cost: { total: 0 },
      },
    },
    {
      type: "compaction", id: "compact-1", parentId: "cache-1", timestamp: "2025-01-01T00:00:04.000Z",
      summary: "compacted", usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } },
    },
    {
      type: "branch_summary", id: "branch-1", parentId: "compact-1", timestamp: "2025-01-01T00:00:05.000Z",
      summary: "branch", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
    },
    {
      type: "message", id: "user-1", parentId: "branch-1", timestamp: "2025-01-01T00:00:06.000Z",
      message: { role: "user", timestamp: 1_735_689_606_000 },
    },
    {
      type: "message", id: "empty-1", parentId: "user-1", timestamp: "2025-01-01T00:00:07.000Z",
      message: { role: "assistant", provider: "anthropic", model: "model", timestamp: 1_735_689_607_000,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" },
    },
    {
      type: "message", id: "pending-1", parentId: "empty-1", timestamp: "2025-01-01T00:00:08.000Z",
      message: { role: "assistant", provider: "anthropic", model: "model", timestamp: 1_735_689_608_000,
        usage: { input: 10, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "pending" },
    },
  ];
  writeFileSync(file, `${header}\n${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

  const batches = scanPiSessions(root, new Map());
  const events = batches.flatMap((batch) => batch.events);
  expect(events).toHaveLength(5);
  expect(events[0]).toMatchObject({
    harness: "pi", provider: "anthropic", model: "claude-sonnet-4-6",
    tokens: { input: 10, output: 20, cache_read: 30, cache_write: 40 }, costUsd: 0.37,
  });
  expect(events.find((event) => event.provider === "openai")).toMatchObject({ model: "gpt-4-1", tokens: { cache_read: 50 } });
  const unattributed = events.filter((event) => event.provider === "unknown" && event.model === "unknown");
  expect(unattributed).toHaveLength(3);
  expect(events.find((event) => event.eventId === events[0]?.eventId)?.sessionKey).toBe("pi:session-1");
});

test("deduplicates copied fork history and attributes new fork work to the child session", () => {
  const root = tempDir();
  const directory = join(root, "--project--");
  mkdirSync(directory);
  const parentPath = join(directory, "2025-01-01T00-00-00-000Z_parent.jsonl");
  const childPath = join(directory, "2025-01-03T00-00-00-000Z_child.jsonl");
  const sharedEntry = {
    type: "message", id: "same-entry", parentId: null, timestamp: "2025-01-02T00:00:00.000Z",
    message: { role: "assistant", provider: "anthropic", model: "claude-test", timestamp: 1_735_776_000_000,
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } }, stopReason: "stop" },
  };
  const childCopy = { ...sharedEntry, parentId: "different-parent" };
  const childWork = {
    type: "message", id: "child-entry", parentId: "same-entry", timestamp: "2025-01-04T00:00:00.000Z",
    message: { role: "assistant", provider: "anthropic", model: "claude-test", timestamp: 1_735_948_800_000,
      usage: { input: 4, output: 2, cacheRead: 0, cacheWrite: 0, cost: { total: 0.06 } }, stopReason: "stop" },
  };
  writeFileSync(parentPath, `${sessionHeader("parent", "2025-01-01T00:00:00.000Z")}\n${JSON.stringify(sharedEntry)}\n`);
  writeFileSync(childPath, `${sessionHeader("child", "2025-01-03T00:00:00.000Z", parentPath)}\n${JSON.stringify(childCopy)}\n${JSON.stringify(childWork)}\n`);

  const events = scanPiSessions(root, new Map()).flatMap((batch) => batch.events);
  const shared = events.filter((event) => event.eventId === events[0]?.eventId);
  expect(events).toHaveLength(3);
  expect(shared).toHaveLength(2);
  expect(shared.map((event) => event.sessionKey)).toEqual(["pi:parent", "pi:parent"]);
  expect(events.find((event) => event.eventId !== shared[0]?.eventId)?.sessionKey).toBe("pi:child");

  openStateDb(":memory:");
  expect(ingestUsageEvents(events)).toMatchObject({ inserted: 2, duplicates: 1 });
  const sessionPoints = getPendingMetricPoints().filter((point) => point.labels.__name__ === "harness_session_count");
  expect(sessionPoints).toHaveLength(2);
});

test("resumes appended JSONL data without replaying prior entries and waits for a complete line", () => {
  const root = tempDir();
  const directory = join(root, "--project--");
  mkdirSync(directory);
  const file = join(directory, "2025-01-01T00-00-00-000Z_session.jsonl");
  writeFileSync(file, `${sessionHeader("session", "2025-01-01T00:00:00.000Z")}\n`);
  const firstScan = scanPiSessions(root, new Map());
  const cursors = cursorsFrom(firstScan);

  const entry = {
    type: "message", id: "assistant-1", parentId: null, timestamp: "2025-01-01T00:00:01.000Z",
    message: { role: "assistant", provider: "anthropic", model: "model", timestamp: 1_735_689_601_000,
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" },
  };
  appendFileSync(file, `${JSON.stringify(entry)}\n`);
  const secondScan = scanPiSessions(root, cursors);
  expect(secondScan.flatMap((batch) => batch.events)).toHaveLength(1);
  const afterEntry = cursorsFrom(secondScan);

  const partial = { ...entry, id: "assistant-2" };
  const serialized = JSON.stringify(partial);
  appendFileSync(file, serialized.slice(0, 40));
  const partialScan = scanPiSessions(root, afterEntry);
  expect(partialScan.flatMap((batch) => batch.events)).toHaveLength(0);
  appendFileSync(file, `${serialized.slice(40)}\n`);
  const completedScan = scanPiSessions(root, cursorsFrom(partialScan));
  expect(completedScan.flatMap((batch) => batch.events)).toHaveLength(1);
});

test("rescans a truncated or same-size rewritten file but deduplicates unchanged event identities", () => {
  const root = tempDir();
  const directory = join(root, "--project--");
  mkdirSync(directory);
  const file = join(directory, "2025-01-01T00-00-00-000Z_session.jsonl");
  const entry = {
    type: "message", id: "stable-id", parentId: null, timestamp: "2025-01-01T00:00:01.000Z",
    message: { role: "assistant", provider: "anthropic", model: "model", timestamp: 1_735_689_601_000,
      usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, stopReason: "stop" },
  };
  writeFileSync(file, `${sessionHeader("session", "2025-01-01T00:00:00.000Z")}\n${JSON.stringify(entry)}\n`);
  const first = scanPiSessions(root, new Map());
  expect(first.flatMap((batch) => batch.events)).toHaveLength(1);
  const second = scanPiSessions(root, cursorsFrom(first));
  expect(second.flatMap((batch) => batch.events)).toHaveLength(0);

  writeFileSync(file, `${sessionHeader("session", "2025-01-01T00:00:00.000Z")}\n`);
  const replacement = {
    ...entry,
    message: { ...entry.message, usage: { ...entry.message.usage, input: 11 } },
  };
  writeFileSync(file, `${sessionHeader("session", "2025-01-01T00:00:00.000Z")}\n${JSON.stringify(replacement)}\n`);
  const rewritten = scanPiSessions(root, cursorsFrom(second));
  expect(rewritten.flatMap((batch) => batch.events)[0]?.tokens.input).toBe(11);

  writeFileSync(file, `${sessionHeader("session", "2025-01-01T00:00:00.000Z")}\n`);
  const truncated = scanPiSessions(root, cursorsFrom(rewritten));
  expect(truncated.flatMap((batch) => batch.events)).toHaveLength(0);
});
