import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uncompress } from "snappy";

for (const schema of ["v1", "v2"] as const) {
  test(`${schema} source retries an interrupted remote write without duplicating metrics`, async () => {
    const directory = mkdtempSync(join(tmpdir(), "harness-meter-"));
    const dbPath = join(directory, "opencode.db");
    const statePath = join(directory, "state.db");
    const piPath = join(directory, "pi-sessions");
    mkdirSync(piPath);
    const sourceDb = new Database(dbPath);
    const sessionTable = schema === "v2" ? "session_v2" : "session";
    const messageTable = schema === "v2" ? "session_message" : "message";
    sourceDb.run(`CREATE TABLE ${sessionTable} (id TEXT, time_created INTEGER, time_updated INTEGER, cost REAL, model TEXT)`);
    sourceDb.run(`CREATE TABLE ${messageTable} (id TEXT, session_id TEXT, time_updated INTEGER, data TEXT ${schema === "v2" ? ", type TEXT" : ""})`);
    const timestamp = Date.now() - 1_000;
    sourceDb.run(`INSERT INTO ${sessionTable} VALUES ('session-1', ?, ?, 0, NULL)`, [timestamp - 90, timestamp + 10]);
    const data = JSON.stringify({
      ...(schema === "v2" ? { model: { id: "test-model", providerID: "test-provider" } }
        : { role: "assistant", modelID: "test-model", providerID: "test-provider" }),
      cost: 0, tokens: { input: 10, output: 20 }, time: { created: timestamp - 80, completed: timestamp },
    });
    sourceDb.run(`INSERT INTO ${messageTable} VALUES ('message-1', 'session-1', ?, ? ${schema === "v2" ? ", 'assistant'" : ""})`, [timestamp + 10, data]);
    sourceDb.close();
    const oldState = new Database(statePath);
    oldState.run("CREATE TABLE watermark (key TEXT PRIMARY KEY, value INTEGER NOT NULL)");
    oldState.run("INSERT INTO watermark VALUES ('session', ?), ('message', ?)", [999, 999]);
    oldState.close();

    const bodies: string[] = [];
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1", port: 0,
      async fetch(request) {
        expect(new URL(request.url).pathname).toBe("/api/v1/write");
        expect(request.headers.get("Content-Encoding")).toBe("snappy");
        const body = await uncompress(Buffer.from(await request.arrayBuffer()));
        bodies.push(Buffer.from(body).toString("hex"));
        requests++;
        return new Response(null, { status: requests === 1 ? 500 : 204 });
      },
    });
    const child = Bun.spawn([process.execPath, "--eval", `
      import(${JSON.stringify(join(import.meta.dir, "index.ts"))}).catch((error) => {
        console.error(error);
        process.exit(1);
      });
      await Bun.stdin.text();
      process.exit(0);
    `], {
      env: { ...process.env, OPENCODE_DB: dbPath,
        PI_SESSIONS_DIR: piPath, STATE_DB: statePath,
        PROMETHEUS_URL: `http://127.0.0.1:${server.port}`, POLL_INTERVAL_MS: "25" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const state = new Database(statePath, { readonly: true });
    state.run("PRAGMA busy_timeout = 1000");
    try {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const ready = state.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'metric_point'").get();
        if (ready) {
          const sent = state.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM metric_point WHERE sent = 1").get();
          if (sent?.count === 5) break;
        }
        await Bun.sleep(10);
      }
      expect(state.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM usage_event").get()?.count).toBe(1);
      expect(state.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM metric_point WHERE sent = 1").get()?.count).toBe(5);
      await Bun.sleep(80);
      expect(requests).toBe(2); // fail once, then retry the identical outbox payload
      expect(bodies[0]).toBe(bodies[1]);
    } finally {
      await child.stdin.end();
      await child.exited;
      state.close();
      server.stop(true);
      rmSync(directory, { recursive: true, force: true });
    }
    expect(await stdout).toContain(`[opencode_${schema}]`);
    expect(await stderr).toContain("Prometheus remote write failed: 500");
  });
}
