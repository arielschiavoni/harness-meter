export const HARNESSES = ["opencode_v1", "opencode_v2", "pi"] as const;
export type Harness = (typeof HARNESSES)[number];

export const TOKEN_TYPES = ["input", "output", "cache_read", "cache_write"] as const;
export type TokenType = (typeof TOKEN_TYPES)[number];

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cache_read: number;
  readonly cache_write: number;
}

/** A stable, normalized source usage observation; it is persisted before export. */
export interface UsageEvent {
  readonly eventId: string;
  readonly payloadHash: string;
  readonly harness: Harness;
  readonly provider: string;
  readonly model: string;
  readonly timestamp: number;
  readonly sessionKey: string;
  readonly tokens: TokenUsage;
  readonly costUsd: number;
}

export interface MetricPointDraft {
  readonly labels: Readonly<Record<string, string>>;
  readonly value: number;
  readonly timestamp: number;
}

export interface MetricPoint extends MetricPointDraft {
  readonly id: number;
  readonly seriesKey: string;
}

export interface PiSessionHeader {
  readonly sessionId: string;
  readonly timestamp: number;
  readonly parentSession: string | null;
}

export interface PiFileCursor {
  readonly fileKey: string;
  readonly path: string;
  readonly offset: number;
  readonly pendingBase64: string;
  readonly size: number;
  readonly mtimeMs: number;
  readonly tailHash: string;
  readonly headerJson: string;
}
