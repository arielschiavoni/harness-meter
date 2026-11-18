import { afterEach, expect, test } from "bun:test";
import { RetryableWriteError, writeMetricPoints } from "./remote-write.ts";
import type { MetricPoint } from "./types.ts";

const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true);
});

function serve(status: number): string {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("rejected", { status }) });
  servers.push(server);
  return `http://127.0.0.1:${server.port}`;
}

const point: MetricPoint = {
  id: 1,
  seriesKey: "series",
  labels: { __name__: "harness_usage_tokens", harness: "pi" },
  value: 1,
  timestamp: 1_000,
};

test("marks permanently rejected samples as delivered so later imports are not blocked", async () => {
  const written: number[] = [];
  await writeMetricPoints([point], serve(400), (ids) => { written.push(...ids); });
  expect(written).toEqual([1]);
});

for (const status of [429, 503]) {
  test(`retries ${status} responses without marking samples delivered`, async () => {
    const written: number[] = [];
    await expect(writeMetricPoints([point], serve(status), (ids) => { written.push(...ids); }))
      .rejects.toBeInstanceOf(RetryableWriteError);
    expect(written).toEqual([]);
  });
}
