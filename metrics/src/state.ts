import { Database } from "bun:sqlite";
import { sessionCountPoint, usageEventToPoints } from "./metrics.ts";
import type { MetricPoint, PiFileCursor, UsageEvent } from "./types.ts";

export type WatermarkKey = string;

export interface IngestResult {
  readonly inserted: number;
  readonly duplicates: number;
  readonly conflicts: number;
}

let stateDb: Database | null = null;

function db(): Database {
  if (!stateDb) throw new Error("State DB not initialised");
  return stateDb;
}

function stableLabels(labels: Readonly<Record<string, string>>): {
  json: string;
  seriesKey: string;
} {
  const ordered = Object.fromEntries(Object.entries(labels).sort(([a], [b]) => a.localeCompare(b)));
  const json = JSON.stringify(ordered);
  return { json, seriesKey: json };
}

function insertPoint(labels: Readonly<Record<string, string>>, value: number, timestamp: number): void {
  if (!Number.isFinite(value) || !Number.isFinite(timestamp) || timestamp <= 0) return;
  const database = db();
  const { json, seriesKey } = stableLabels(labels);
  const findPoint = database.query<{ id: number; sent: number }, [string, number]>(
    "SELECT id, sent FROM metric_point WHERE series_key = ? AND timestamp = ?"
  );
  let targetTimestamp = Math.trunc(timestamp);

  // Aggregate same-label, same-millisecond events before export. If a late event
  // arrives after that point was delivered, preserve it at the next free ms.
  for (let attempts = 0; attempts < 60_000; attempts++) {
    const existing = findPoint.get(seriesKey, targetTimestamp);
    if (!existing) {
      database.run(
        "INSERT INTO metric_point (series_key, labels_json, timestamp, value, sent) VALUES (?, ?, ?, ?, 0)",
        [seriesKey, json, targetTimestamp, value]
      );
      return;
    }
    if (existing.sent === 0) {
      database.run("UPDATE metric_point SET value = value + ? WHERE id = ?", [value, existing.id]);
      return;
    }
    targetTimestamp++;
  }
  throw new Error(`Could not allocate a unique sample timestamp for ${seriesKey}`);
}

function validStringRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object" && value !== null && !Array.isArray(value) &&
    Object.values(value).every((item) => typeof item === "string");
}

export function openStateDb(path: string): void {
  stateDb?.close();
  stateDb = new Database(path, { create: true });
  stateDb.run("PRAGMA busy_timeout = 5000");
  stateDb.run(`
    CREATE TABLE IF NOT EXISTS watermark (
      key TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )
  `);
  stateDb.run(`
    CREATE TABLE IF NOT EXISTS usage_event (
      event_id TEXT PRIMARY KEY,
      payload_hash TEXT NOT NULL,
      harness TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      session_key TEXT NOT NULL,
      tokens_input REAL NOT NULL,
      tokens_output REAL NOT NULL,
      tokens_cache_read REAL NOT NULL,
      tokens_cache_write REAL NOT NULL,
      cost_usd REAL NOT NULL
    )
  `);
  stateDb.run(`
    CREATE TABLE IF NOT EXISTS counted_session (
      session_key TEXT PRIMARY KEY,
      harness TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      timestamp INTEGER NOT NULL
    )
  `);
  stateDb.run(`
    CREATE TABLE IF NOT EXISTS metric_point (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      series_key TEXT NOT NULL,
      labels_json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      value REAL NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0,
      UNIQUE (series_key, timestamp)
    )
  `);
  stateDb.run("CREATE INDEX IF NOT EXISTS metric_point_pending ON metric_point (sent, series_key, timestamp)");
  stateDb.run(`
    CREATE TABLE IF NOT EXISTS pi_file_cursor (
      file_key TEXT PRIMARY KEY,
      path TEXT NOT NULL,
      offset INTEGER NOT NULL,
      pending_base64 TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ms REAL NOT NULL,
      tail_hash TEXT NOT NULL DEFAULT '',
      header_json TEXT NOT NULL
    )
  `);
  const piColumns = new Set(stateDb.query<{ name: string }, []>("PRAGMA table_info(pi_file_cursor)").all().map((row) => row.name));
  if (!piColumns.has("tail_hash")) stateDb.run("ALTER TABLE pi_file_cursor ADD COLUMN tail_hash TEXT NOT NULL DEFAULT ''");

  const init = stateDb.prepare("INSERT OR IGNORE INTO watermark (key, value) VALUES (?, 0)");
  for (const key of ["session", "message", "session_v2", "message_v2"]) init.run(key);
}

export function closeStateDb(): void {
  stateDb?.close();
  stateDb = null;
}

export function getWatermark(key: WatermarkKey): number {
  const row = db().query<{ value: number }, [string]>(
    "SELECT value FROM watermark WHERE key = ?"
  ).get(key);
  return row?.value ?? 0;
}

export function setWatermark(key: WatermarkKey, value: number): void {
  db().run("INSERT INTO watermark (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [key, value]);
}

export function ingestUsageEvents(events: readonly UsageEvent[]): IngestResult {
  let inserted = 0;
  let duplicates = 0;
  let conflicts = 0;
  const database = db();
  const insertEvent = database.query<never, [
    string, string, string, string, string, number, string,
    number, number, number, number, number,
  ]>(`INSERT OR IGNORE INTO usage_event (
    event_id, payload_hash, harness, provider, model, timestamp, session_key,
    tokens_input, tokens_output, tokens_cache_read, tokens_cache_write, cost_usd
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const existingEvent = database.query<{ payload_hash: string; harness: string }, [string]>(
    "SELECT payload_hash, harness FROM usage_event WHERE event_id = ?"
  );
  const markSession = database.query<never, [string, string, string, string, number]>(
    "INSERT OR IGNORE INTO counted_session (session_key, harness, provider, model, timestamp) VALUES (?, ?, ?, ?, ?)"
  );

  database.transaction(() => {
    for (const event of [...events].sort((a, b) => a.timestamp - b.timestamp || a.eventId.localeCompare(b.eventId))) {
      if (!Number.isFinite(event.timestamp) || event.timestamp <= 0) continue;
      const result = insertEvent.run(
        event.eventId,
        event.payloadHash,
        event.harness,
        event.provider,
        event.model,
        Math.trunc(event.timestamp),
        event.sessionKey,
        event.tokens.input,
        event.tokens.output,
        event.tokens.cache_read,
        event.tokens.cache_write,
        event.costUsd,
      );
      if (result.changes === 0) {
        duplicates++;
        // A migrated copy from another schema (an OpenCode v2 copy of a v1
        // message) legitimately differs slightly; only same-harness changes
        // indicate a rewritten source.
        const existing = existingEvent.get(event.eventId);
        if (existing && existing.harness === event.harness && existing.payload_hash !== event.payloadHash) conflicts++;
        continue;
      }

      inserted++;
      for (const point of usageEventToPoints(event)) {
        insertPoint(point.labels, point.value, point.timestamp);
      }

      const sessionResult = markSession.run(
        event.sessionKey,
        event.harness,
        event.provider,
        event.model,
        Math.trunc(event.timestamp),
      );
      if (sessionResult.changes > 0) {
        const point = sessionCountPoint(event.harness, event.provider, event.model, event.timestamp);
        insertPoint(point.labels, point.value, point.timestamp);
      }
    }
  })();

  return { inserted, duplicates, conflicts };
}

export function getPendingMetricPoints(limit = 5_000): MetricPoint[] {
  const rows = db().query<{
    id: number;
    series_key: string;
    labels_json: string;
    timestamp: number;
    value: number;
  }, [number]>(`SELECT id, series_key, labels_json, timestamp, value
    FROM metric_point WHERE sent = 0 ORDER BY series_key, timestamp, id LIMIT ?`).all(limit);
  return rows.flatMap((row) => {
    const labels: unknown = JSON.parse(row.labels_json);
    return validStringRecord(labels)
      ? [{ id: row.id, seriesKey: row.series_key, labels, timestamp: row.timestamp, value: row.value }]
      : [];
  });
}

export function markMetricPointsSent(ids: readonly number[]): void {
  if (ids.length === 0) return;
  const update = db().prepare("UPDATE metric_point SET sent = 1 WHERE id = ?");
  db().transaction(() => {
    for (const id of ids) update.run(id);
  })();
}

export function pruneSentMetricPointsBefore(cutoffTimestamp: number): number {
  const result = db().run("DELETE FROM metric_point WHERE sent = 1 AND timestamp < ?", [cutoffTimestamp]);
  return result.changes;
}

export function getPiFileCursors(): ReadonlyMap<string, PiFileCursor> {
  const rows = db().query<{
    file_key: string;
    path: string;
    offset: number;
    pending_base64: string;
    size: number;
    mtime_ms: number;
    tail_hash: string;
    header_json: string;
  }, []>("SELECT * FROM pi_file_cursor").all();
  return new Map(rows.map((row) => [row.file_key, {
    fileKey: row.file_key,
    path: row.path,
    offset: row.offset,
    pendingBase64: row.pending_base64,
    size: row.size,
    mtimeMs: row.mtime_ms,
    tailHash: row.tail_hash,
    headerJson: row.header_json,
  }]));
}

export function savePiFileCursor(cursor: PiFileCursor): void {
  db().run(`INSERT INTO pi_file_cursor
    (file_key, path, offset, pending_base64, size, mtime_ms, tail_hash, header_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_key) DO UPDATE SET
      path = excluded.path,
      offset = excluded.offset,
      pending_base64 = excluded.pending_base64,
      size = excluded.size,
      mtime_ms = excluded.mtime_ms,
      tail_hash = excluded.tail_hash,
      header_json = excluded.header_json`, [
    cursor.fileKey,
    cursor.path,
    cursor.offset,
    cursor.pendingBase64,
    cursor.size,
    cursor.mtimeMs,
    cursor.tailHash,
    cursor.headerJson,
  ]);
}
