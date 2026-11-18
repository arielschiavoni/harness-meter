import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { detectSchema, queryMessages, querySessions } from "./db.ts";
import type { DatabaseSchema } from "./db.ts";
import { messageToSeries, sessionToSeries } from "./metrics.ts";

const databases: Database[] = [];

function fixture(schema: DatabaseSchema, earlyV1 = false): Database {
  const db = new Database(":memory:");
  databases.push(db);
  const session = schema === "v2" ? "session_v2" : "session";
  const message = schema === "v2" ? "session_message" : "message";
  db.run(`CREATE TABLE ${session} (
    id TEXT PRIMARY KEY, time_created INTEGER, time_updated INTEGER
    ${earlyV1 ? "" : ", cost REAL DEFAULT 0, model TEXT"}
  )`);
  db.run(`CREATE TABLE ${message} (
    id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER,
    time_updated INTEGER, data TEXT ${schema === "v2" ? ", type TEXT, seq INTEGER" : ""}
  )`);
  return db;
}

function session(db: Database, schema: DatabaseSchema, id = "session-1", earlyV1 = false): void {
  const table = schema === "v2" ? "session_v2" : "session";
  db.run(`INSERT INTO ${table} (id, time_created, time_updated) VALUES (?, 100, 200)`, [id]);
  if (!earlyV1) db.run(`UPDATE ${table} SET cost = 1.5 WHERE id = ?`, [id]);
}

interface MessageOptions {
  id?: string;
  sessionId?: string;
  type?: string;
  created?: number;
  updated?: number;
  cost?: number;
  completed?: boolean;
  tokens?: { input?: number; output?: number; cache?: { read?: number; write?: number } };
}

function message(db: Database, schema: DatabaseSchema, options: MessageOptions = {}): void {
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
    test("detects the schema and normalizes assistant usage for existing metrics", () => {
      const db = fixture(schema);
      session(db, schema);
      message(db, schema);
      expect(detectSchema(db)).toBe(schema);
      const rows = queryMessages(db, 0);
      expect(rows).toEqual([{
        id: "message-1", session_id: "session-1", time_updated: 200,
        model_id: "eu.anthropic.claude-sonnet-4-6", provider_id: "amazon-bedrock",
        cost: 1.5, tokens_input: 10, tokens_output: 20, tokens_cache_read: 30,
        tokens_cache_write: 40, t_created: 110, t_completed: 190,
      }]);
      const row = rows[0];
      if (!row) throw new Error("Missing fixture message");
      const series = messageToSeries(row);
      expect(series.map((item) => item.samples[0]?.value)).toEqual([1.5, 10, 20, 30, 40]);
      expect(series.every((item) => item.labels.model === "claude-sonnet-4-6")).toBe(true);
      expect(series.every((item) => item.samples[0]?.timestamp === 190)).toBe(true);
      expect(queryMessages(db, 200)).toEqual([]);
      expect(querySessions(db, 200)).toEqual([]);
    });

    test("uses session model and cost when available", () => {
      const db = fixture(schema);
      session(db, schema);
      message(db, schema);
      db.run(`UPDATE ${schema === "v2" ? "session_v2" : "session"} SET model = ?, cost = 3`, [
        JSON.stringify({ id: "gpt-5", providerID: "openai" }),
      ]);
      const row = querySessions(db, 0)[0];
      expect(row).toMatchObject({ model_id: "gpt-5", provider_id: "openai", cost: 3 });
      if (!row) throw new Error("Missing fixture session");
      expect(sessionToSeries(row).map((item) => item.labels.__name__)).toEqual([
        "opencode_session_total", "opencode_session_cost_usd",
      ]);
    });

    test("includes zero-cost token usage and excludes non-assistant, empty and streaming rows", () => {
      const db = fixture(schema);
      session(db, schema);
      db.run(`UPDATE ${schema === "v2" ? "session_v2" : "session"} SET cost = 0`);
      message(db, schema, { cost: 0 });
      message(db, schema, { id: "user", type: "user" });
      message(db, schema, { id: "idle", type: "idle" });
      message(db, schema, { id: "synthetic", type: "synthetic" });
      message(db, schema, { id: "empty", cost: 0, tokens: {} });
      message(db, schema, { id: "streaming", completed: false });
      expect(queryMessages(db, 0).map((row) => row.id)).toEqual(["message-1"]);
      expect(querySessions(db, 0)).toMatchObject([{ cost: 0, provider_id: "amazon-bedrock" }]);
    });

    test("includes cache-only usage and defaults missing token counts to zero", () => {
      const db = fixture(schema);
      message(db, schema, { cost: 0, tokens: { cache: { read: 7 } } });
      expect(queryMessages(db, 0)).toMatchObject([{
        tokens_input: 0, tokens_output: 0, tokens_cache_read: 7, tokens_cache_write: 0,
      }]);
    });

    test("falls back to the earliest eligible assistant model deterministically", () => {
      const db = fixture(schema);
      session(db, schema);
      message(db, schema, { id: "later", created: 150 });
      message(db, schema, { id: "earlier", created: 110 });
      const table = schema === "v2" ? "session_message" : "message";
      const path = schema === "v2" ? "$.model.id" : "$.modelID";
      db.run(`UPDATE ${table} SET data = json_set(data, '${path}', 'first-model') WHERE id = 'earlier'`);
      expect(querySessions(db, 0)).toMatchObject([{ model_id: "first-model" }]);
    });

    test("picks up message updates even when session timestamps have not changed", () => {
      const db = fixture(schema);
      session(db, schema);
      message(db, schema, { updated: 300 });
      expect(querySessions(db, 250)).toMatchObject([{ time_updated: 300 }]);
      expect(queryMessages(db, 250)).toHaveLength(1);
    });

    test("exports a streaming message only after it completes", () => {
      const db = fixture(schema);
      message(db, schema, { completed: false });
      expect(queryMessages(db, 0)).toEqual([]);
      const table = schema === "v2" ? "session_message" : "message";
      db.run(`UPDATE ${table} SET data = json_set(data, '$.time.completed', 290), time_updated = 300`);
      expect(queryMessages(db, 200)).toMatchObject([{ t_completed: 290, time_updated: 300 }]);
    });
  });
}

test("supports early v1 sessions without model or cost columns", () => {
  const db = fixture("v1", true);
  session(db, "v1", "session-1", true);
  message(db, "v1");
  message(db, "v1", { id: "second", cost: 2 });
  expect(querySessions(db, 0)).toMatchObject([{
    cost: 3.5, model_id: "eu.anthropic.claude-sonnet-4-6", provider_id: "amazon-bedrock",
  }]);
});

test("prefers v2 when legacy tables remain after migration", () => {
  const db = fixture("v2");
  db.run("CREATE TABLE session (id TEXT)");
  db.run("CREATE TABLE message (id TEXT)");
  expect(detectSchema(db)).toBe("v2");
  session(db, "v2");
  message(db, "v2");
  expect(queryMessages(db, 0)).toHaveLength(1);
});

test("rejects an unsupported database with an actionable error", () => {
  const db = new Database(":memory:");
  databases.push(db);
  expect(() => detectSchema(db)).toThrow("Unsupported OpenCode database");
});
