import { Database } from "bun:sqlite";

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
    message: "message",
    assistant: (alias: string) => `json_extract(${alias}.data, '$.role') = 'assistant'`,
    model: "$.modelID",
    provider: "$.providerID",
  },
  v2: {
    message: "session_message",
    assistant: (alias: string) => `${alias}.type = 'assistant'`,
    model: "$.model.id",
    provider: "$.model.providerID",
  },
} as const;

/**
 * Return every OpenCode schema present, oldest first. OpenCode v2 migrates
 * v1 history into its own tables but leaves the v1 tables in place, and the
 * migration does not necessarily copy every v1 message. Both are read; see
 * `queryMessages` for how migrated copies are excluded.
 */
export function detectSchemas(db: Database): DatabaseSchema[] {
  const tables = new Set(
    db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all().map((row) => row.name)
  );
  const schemas: DatabaseSchema[] = [];
  if (tables.has("session") && tables.has("message")) schemas.push("v1");
  if (tables.has("session_v2") && tables.has("session_message")) schemas.push("v2");
  if (schemas.length === 0) {
    throw new Error(
      "Unsupported OpenCode database: expected session_v2/session_message (v2) or session/message (v1) tables"
    );
  }
  return schemas;
}

/** A completed assistant message with positive cost or token usage. */
function eligible(schema: DatabaseSchema, alias: string): string {
  const data = `${alias}.data`;
  return `${SCHEMAS[schema].assistant(alias)}
    AND json_extract(${data}, '$.time.completed') IS NOT NULL
    AND (
      COALESCE(json_extract(${data}, '$.cost'), 0) > 0
      OR COALESCE(json_extract(${data}, '$.tokens.input'), 0) > 0
      OR COALESCE(json_extract(${data}, '$.tokens.output'), 0) > 0
      OR COALESCE(json_extract(${data}, '$.tokens.cache.read'), 0) > 0
      OR COALESCE(json_extract(${data}, '$.tokens.cache.write'), 0) > 0
    )`;
}

function assistantMessages(schema: DatabaseSchema, excludeMigratedV1: boolean): string {
  const source = SCHEMAS[schema];
  // A v2 row whose id has an eligible original in the v1 table is a migrated
  // copy: the v1 original is exported instead, labeled as v1.
  const migrated = excludeMigratedV1
    ? `AND NOT EXISTS (SELECT 1 FROM ${SCHEMAS.v1.message} l WHERE l.id = m.id AND ${eligible("v1", "l")})`
    : "";
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
  WHERE ${eligible(schema, "m")} ${migrated}`;
}

/**
 * Eligible assistant messages updated at or after the watermark. The
 * watermark timestamp itself is included so rows written in the same
 * millisecond as the previous poll are revisited; the event ledger
 * deduplicates them.
 *
 * Pass `schemas` (from `detectSchemas`) so that, in a database with both
 * layouts, migrated v2 copies of v1 messages are not returned for v2.
 */
export function queryMessages(
  db: Database,
  watermark: number,
  schema: DatabaseSchema,
  schemas: readonly DatabaseSchema[] = [schema]
): MessageRow[] {
  const excludeMigratedV1 = schema === "v2" && schemas.includes("v1");
  return db.query<MessageRow, [number]>(
    `SELECT * FROM (${assistantMessages(schema, excludeMigratedV1)})
    WHERE time_updated >= ? ORDER BY time_updated ASC, id ASC`
  ).all(watermark);
}

export function queryMaxMessageTimestamp(db: Database, schema: DatabaseSchema): number {
  const table = SCHEMAS[schema].message;
  const row = db.query<{ watermark: number | null }, []>(
    `SELECT MAX(time_updated) AS watermark FROM ${table}`
  ).get();
  return row?.watermark ?? 0;
}
