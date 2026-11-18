import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { queryMessages } from "./db.ts";
import type { DatabaseSchema, MessageRow } from "./db.ts";
import { hasUsage, normalizeModel, normalizeProvider } from "./metrics.ts";
import type { Harness, UsageEvent } from "./types.ts";

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function rowToEvent(row: MessageRow, schema: DatabaseSchema): UsageEvent | null {
  if (typeof row.id !== "string" || row.id.length === 0 ||
      typeof row.session_id !== "string" || row.session_id.length === 0) {
    return null;
  }
  const timestamp = numberOrZero(row.t_completed) || numberOrZero(row.time_updated);
  if (timestamp <= 0) return null;

  const provider = normalizeProvider(typeof row.provider_id === "string" ? row.provider_id : null);
  const model = normalizeModel(typeof row.model_id === "string" ? row.model_id : null);
  const tokens = {
    input: numberOrZero(row.tokens_input),
    output: numberOrZero(row.tokens_output),
    cache_read: numberOrZero(row.tokens_cache_read),
    cache_write: numberOrZero(row.tokens_cache_write),
  } as const;
  const costUsd = numberOrZero(row.cost);
  const harness: Harness = schema === "v1" ? "opencode_v1" : "opencode_v2";
  const identity = JSON.stringify([row.session_id, row.id]);
  const payload = JSON.stringify({ timestamp, provider, model, tokens, costUsd });
  const event: UsageEvent = {
    eventId: `opencode:${hash(identity)}`,
    payloadHash: hash(payload),
    harness,
    provider,
    model,
    timestamp,
    sessionKey: `opencode:${row.session_id}`,
    tokens,
    costUsd,
  };
  return hasUsage(event) ? event : null;
}

export function readOpenCodeUsage(
  db: Database,
  schema: DatabaseSchema,
  watermark: number,
  schemas: readonly DatabaseSchema[] = [schema]
): UsageEvent[] {
  return queryMessages(db, watermark, schema, schemas)
    .flatMap((row) => {
      const event = rowToEvent(row, schema);
      return event ? [event] : [];
    });
}
