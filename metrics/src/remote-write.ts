// Native Prometheus remote write implementation for Bun.
// Uses protobufjs for encoding and snappy for compression.
// Does NOT use the `prometheus-remote-write` npm package which relies on
// Node.js stream internals (PassThrough) that Bun doesn't fully support.
import protobuf from "protobufjs";
import { compress } from "snappy";
import type { MetricPoint } from "./types.ts";

const configuredBatchSize = process.env.BATCH_SIZE === undefined ? 500 : Number(process.env.BATCH_SIZE);
const BATCH_SIZE = Number.isSafeInteger(configuredBatchSize) && configuredBatchSize > 0
  ? configuredBatchSize
  : 500;

interface TimeSeries {
  readonly labels: Readonly<Record<string, string>>;
  readonly samples: readonly { readonly value: number; readonly timestamp: number }[];
}

interface SeriesBatch {
  readonly series: TimeSeries;
  readonly pointIds: readonly number[];
}

const root = protobuf.parse(`
  syntax = "proto3";
  message Label {
    string name  = 1;
    string value = 2;
  }
  message Sample {
    double value     = 1;
    int64  timestamp = 2;
  }
  message TimeSeries {
    repeated Label  labels  = 1;
    repeated Sample samples = 2;
  }
  message WriteRequest {
    repeated TimeSeries timeseries = 1;
  }
`).root;

const WriteRequest = root.lookupType("WriteRequest");

function encodeWriteRequest(series: readonly TimeSeries[]): Uint8Array {
  const payload = WriteRequest.create({
    timeseries: series.map((item) => ({
      labels: Object.entries(item.labels).map(([name, value]) => ({ name, value })),
      samples: item.samples,
    })),
  });
  return WriteRequest.encode(payload).finish() as Uint8Array;
}

/** Thrown for failures worth retrying: network errors, 429 and 5xx responses. */
export class RetryableWriteError extends Error {}

/**
 * Returns normally when Prometheus accepted the request, or when it rejected
 * it permanently (4xx other than 429). Prometheus appends the valid samples of
 * a request even when it reports 400 for others (for example, samples outside
 * the out-of-order window), so retrying a 4xx would block delivery forever.
 */
async function postToPrometheus(url: string, body: Buffer): Promise<void> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-protobuf",
        "Content-Encoding": "snappy",
        "X-Prometheus-Remote-Write-Version": "0.1.0",
      },
      body: new Uint8Array(body),
    });
  } catch (error) {
    throw new RetryableWriteError(`Prometheus remote write failed: ${String(error)}`);
  }

  if (response.ok) return;
  const text = await response.text().catch(() => "(no body)");
  const message = `Prometheus remote write failed: ${response.status} ${response.statusText} — ${text.trim()}`;
  if (response.status === 429 || response.status >= 500) throw new RetryableWriteError(message);
  console.warn(`${message} (not retried: Prometheus rejected these samples permanently)`);
}

function groupPoints(points: readonly MetricPoint[]): SeriesBatch[] {
  const groups = new Map<string, MetricPoint[]>();
  for (const point of points) {
    const group = groups.get(point.seriesKey) ?? [];
    group.push(point);
    groups.set(point.seriesKey, group);
  }
  return [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([seriesKey, group]) => {
    group.sort((a, b) => a.timestamp - b.timestamp || a.id - b.id);
    const first = group[0];
    if (!first) throw new Error(`Empty metric point group: ${seriesKey}`);
    return {
      series: {
        labels: first.labels,
        samples: group.map((point) => ({ value: point.value, timestamp: point.timestamp })),
      },
      pointIds: group.map((point) => point.id),
    };
  });
}

export async function writeMetricPoints(
  points: readonly MetricPoint[],
  prometheusUrl: string,
  onWritten: (ids: readonly number[]) => void | Promise<void>
): Promise<void> {
  if (points.length === 0) return;

  const remoteWriteUrl = `${prometheusUrl}/api/v1/write`;
  const groups = groupPoints(points);
  const batchCount = Math.ceil(groups.length / BATCH_SIZE);
  console.log(`  → writing ${points.length} samples in ${batchCount} remote-write request(s) to ${remoteWriteUrl}`);

  for (let offset = 0; offset < groups.length; offset += BATCH_SIZE) {
    const batch = groups.slice(offset, offset + BATCH_SIZE);
    const encoded = encodeWriteRequest(batch.map((item) => item.series));
    await postToPrometheus(remoteWriteUrl, await compress(Buffer.from(encoded)));
    await onWritten(batch.flatMap((item) => item.pointIds));
    if (batchCount > 1) console.log(`    request ${Math.floor(offset / BATCH_SIZE) + 1}/${batchCount} done`);
  }
}
