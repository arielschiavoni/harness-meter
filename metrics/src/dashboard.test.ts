import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface DashboardTarget {
  readonly expr?: string;
}

interface DashboardPanel {
  readonly targets?: readonly DashboardTarget[];
}

interface DashboardVariable {
  readonly name: string;
  readonly query: string;
}

interface Dashboard {
  readonly title: string;
  readonly templating: { readonly list: readonly DashboardVariable[] };
  readonly panels: readonly DashboardPanel[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDashboardVariable(value: unknown): value is DashboardVariable {
  return isRecord(value) && typeof value.name === "string" && typeof value.query === "string";
}

function isDashboardTarget(value: unknown): value is DashboardTarget {
  return isRecord(value) && (value.expr === undefined || typeof value.expr === "string");
}

function isDashboardPanel(value: unknown): value is DashboardPanel {
  return isRecord(value) && (value.targets === undefined ||
    (Array.isArray(value.targets) && value.targets.every(isDashboardTarget)));
}

function isDashboard(value: unknown): value is Dashboard {
  if (!isRecord(value) || typeof value.title !== "string" || !isRecord(value.templating)) return false;
  return Array.isArray(value.templating.list) && value.templating.list.every(isDashboardVariable) &&
    Array.isArray(value.panels) && value.panels.every(isDashboardPanel);
}

test("provisioned dashboard uses shared harness metrics and filters every panel", () => {
  const source: unknown = JSON.parse(readFileSync(resolve(import.meta.dir, "../../grafana/dashboards/harness.json"), "utf8"));
  expect(isDashboard(source)).toBe(true);
  if (!isDashboard(source)) throw new Error("Invalid provisioned Grafana dashboard");

  expect(source.title).toBe("Harness Metrics");
  expect(source.templating.list.map((variable) => variable.name)).toEqual(["harness", "provider", "model"]);
  expect(source.templating.list[0]?.query).toContain("label_values(harness_usage_tokens, harness)");

  const expressions = source.panels.flatMap((panel) => panel.targets ?? [])
    .flatMap((target) => target.expr ? [target.expr] : []);
  expect(expressions.length).toBeGreaterThan(0);
  for (const expression of expressions) {
    expect(expression).toContain("harness=~\"$harness\"");
    expect(expression).toMatch(/harness_(usage_tokens|usage_cost_usd|session_count)/);
    expect(expression).not.toContain("opencode_llm_call_");
  }
  expect(expressions.some((expression) => expression.includes("sum by (harness)"))).toBe(true);
});

test("cache hit rate counts cache writes as uncached prompt tokens", () => {
  const source: unknown = JSON.parse(readFileSync(resolve(import.meta.dir, "../../grafana/dashboards/harness.json"), "utf8"));
  if (!isDashboard(source)) throw new Error("Invalid provisioned Grafana dashboard");
  const panel = source.panels.find((item) => isRecord(item) && item.title === "Cache Hit Rate");
  const expression = panel?.targets?.[0]?.expr ?? "";
  const [numerator, denominator] = expression.split(" / ");
  expect(numerator).toContain('type="cache_read"');
  expect(denominator).toContain('type=~"input|cache_read|cache_write"');
});
