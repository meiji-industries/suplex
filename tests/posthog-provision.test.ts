import { expect, test } from "vitest";

import { configFromEnv, DASHBOARDS, FEATURE_FLAGS, PostHogApi, provision } from "../scripts/posthog-provision.js";

type Stored = { id: number; key?: string; tags?: string[]; [key: string]: unknown };

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

test("follows same-origin pagination and refuses a hostile next URL", async () => {
  const seen: string[] = [];
  const fetchStub = (async (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    if (seen.length === 1) return json({ results: [{ id: 1 }], next: "https://us.posthog.com/api/projects/642585/dashboards/?offset=1" });
    return json({ results: [{ id: 2 }], next: null });
  }) as typeof fetch;
  const api = new PostHogApi({ host: "https://us.posthog.com", projectId: "642585", personalApiKey: "secret", dryRun: false }, fetchStub);
  await expect(api.list("/api/projects/642585/dashboards/")).resolves.toEqual([{ id: 1 }, { id: 2 }]);
  expect(seen).toHaveLength(2);

  const hostile = new PostHogApi({ host: "https://us.posthog.com", projectId: "642585", personalApiKey: "secret", dryRun: false }, (async () => json({ results: [], next: "https://example.com/steal" })) as typeof fetch);
  await expect(hostile.list("/api/projects/642585/dashboards/")).rejects.toThrow("cross-origin PostHog pagination URL");
});

test("reports bounded API detail without exposing the personal key", async () => {
  const api = new PostHogApi({ host: "https://us.posthog.com", projectId: "642585", personalApiKey: "phx_private_key", dryRun: false }, (async () => new Response(JSON.stringify({ type: "validation_error", detail: "bad phx_private_key" }), { status: 400, statusText: "Bad Request" })) as typeof fetch);
  await expect(api.list("/api/projects/642585/insights/")).rejects.toThrow('"detail":"bad [redacted]"');
});

test("provisioning reuses its tagged resources on repeated runs", async () => {
  const stores: { dashboards: Stored[]; insights: Stored[]; feature_flags: Stored[] } = { dashboards: [], insights: [], feature_flags: [] };
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown>; authorization: string | null }> = [];
  let nextId = 1;
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const match = url.pathname.match(/\/(dashboards|insights|feature_flags)\/(\d+\/)?$/);
    if (!match) return new Response("not found", { status: 404 });
    const collection = match[1]! as keyof typeof stores;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : undefined;
    const headers = new Headers(init?.headers);
    calls.push({ method, path: url.pathname, ...(body ? { body } : {}), authorization: headers.get("Authorization") });
    if (method === "GET") return json({ results: stores[collection], next: null });
    if (method === "POST") {
      const record = { id: nextId++, ...body } as Stored;
      stores[collection].push(record);
      return json(record);
    }
    const id = Number(url.pathname.split("/").filter(Boolean).at(-1));
    const index = stores[collection].findIndex(record => record.id === id);
    const current = stores[collection][index];
    if (!current) return new Response("not found", { status: 404 });
    stores[collection][index] = { ...current, ...body } as Stored;
    return json(stores[collection][index]);
  }) as typeof fetch;

  const config = { host: "https://us.posthog.com", projectId: "642585", personalApiKey: "secret", dryRun: false };
  const first = await provision(config, fetchStub);
  stores.feature_flags.forEach(flag => { flag.active = true; flag.filters = { groups: [{ rollout_percentage: 25 }] }; });
  const second = await provision(config, fetchStub);
  const insightCount = DASHBOARDS.reduce((count, dashboard) => count + dashboard.insights.length, 0);
  expect(insightCount).toBe(25);
  expect(first.filter(line => line.startsWith("created dashboard"))).toHaveLength(DASHBOARDS.length);
  expect(first.filter(line => line.startsWith("created insight"))).toHaveLength(insightCount);
  expect(first.filter(line => line.startsWith("created feature flag"))).toHaveLength(FEATURE_FLAGS.length);
  expect(second.every(line => line.startsWith("updated"))).toBe(true);
  expect(stores.dashboards).toHaveLength(DASHBOARDS.length);
  expect(stores.insights).toHaveLength(insightCount);
  expect(stores.feature_flags).toHaveLength(FEATURE_FLAGS.length);
  expect(stores.feature_flags.every(flag => flag.active === true)).toBe(true);
  expect(stores.feature_flags.every(flag => JSON.stringify(flag.filters).includes("25"))).toBe(true);
  expect(calls.every(call => call.authorization === "Bearer secret")).toBe(true);
  expect(calls.some(call => call.body && JSON.stringify(call.body).includes("secret"))).toBe(false);
});

test("dry-run plans updates without writes and validates destination allowlists", async () => {
  const methods: string[] = [];
  const fetchStub = (async (_input: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return json({ results: [], next: null });
  }) as typeof fetch;
  const lines = await provision({ host: "https://us.posthog.com", projectId: "642585", personalApiKey: "secret", dryRun: true }, fetchStub);
  expect(lines.every(line => line.startsWith("would-create"))).toBe(true);
  expect(methods.every(method => method === "GET")).toBe(true);
  expect(() => configFromEnv([], { POSTHOG_HOST: "https://evil.example", POSTHOG_PERSONAL_API_KEY: "secret" })).toThrow("outside POSTHOG_ALLOWED_HOSTS");
  expect(() => configFromEnv([], { POSTHOG_PROJECT_ID: "9", POSTHOG_PERSONAL_API_KEY: "secret" })).toThrow("outside POSTHOG_ALLOWED_PROJECTS");
});

test("uses supported visualization wrappers and never labels receipts as recurring revenue", () => {
  const queries = DASHBOARDS.flatMap(dashboard => dashboard.insights.map(insight => insight.query));
  expect(queries.every(query => query.kind === "InsightVizNode" || query.kind === "DataVisualizationNode")).toBe(true);
  const sourceKinds = queries.map(query => (query.source as Record<string, unknown>).kind);
  expect(sourceKinds).toEqual(expect.arrayContaining(["TrendsQuery", "FunnelsQuery", "RetentionQuery", "HogQLQuery"]));
  const names = DASHBOARDS.flatMap(dashboard => dashboard.insights.map(insight => insight.name.toLowerCase())).join(" ");
  expect(names).not.toMatch(/\bmrr\b|\barr\b|\barpa\b|\bchurn\b/);
  const definitions = JSON.stringify(DASHBOARDS).toLowerCase();
  expect(definitions).toContain("this is not mrr");
  expect(definitions).toContain("refund_amount_minor");
  expect(definitions).not.toContain("amount_refunded_minor");
  expect(definitions).not.toContain(" / 100");
});

test("SQL visualizations declare exact axes and keep currencies in separate series", () => {
  const insights = Object.fromEntries(DASHBOARDS.flatMap(dashboard => dashboard.insights.map(insight => [insight.key, insight.query])));
  expect(insights["paid-invoice-value"]?.chartSettings).toEqual({ xAxis: { column: "month" }, yAxis: [{ column: "paid_minor_units" }], seriesBreakdownColumn: "currency" });
  expect(insights["delivery-duration"]?.chartSettings).toEqual({ xAxis: { column: "week" }, yAxis: [{ column: "p50_s" }, { column: "p90_s" }] });
  expect(insights["paid-companies"]?.chartSettings).toEqual({ xAxis: { column: "month" }, yAxis: [{ column: "paid_companies" }] });
  expect(insights["cash-collected"]?.chartSettings).toEqual({ xAxis: { column: "month" }, yAxis: [{ column: "paid_minor_units" }], seriesBreakdownColumn: "currency" });
  expect(insights["stripe-refunds"]?.chartSettings).toEqual({ xAxis: { column: "month" }, yAxis: [{ column: "refunded_minor_units" }], seriesBreakdownColumn: "currency" });
});
