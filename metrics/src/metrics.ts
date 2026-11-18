import { TOKEN_TYPES } from "./types.ts";
import type { Harness, MetricPointDraft, TokenType, UsageEvent } from "./types.ts";

function nonNegative(value: number): number {
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

/** Normalize vendor/region prefixes and provider-specific date/version suffixes. */
export function normalizeModel(raw: string | null | undefined): string {
  if (!raw) return "unknown";

  let id = raw.toLowerCase();
  id = id.replace(/(\d)\.(\d)/g, "$1-$2");
  id = id.replace(/^(eu\.|us\.|anthropic\.|nvidia\.|minimax\.|amazon\.|google\.)+/, "");
  id = id.replace(/-v\d+:\d+$/, "");
  id = id.replace(/-\d{8}$/, "");
  return id;
}

export function normalizeProvider(raw: string | null | undefined): string {
  return raw?.trim() || "unknown";
}

export function hasUsage(event: Pick<UsageEvent, "tokens" | "costUsd">): boolean {
  return event.costUsd > 0 || TOKEN_TYPES.some((type) => event.tokens[type] > 0);
}

function makePoint(
  name: string,
  labels: Readonly<Record<string, string>>,
  value: number,
  timestamp: number
): MetricPointDraft {
  return {
    labels: { __name__: name, ...labels },
    value: nonNegative(value),
    timestamp,
  };
}

export function usageEventToPoints(event: UsageEvent): MetricPointDraft[] {
  const base = {
    harness: event.harness,
    provider: normalizeProvider(event.provider),
    model: normalizeModel(event.model),
  };
  const points = TOKEN_TYPES.map((type: TokenType) =>
    makePoint("harness_usage_tokens", { ...base, type }, event.tokens[type], event.timestamp)
  );
  if (event.costUsd > 0) {
    points.push(makePoint("harness_usage_cost_usd", base, event.costUsd, event.timestamp));
  }
  return points;
}

export function sessionCountPoint(
  harness: Harness,
  provider: string,
  model: string,
  timestamp: number
): MetricPointDraft {
  return makePoint("harness_session_count", {
    harness,
    provider: normalizeProvider(provider),
    model: normalizeModel(model),
  }, 1, timestamp);
}
