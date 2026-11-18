import { Database } from "bun:sqlite";

export type WatermarkKey = "session" | "message" | "session_v2" | "message_v2";

let stateDb: Database | null = null;

export function openStateDb(path: string): void {
  stateDb = new Database(path, { create: true });
  stateDb.run(`
    CREATE TABLE IF NOT EXISTS watermark (
      key   TEXT PRIMARY KEY,
      value INTEGER NOT NULL DEFAULT 0
    )
  `);
  // Initialise all keys to 0 if not yet present
  const init = stateDb.prepare(
    "INSERT OR IGNORE INTO watermark (key, value) VALUES (?, 0)"
  );
  for (const key of ["session", "message", "session_v2", "message_v2"]) {
    init.run(key);
  }
}

export function getWatermark(key: WatermarkKey): number {
  if (!stateDb) throw new Error("State DB not initialised");
  const row = stateDb
    .query<{ value: number }, [string]>(
      "SELECT value FROM watermark WHERE key = ?"
    )
    .get(key);
  return row?.value ?? 0;
}

export function setWatermark(key: WatermarkKey, value: number): void {
  if (!stateDb) throw new Error("State DB not initialised");
  stateDb.run("UPDATE watermark SET value = ? WHERE key = ?", [value, key]);
}
