import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectSchemas, openDb, queryMaxMessageTimestamp } from "./db.ts";
import type { DatabaseSchema } from "./db.ts";
import { readOpenCodeUsage } from "./opencode.ts";
import { scanPiSessions } from "./pi.ts";
import {
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
import { writeMetricPoints } from "./remote-write.ts";
import type { Database } from "bun:sqlite";

function positiveInteger(raw: string | undefined, fallback: number): number {
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

const STATE_DB = process.env.STATE_DB ?? "/state/metrics-state.db";
const PROMETHEUS_URL = process.env.PROMETHEUS_URL ?? "http://prometheus:9090";
const POLL_INTERVAL_MS = positiveInteger(process.env.POLL_INTERVAL_MS, 60_000);
const OPENCODE_DB = process.env.OPENCODE_DB ?? "/data/opencode/opencode.db";
const PI_SESSIONS_DIR = process.env.PI_SESSIONS_DIR ?? "/data/pi-sessions";
const METRIC_POINT_RETENTION_DAYS = positiveInteger(process.env.METRIC_POINT_RETENTION_DAYS, 730);

interface OpenCodeSource {
  readonly path: string;
  readonly schemas: readonly DatabaseSchema[];
  readonly db: Database;
}

/** `OPENCODE_DB` is a comma-separated list of database paths; empty disables OpenCode. */
function configuredOpenCodeDatabases(): string[] {
  const paths = OPENCODE_DB.split(",").map((path) => path.trim()).filter((path) => path.length > 0);
  return [...new Set(paths.map((path) => resolve(path)))].sort((a, b) => a.localeCompare(b));
}

function openCodeWatermarkKey(path: string, schema: DatabaseSchema): string {
  const pathHash = createHash("sha256").update(path).digest("hex").slice(0, 20);
  return `opencode:${schema}:${pathHash}`;
}

function reportIngest(source: string, result: ReturnType<typeof ingestUsageEvents>): void {
  if (result.inserted > 0 || result.conflicts > 0) {
    console.log(`[${source}] ${result.inserted} new usage events, ${result.duplicates} duplicates`);
  }
  if (result.conflicts > 0) {
    console.warn(`[${source}] ${result.conflicts} repeated event identities had changed payloads; the first recorded version was retained. A fresh rebuild is required to reconcile source rewrites.`);
  }
}

async function processOpenCodeSources(): Promise<void> {
  const sources: OpenCodeSource[] = [];
  for (const path of configuredOpenCodeDatabases()) {
    if (!existsSync(path)) {
      console.warn(`[opencode] source database not found, skipping: ${path}`);
      continue;
    }
    let sourceDb: Database | undefined;
    try {
      sourceDb = openDb(path);
      sources.push({ path, schemas: detectSchemas(sourceDb), db: sourceDb });
      sourceDb = undefined;
    } catch (error) {
      sourceDb?.close();
      console.error(`[opencode] Failed to inspect ${path}; other sources will continue:`, error);
    }
  }

  // Read every v1 layout before any v2 layout. Within one database, migrated
  // v2 copies are excluded in SQL; across separate database copies, the event
  // ledger keeps the first (original v1) version of a message.
  try {
    for (const schema of ["v1", "v2"] as const) {
      for (const source of sources) {
        if (!source.schemas.includes(schema)) continue;
        try {
          const key = openCodeWatermarkKey(source.path, schema);
          const watermark = getWatermark(key);
          const events = readOpenCodeUsage(source.db, schema, watermark, source.schemas);
          const result = ingestUsageEvents(events);
          reportIngest(`opencode_${schema}`, result);

          const maxTimestamp = queryMaxMessageTimestamp(source.db, schema);
          if (maxTimestamp > watermark) setWatermark(key, maxTimestamp);
          console.log(`[opencode_${schema}] ${source.path}: ${events.length} eligible messages at/after ${watermark}`);
        } catch (error) {
          console.error(`[opencode] Failed to read ${schema} tables in ${source.path}; other sources will continue:`, error);
        }
      }
    }
  } finally {
    for (const source of sources) source.db.close();
  }
}

async function processPiSource(): Promise<void> {
  const root = PI_SESSIONS_DIR.trim();
  if (root.length === 0) return;
  if (!existsSync(root)) {
    console.warn(`[pi] session directory not found, skipping: ${root}`);
    return;
  }
  try {
    const batches = scanPiSessions(root, getPiFileCursors());
    const events = batches.flatMap((batch) => batch.events);
    const result = ingestUsageEvents(events);
    reportIngest("pi", result);
    for (const batch of batches) savePiFileCursor(batch.cursor);
    console.log(`[pi] scanned ${batches.length} session files; ${events.length} usage records`);
  } catch (error) {
    console.error(`[pi] Failed to scan ${root}; OpenCode sources will continue:`, error);
  }
}

async function flushPendingPoints(): Promise<void> {
  while (true) {
    const points = getPendingMetricPoints(5_000);
    if (points.length === 0) return;
    await writeMetricPoints(points, PROMETHEUS_URL, (ids) => markMetricPointsSent(ids));
  }
}

async function processBatch(): Promise<void> {
  const started = Date.now();
  console.log(`\n[${new Date().toISOString()}] Starting harness metrics cycle...`);
  try {
    // Deliver durable outbox rows before reading new source data. If a previous
    // write was interrupted after Prometheus accepted a request, retries replay
    // exactly the same samples before an event can change their aggregation.
    await flushPendingPoints();
    await processOpenCodeSources();
    await processPiSource();
    await flushPendingPoints();
    const cutoff = Date.now() - METRIC_POINT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    pruneSentMetricPointsBefore(cutoff);
  } catch (error) {
    // Source checkpoints and Pi cursors only advance after their data is in the
    // local event ledger/outbox. Pending points are retried before new imports.
    console.error("[error] Export cycle failed; the next cycle will retry:", error);
  }
  console.log(`[${new Date().toISOString()}] Cycle complete in ${Date.now() - started}ms`);
}

console.log("Harness metrics exporter starting...");
console.log(`  state.db       : ${STATE_DB}`);
console.log(`  opencode db(s) : ${configuredOpenCodeDatabases().join(", ") || "disabled"}`);
console.log(`  pi sessions    : ${PI_SESSIONS_DIR || "disabled"}`);
console.log(`  prometheus     : ${PROMETHEUS_URL}/api/v1/write`);
console.log(`  poll           : ${POLL_INTERVAL_MS}ms`);

openStateDb(STATE_DB);
while (true) {
  await processBatch();
  await Bun.sleep(POLL_INTERVAL_MS);
}
