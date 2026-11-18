import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { detectSchemas, queryMaxMessageTimestamp, queryMessages } from "./db.ts";
import type { DatabaseSchema } from "./db.ts";
import { readOpenCodeUsage } from "./opencode.ts";
import { usageEventToPoints } from "./metrics.ts";

const databases: Database[] = [];

function fixture(schema: DatabaseSchema, earlyV1 = false): Database {
  const db = new Database(":memory:");
  databases.push(db);
  createTables(db, schema, earlyV1);
  return db;
}

function createTables(db: Database, schema: DatabaseSchema, earlyV1 = false): void {
  const sessionTable = schema === "v2" ? "session_v2" : "session";
  const messageTable = schema === "v2" ? "session_message" : "message";
  db.run(`CREATE TABLE ${sessionTable} (
    id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER
    ${earlyV1 ? "" : ", cost REAL DEFAULT 0, model TEXT"}
  )`);
  db.run(`CREATE TABLE ${messageTable} (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
    time_updated INTEGER, data TEXT ${schema === "v2" ? ", type TEXT, seq INTEGER" : ""}
  )`);
}

interface MessageOptions {
  readonly id?: string;
  readonly sessionId?: string;
  readonly type?: string;
  readonly created?: number;
  readonly updated?: number;
  readonly cost?: number;
  readonly completed?: boolean;
  readonly tokens?: { readonly input?: number; readonly output?: number; readonly cache?: { readonly read?: number; readonly write?: number } };
}

function insertMessage(db: Database, schema: DatabaseSchema, options: MessageOptions = {}): void {
  const type = options.type ?? "assistant";
  const data = JSON.stringify({
    ...(schema === "v2"
      ? { model: { id: "eu.anthropic.claude-sonnet-4-6", providerID: "amazon-bedrock" } }
      : { role: type, modelID: "eu.anthropic.claude-sonnet-4-6", providerID: "amazon-bedrock" }),
    time: { created: options.created ?? 110, ...(options.completed === false ? {} : { completed: 190 }) },
    cost: options.cost ?? 1.5,
    tokens: options.tokens ?? { input: 10, output: 20, cache: { read: 30, write: 40 } },
  });
  const values = [options.id ?? "message-1", options.sessionId ?? "session-1", options.created ?? 110, options.updated ?? 200, data];
  if (schema === "v2") {
    db.run("INSERT INTO session_message (id, session_id, time_created, time_updated, data, type, seq) VALUES (?, ?, ?, ?, ?, ?, 1)", [...values, type]);
  } else {
    db.run("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)", values);
  }
}

afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

for (const schema of ["v1", "v2"] as const) {
  describe(schema, () => {
    test("detects and normalizes completed assistant usage to shared metrics", () => {
      const db = fixture(schema);
      insertMessage(db, schema);
      expect(detectSchemas(db)).toEqual([schema]);
      expect(queryMessages(db, 0, schema)).toMatchObject([{
        id: "message-1", session_id: "session-1", time_updated: 200,
        model_id: "eu.anthropic.claude-sonnet-4-6", provider_id: "amazon-bedrock",
        cost: 1.5, tokens_input: 10, tokens_output: 20, tokens_cache_read: 30,
        tokens_cache_write: 40, t_created: 110, t_completed: 190,
      }]);
      const [event] = readOpenCodeUsage(db, schema, 0);
      expect(event).toMatchObject({
        harness: schema === "v1" ? "opencode_v1" : "opencode_v2",
        provider: "amazon-bedrock", model: "claude-sonnet-4-6",
        timestamp: 190, sessionKey: "opencode:session-1", costUsd: 1.5,
        tokens: { input: 10, output: 20, cache_read: 30, cache_write: 40 },
      });
      if (!event) throw new Error("Missing fixture event");
      const points = usageEventToPoints(event);
      expect(points.map((point) => point.labels.__name__)).toEqual([
        "harness_usage_tokens", "harness_usage_tokens", "harness_usage_tokens",
        "harness_usage_tokens", "harness_usage_cost_usd",
      ]);
      expect(points.map((point) => point.value)).toEqual([10, 20, 30, 40, 1.5]);
      expect(points.every((point) => point.labels.harness === event.harness)).toBe(true);
      expect(points.every((point) => point.timestamp === 190)).toBe(true);
      expect(queryMessages(db, 201, schema)).toEqual([]);
    });

    test("includes zero-cost token usage and excludes non-assistant, empty and streaming rows", () => {
      const db = fixture(schema);
      insertMessage(db, schema, { cost: 0 });
      insertMessage(db, schema, { id: "user", type: "user" });
      insertMessage(db, schema, { id: "idle", type: "idle" });
      insertMessage(db, schema, { id: "synthetic", type: "synthetic" });
      insertMessage(db, schema, { id: "empty", cost: 0, tokens: {} });
      insertMessage(db, schema, { id: "streaming", completed: false });
      expect(queryMessages(db, 0, schema).map((row) => row.id)).toEqual(["message-1"]);
      expect(readOpenCodeUsage(db, schema, 0)).toHaveLength(1);
    });

    test("includes cache-only usage and defaults missing token counts to zero", () => {
      const db = fixture(schema);
      insertMessage(db, schema, { cost: 0, tokens: { cache: { read: 7 } } });
      expect(readOpenCodeUsage(db, schema, 0)).toMatchObject([{
        tokens: { input: 0, output: 0, cache_read: 7, cache_write: 0 },
      }]);
    });

    test("revisits rows at the watermark timestamp to cover same-millisecond inserts", () => {
      const db = fixture(schema);
      insertMessage(db, schema, { id: "first", updated: 200 });
      insertMessage(db, schema, { id: "second", updated: 200, sessionId: "session-2" });
      expect(queryMessages(db, 200, schema).map((row) => row.id)).toEqual(["first", "second"]);
    });
  });
}

test("deduplicates equivalent v1 and v2 snapshots by stable message identity", () => {
  const v1 = fixture("v1");
  const v2 = fixture("v2");
  insertMessage(v1, "v1");
  insertMessage(v2, "v2");
  const first = readOpenCodeUsage(v1, "v1", 0)[0];
  const migrated = readOpenCodeUsage(v2, "v2", 0)[0];
  expect(first?.eventId).toBe(migrated?.eventId);
  expect(first?.payloadHash).toBe(migrated?.payloadHash);
});

test("uses message timestamps as the OpenCode watermark source", () => {
  const db = fixture("v1");
  insertMessage(db, "v1", { type: "user", updated: 500 });
  expect(queryMaxMessageTimestamp(db, "v1")).toBe(500);
});

test("reads original v1 history and v2-only messages from a migrated database", () => {
  // Mirrors a real upgraded database: v2 keeps the legacy v1 tables, copies
  // most (not all) v1 messages with the same ids, then continues in v2.
  const db = fixture("v1");
  createTables(db, "v2");
  insertMessage(db, "v1", { id: "migrated", cost: 1 });
  insertMessage(db, "v2", { id: "migrated", cost: 0.99 });
  insertMessage(db, "v1", { id: "not-migrated", cost: 2 });
  insertMessage(db, "v1", { id: "completed-in-v2", completed: false });
  insertMessage(db, "v2", { id: "completed-in-v2", cost: 3, updated: 300 });
  insertMessage(db, "v2", { id: "v2-only", cost: 4, updated: 400 });

  const schemas = detectSchemas(db);
  expect(schemas).toEqual(["v1", "v2"]);
  const v1 = readOpenCodeUsage(db, "v1", 0, schemas);
  const v2 = readOpenCodeUsage(db, "v2", 0, schemas);
  expect(v1.map((event) => [event.harness, event.costUsd])).toEqual([["opencode_v1", 1], ["opencode_v1", 2]]);
  expect(v2.map((event) => [event.harness, event.costUsd])).toEqual([["opencode_v2", 3], ["opencode_v2", 4]]);
  // Without the schema list, a v2 read would include the migrated copy.
  expect(readOpenCodeUsage(db, "v2", 0)).toHaveLength(3);
});

test("rejects an unsupported database with an actionable error", () => {
  const db = new Database(":memory:");
  databases.push(db);
  expect(() => detectSchemas(db)).toThrow("Unsupported OpenCode database");
});
