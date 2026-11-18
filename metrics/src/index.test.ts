import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uncompress } from "snappy";

for (const schema of ["v1", "v2"] as const) {
  test(`${schema} exporter retries failed remote writes before advancing its checkpoints`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "opencode-metrics-"));
    const dbPath = join(directory, "opencode.db");
    const statePath = join(directory, "state.db");
    const db = new Database(dbPath);
    const sessionTable = schema === "v2" ? "session_v2" : "session";
    const messageTable = schema === "v2" ? "session_message" : "message";
    db.run(`CREATE TABLE ${sessionTable} (id TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, model TEXT)`);
    db.run(`CREATE TABLE ${messageTable} (id TEXT, session_id TEXT, time_updated INTEGER, data TEXT ${schema === "v2" ? ", type TEXT" : ""})`);
    db.run(`INSERT INTO ${sessionTable} VALUES ('session-1', 100, 200, 0, NULL)`);
    const data = JSON.stringify({
      ...(schema === "v2" ? { model: { id: "test-model", providerID: "test-provider" } }
        : { role: "assistant", modelID: "test-model", providerID: "test-provider" }),
      cost: 0, tokens: { input: 10, output: 20 }, time: { created: 110, completed: 190 },
    });
    db.run(`INSERT INTO ${messageTable} VALUES ('message-1', 'session-1', 200, ? ${schema === "v2" ? ", 'assistant'" : ""})`, [data]);
    db.close();
    // Also verify that pre-existing v1 checkpoints cannot suppress v2 backfill.
    const initialState = new Database(statePath);
    initialState.run("CREATE TABLE watermark (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    initialState.run("INSERT INTO watermark VALUES ('session', ?), ('message', ?)", [schema === "v2" ? 999 : 0, schema === "v2" ? 999 : 0]);
    initialState.close();

    let requests = 0;
    let decodedBodies = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/v1/write");
        expect(request.headers.get("Content-Encoding")).toBe("snappy");
        const body = await uncompress(Buffer.from(await request.arrayBuffer()));
        if (body.length > 0) decodedBodies++;
        requests++;
        return new Response(null, { status: requests === 1 ? 500 : 204 });
      },
    });
    // Closing stdin stops the test child without signal permissions, which
    // restricted container environments may deny even for our own children.
    const child = Bun.spawn([process.execPath, "--eval", `
      import(${JSON.stringify(join(import.meta.dir, "index.ts"))}).catch((error) => {
        console.error(error);
        process.exit(1);
      });
      await Bun.stdin.text();
      process.exit(0);
    `], {
      env: { ...process.env, OPENCODE_DB: dbPath, STATE_DB: statePath,
        PROMETHEUS_URL: `http://127.0.0.1:${server.port}`, POLL_INTERVAL_MS: "25" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const state = new Database(statePath, { readonly: true });
    state.run("PRAGMA busy_timeout = 1000");
    try {
      const messageKey = schema === "v2" ? "message_v2" : "message";
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const row = state.query<{ value: number }, [string]>("SELECT value FROM watermark WHERE key = ?").get(messageKey);
        if (row?.value === 200) break;
        await Bun.sleep(10);
      }
      expect(state.query<{ value: number }, [string]>("SELECT value FROM watermark WHERE key = ?").get(messageKey)?.value).toBe(200);
      await Bun.sleep(80);
      expect(requests).toBe(3); // failed session write, retry, then message write; no duplicates next poll
      expect(decodedBodies).toBe(3);
      if (schema === "v2") {
        expect(state.query<{ value: number }, []>("SELECT value FROM watermark WHERE key = 'message'").get()?.value).toBe(999);
      }
    } finally {
      await child.stdin.end();
      await child.exited;
      state.close();
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
    expect(await stdout).toContain(`database schema: ${schema}`);
    expect(await stderr).toContain("Prometheus remote write failed: 500");
  });
}
