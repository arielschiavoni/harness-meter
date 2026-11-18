import { afterEach, expect, test } from "bun:test";
import {
  closeStateDb,
  getPendingMetricPoints,
  getPiFileCursors,
  getWatermark,
  ingestUsageEvents,
  markMetricPointsSent,
  openStateDb,
  pruneSentMetricPointsBefore,
  savePiFileCursor,
  setWatermark,
} from "./state.ts";
import type { UsageEvent } from "./types.ts";

afterEach(() => closeStateDb());

function event(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    eventId: "event-1",
    payloadHash: "hash-1",
    harness: "pi",
    provider: "anthropic",
    model: "claude-test",
    timestamp: 1_000,
    sessionKey: "pi:session-1",
    tokens: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
    costUsd: 0.5,
    ...overrides,
  };
}

test("deduplicates source events and counts each eligible session once", () => {
  openStateDb(":memory:");
  const first = event();
  const second = event({
    eventId: "event-2", payloadHash: "hash-2", timestamp: 1_000,
    tokens: { input: 5, output: 0, cache_read: 0, cache_write: 0 }, costUsd: 0,
  });
  expect(ingestUsageEvents([second, first])).toMatchObject({ inserted: 2, duplicates: 0, conflicts: 0 });
  expect(ingestUsageEvents([first])).toMatchObject({ inserted: 0, duplicates: 1, conflicts: 0 });

  const points = getPendingMetricPoints();
  const input = points.find((point) => point.labels.__name__ === "harness_usage_tokens" && point.labels.type === "input");
  const sessions = points.filter((point) => point.labels.__name__ === "harness_session_count");
  expect(input?.value).toBe(15);
  expect(sessions).toHaveLength(1);
  expect(sessions[0]?.value).toBe(1);
});

test("preserves late events that share an already-exported timestamp", () => {
  openStateDb(":memory:");
  ingestUsageEvents([event()]);
  const initial = getPendingMetricPoints();
  markMetricPointsSent(initial.map((point) => point.id));

  const late = event({
    eventId: "late-event", payloadHash: "late-hash", timestamp: 1_000,
    tokens: { input: 3, output: 0, cache_read: 0, cache_write: 0 }, costUsd: 0,
  });
  expect(ingestUsageEvents([late]).inserted).toBe(1);
  const points = getPendingMetricPoints();
  const tokenPoint = points.find((point) => point.labels.__name__ === "harness_usage_tokens" && point.labels.type === "input");
  expect(tokenPoint?.timestamp).toBe(1_001);
  expect(tokenPoint?.value).toBe(3);
  expect(points.some((point) => point.labels.__name__ === "harness_session_count")).toBe(false);
});

test("retains the first value and reports a changed payload for a stable event identity", () => {
  openStateDb(":memory:");
  ingestUsageEvents([event()]);
  expect(ingestUsageEvents([event({ payloadHash: "changed", tokens: {
    input: 999, output: 0, cache_read: 0, cache_write: 0,
  } })])).toMatchObject({ inserted: 0, duplicates: 1, conflicts: 1 });
  const input = getPendingMetricPoints().find((point) => point.labels.type === "input");
  expect(input?.value).toBe(10);
});

test("prunes expired delivered points but retains deduplication identities", () => {
  openStateDb(":memory:");
  const sourceEvent = event();
  ingestUsageEvents([sourceEvent]);
  const points = getPendingMetricPoints();
  markMetricPointsSent(points.map((point) => point.id));
  expect(pruneSentMetricPointsBefore(1_001)).toBe(points.length);
  expect(getPendingMetricPoints()).toHaveLength(0);
  expect(ingestUsageEvents([sourceEvent])).toMatchObject({ inserted: 0, duplicates: 1 });
});

test("treats a differing copy from another harness schema as a duplicate, not a conflict", () => {
  openStateDb(":memory:");
  ingestUsageEvents([event({ harness: "opencode_v1" })]);
  expect(ingestUsageEvents([event({ harness: "opencode_v2", payloadHash: "migrated-copy" })]))
    .toMatchObject({ inserted: 0, duplicates: 1, conflicts: 0 });
});

test("persists source cursors and independent watermarks", () => {
  openStateDb(":memory:");
  setWatermark("opencode:v2:test", 500);
  expect(getWatermark("opencode:v2:test")).toBe(500);
  expect(getWatermark("opencode:v1:test")).toBe(0);

  savePiFileCursor({
    fileKey: "1:2", path: "/sessions/s.jsonl", offset: 100,
    pendingBase64: "e30=", size: 100, mtimeMs: 200,
    tailHash: "tail", headerJson: "{\"type\":\"session\"}",
  });
  expect(getPiFileCursors().get("1:2")).toMatchObject({
    path: "/sessions/s.jsonl", offset: 100, pendingBase64: "e30=", tailHash: "tail",
  });
});
