import { Database } from "bun:sqlite";

export interface SessionRow {
  id: string;
  time_updated: number;
  time_created: number;
  cost: number;
  model_id: string | null;
  provider_id: string | null;
}

export interface MessageRow {
  id: string;
  session_id: string;
  time_updated: number;
  model_id: string | null;
  provider_id: string | null;
  cost: number;
  tokens_input: number;
  tokens_output: number;
  tokens_cache_read: number;
  tokens_cache_write: number;
  t_created: number | null;
  t_completed: number | null;
}

export function openDb(path: string): Database {
  return new Database(path, { readonly: true });
}

export type DatabaseSchema = "v1" | "v2";

// Only these fixed identifiers are interpolated into SQL; never database input.
const SCHEMAS = {
  v1: {
    session: "session",
    message: "message",
    assistant: "json_extract(m.data, '$.role') = 'assistant'",
    model: "$.modelID",
    provider: "$.providerID",
  },
  v2: {
    session: "session_v2",
    message: "session_message",
    assistant: "m.type = 'assistant'",
    model: "$.model.id",
    provider: "$.model.providerID",
  },
} as const;

export function detectSchema(db: Database): DatabaseSchema {
  const tables = new Set(
    db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all().map((row) => row.name)
  );
  // Upgrades can leave legacy tables behind. Never export both copies.
  if (tables.has("session_v2") && tables.has("session_message")) return "v2";
  if (tables.has("session") && tables.has("message")) return "v1";
  throw new Error(
    "Unsupported OpenCode database: expected session_v2/session_message (v2) or session/message (v1) tables"
  );
}

function assistantMessages(schema: DatabaseSchema): string {
  const source = SCHEMAS[schema];
  return `SELECT
    m.id,
    m.session_id,
    m.time_updated,
    json_extract(m.data, '${source.model}') AS model_id,
    json_extract(m.data, '${source.provider}') AS provider_id,
    COALESCE(json_extract(m.data, '$.cost'), 0) AS cost,
    COALESCE(json_extract(m.data, '$.tokens.input'), 0) AS tokens_input,
    COALESCE(json_extract(m.data, '$.tokens.output'), 0) AS tokens_output,
    COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) AS tokens_cache_read,
    COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) AS tokens_cache_write,
    json_extract(m.data, '$.time.created') AS t_created,
    json_extract(m.data, '$.time.completed') AS t_completed
  FROM ${source.message} m
  WHERE ${source.assistant}
    AND json_extract(m.data, '$.time.completed') IS NOT NULL
    AND (
      COALESCE(json_extract(m.data, '$.cost'), 0) > 0
      OR COALESCE(json_extract(m.data, '$.tokens.input'), 0) > 0
      OR COALESCE(json_extract(m.data, '$.tokens.output'), 0) > 0
      OR COALESCE(json_extract(m.data, '$.tokens.cache.read'), 0) > 0
      OR COALESCE(json_extract(m.data, '$.tokens.cache.write'), 0) > 0
    )`;
}

export function querySessions(
  db: Database,
  watermark: number,
  schema: DatabaseSchema = detectSchema(db)
): SessionRow[] {
  const source = SCHEMAS[schema];
  const columns = new Set(
    db.query<{ name: string }, []>(`PRAGMA table_info(${source.session})`)
      .all().map((row) => row.name)
  );
  // Early v1 databases have neither a session model nor a session cost.
  const cost = columns.has("cost") ? "s.cost" : "usage.cost";
  const model = columns.has("model") ? "json_extract(s.model, '$.id')" : "NULL";
  const provider = columns.has("model") ? "json_extract(s.model, '$.providerID')" : "NULL";

  return db.query<SessionRow, [number]>(
    `WITH assistant AS (${assistantMessages(schema)}),
    ranked AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY session_id ORDER BY t_created, id
      ) AS position FROM assistant
    ),
    usage AS (
      SELECT session_id, SUM(cost) AS cost, MAX(time_updated) AS time_updated
      FROM assistant GROUP BY session_id
    )
    SELECT s.id,
      MAX(s.time_updated, usage.time_updated) AS time_updated,
      s.time_created,
      COALESCE(${cost}, usage.cost, 0) AS cost,
      COALESCE(${model}, first_msg.model_id) AS model_id,
      COALESCE(${provider}, first_msg.provider_id) AS provider_id
    FROM ${source.session} s
    JOIN usage ON usage.session_id = s.id
    JOIN ranked first_msg ON first_msg.session_id = s.id AND first_msg.position = 1
    WHERE MAX(s.time_updated, usage.time_updated) > ?
    ORDER BY time_updated ASC, s.id ASC`
  ).all(watermark);
}

export function queryMessages(
  db: Database,
  watermark: number,
  schema: DatabaseSchema = detectSchema(db)
): MessageRow[] {
  return db.query<MessageRow, [number]>(
    `SELECT * FROM (${assistantMessages(schema)})
    WHERE time_updated > ? ORDER BY time_updated ASC, id ASC`
  ).all(watermark);
}
