import process from "node:process";
import { pathToFileURL } from "node:url";

const OWNER_TAG = "managed-by:suplex-posthog-v1";
const DEFAULT_HOST = "https://us.posthog.com";
const DEFAULT_PROJECT = "642585";

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
type ApiRecord = { id: number | string; name?: string; key?: string; tags?: string[]; [key: string]: unknown };
type Fetch = typeof fetch;

export type ProvisionConfig = {
  host: string;
  projectId: string;
  personalApiKey: string;
  dryRun: boolean;
};

type InsightSpec = { key: string; name: string; description: string; query: Record<string, Json> };
type DashboardSpec = { key: string; name: string; description: string; insights: InsightSpec[] };

const appProperty = { key: "$lib", value: ["suplex-host"], operator: "exact", type: "event" } as const;
const billingProperty = { key: "$lib", value: ["suplex-billing"], operator: "exact", type: "event" } as const;
const billingProductionProperty = { key: "billing_environment", value: ["production"], operator: "exact", type: "event" } as const;
const webDownloadProperty = { key: "$lib", value: ["suplex-web"], operator: "exact", type: "event" } as const;
const websiteProperty = { key: "surface", value: ["website"], operator: "exact", type: "event" } as const;
const events = (event: string, math: "total" | "dau" | "unique_group" = "total", properties: Json[] = []): Record<string, Json> => ({ kind: "EventsNode", event, math, properties });
const trend = (series: Record<string, Json>[], display: string = "ActionsLineGraph", properties: Json[] = [], interval = "day"): Record<string, Json> => ({
  kind: "InsightVizNode",
  source: { kind: "TrendsQuery", dateRange: { date_from: "-30d" }, interval, series, properties, trendsFilter: { display }, filterTestAccounts: true },
});

export const DASHBOARDS: DashboardSpec[] = [
  {
    key: "aarrr",
    name: "Suplex — AARRR",
    description: "Website acquisition, product activation, native retention, collaboration proxy, and authoritative paid-invoice revenue. Membership is a collaboration proxy, not demonstrated referral.",
    insights: [
      { key: "website-visitors", name: "Acquisition — unique website visitors", description: "Unique visitors to consented website pageviews.", query: trend([events("$pageview", "dau")], "ActionsLineGraph", [websiteProperty]) },
      { key: "website-source", name: "Acquisition — first-touch source", description: "Browser-local first-touch source for consented visitors.", query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", dateRange: { date_from: "-30d" }, series: [events("$pageview", "dau")], properties: [websiteProperty], breakdownFilter: { breakdowns: [{ property: "attribution_first_source", type: "event" }], breakdown_limit: 20 }, trendsFilter: { display: "ActionsBar" }, filterTestAccounts: true } } },
      { key: "website-campaign", name: "Acquisition — last-touch campaign", description: "Browser-local last-touch UTM campaign for consented visitors.", query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", dateRange: { date_from: "-30d" }, series: [events("$pageview", "dau")], properties: [websiteProperty], breakdownFilter: { breakdowns: [{ property: "attribution_last_campaign", type: "event" }], breakdown_limit: 20 }, trendsFilter: { display: "ActionsBar" }, filterTestAccounts: true } } },
      { key: "activation-funnel", name: "Activation — project to delivered task", description: "Installations progressing from project creation through task start to delivery.", query: { kind: "InsightVizNode", source: { kind: "FunnelsQuery", dateRange: { date_from: "-30d" }, series: [events("project_created", "total"), events("task_started", "total"), events("task_delivered", "total")], properties: [appProperty], funnelsFilter: { funnelOrderType: "ordered", funnelWindowInterval: 30, funnelWindowIntervalUnit: "day" }, filterTestAccounts: true } } },
      { key: "weekly-retention", name: "Retention — weekly native task activity", description: "Weekly return to task starts after an initial task start.", query: { kind: "InsightVizNode", source: { kind: "RetentionQuery", dateRange: { date_from: "-12w" }, properties: [appProperty], retentionFilter: { period: "Week", totalIntervals: 12, targetEntity: { id: "task_started", name: "task_started", type: "events" }, returningEntity: { id: "task_started", name: "task_started", type: "events" }, retentionType: "retention_first_time", retentionReference: "total", cumulative: false }, filterTestAccounts: true } } },
      { key: "collaboration-proxy", name: "Referral proxy — memberships added", description: "Collaboration proxy only. membership_added does not prove a referral or invitation conversion.", query: trend([events("membership_added")], "ActionsLineGraph", [appProperty], "week") },
      { key: "paid-invoices", name: "Revenue — paid production invoices", description: "Count of authoritative production Stripe invoice-paid webhook events emitted by hosted billing.", query: trend([events("billing_invoice_paid")], "ActionsLineGraph", [billingProperty, billingProductionProperty], "week") },
      { key: "paid-invoice-value", name: "Revenue — production paid invoice minor units by currency", description: "Paid invoice cash in Stripe minor units, kept in separate currency rows. This is not MRR.", query: { kind: "DataVisualizationNode", display: "ActionsLineGraph", chartSettings: { xAxis: { column: "month" }, yAxis: [{ column: "paid_minor_units" }], seriesBreakdownColumn: "currency" }, source: { kind: "HogQLQuery", query: "SELECT toStartOfMonth(timestamp) AS month, upper(toString(properties.currency)) AS currency, sum(toFloat(properties.amount_paid_minor)) AS paid_minor_units FROM events WHERE event = 'billing_invoice_paid' AND properties.$lib = 'suplex-billing' AND properties.billing_environment = 'production' AND notEmpty(toString(properties.currency)) AND isNotNull(properties.amount_paid_minor) AND timestamp >= now() - INTERVAL 12 MONTH GROUP BY month, currency ORDER BY month, currency" } } },
    ],
  },
  {
    key: "product-health",
    name: "Suplex — Product health",
    description: "Native usage, workflow, delivery, version, platform, reliability, and performance signals.",
    insights: [
      { key: "native-hosts", name: "Usage — daily active native hosts", description: "Unique installations sending host_daily.", query: trend([events("host_daily", "dau")], "ActionsLineGraph", [appProperty]) },
      { key: "task-workflow", name: "Workflow — task lifecycle", description: "Created, started, delivered, waiting, and cancelled task events.", query: trend([events("task_created"), events("task_started"), events("task_delivered"), events("task_waiting_human"), events("task_cancelled")], "ActionsLineGraph", [appProperty]) },
      { key: "delivery-duration", name: "Performance — delivered task duration p50/p90", description: "Task creation-to-delivery seconds from the host event.", query: { kind: "DataVisualizationNode", display: "ActionsLineGraph", chartSettings: { xAxis: { column: "week" }, yAxis: [{ column: "p50_s" }, { column: "p90_s" }] }, source: { kind: "HogQLQuery", query: "SELECT toStartOfWeek(timestamp) AS week, quantile(0.5)(toFloat(properties.duration_s)) AS p50_s, quantile(0.9)(toFloat(properties.duration_s)) AS p90_s FROM events WHERE event = 'task_delivered' AND properties.$lib = 'suplex-host' AND timestamp >= now() - INTERVAL 90 DAY GROUP BY week ORDER BY week" } } },
      { key: "version", name: "Reliability — active hosts by app version", description: "Host starts broken down by release revision.", query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", dateRange: { date_from: "-30d" }, series: [events("host_started", "dau")], properties: [appProperty], breakdownFilter: { breakdowns: [{ property: "app_version", type: "event" }], breakdown_limit: 20 }, trendsFilter: { display: "ActionsBar" }, filterTestAccounts: true } } },
      { key: "platform", name: "Reliability — active hosts by platform", description: "Host starts by operating system.", query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", dateRange: { date_from: "-30d" }, series: [events("host_started", "dau")], properties: [appProperty], breakdownFilter: { breakdowns: [{ property: "os", type: "event" }], breakdown_limit: 10 }, trendsFilter: { display: "ActionsBar" }, filterTestAccounts: true } } },
      { key: "pull-requests", name: "Delivery — pull requests opened and merged", description: "Pull request delivery outcomes by native host.", query: trend([events("pr_opened"), events("pr_merged")], "ActionsLineGraph", [appProperty], "week") },
      { key: "website-conversions", name: "Website — CTA and download clicks", description: "Consented, explicitly annotated website CTA and download clicks.", query: trend([events("website_cta_clicked"), events("website_download_clicked")], "ActionsLineGraph", [websiteProperty]) },
      { key: "actual-downloads", name: "Downloads — actual download starts", description: "Server-observed download_started requests from suplex-web. Each request has a new identity and cannot be joined to a website visitor or native installation.", query: trend([events("download_started")], "ActionsLineGraph", [webDownloadProperty]) },
      { key: "actual-downloads-platform", name: "Downloads — actual starts by platform", description: "Server-observed download_started requests by requested platform. This independent request stream does not share browser or native installation identity.", query: { kind: "InsightVizNode", source: { kind: "TrendsQuery", dateRange: { date_from: "-30d" }, series: [events("download_started")], properties: [webDownloadProperty], breakdownFilter: { breakdowns: [{ property: "platform", type: "event" }], breakdown_limit: 10 }, trendsFilter: { display: "ActionsBar" }, filterTestAccounts: true } } },
    ],
  },
  {
    key: "saas-billing-health",
    name: "Suplex — SaaS billing health",
    description: "Production Stripe cash and subscription facts plus RevenueCat lifecycle health. Stripe is the sole monetary source to avoid double counting.",
    insights: [
      { key: "paid-companies", name: "Stripe — production companies with paid invoices", description: "Unique company groups with at least one verified paid invoice.", query: { kind: "DataVisualizationNode", display: "ActionsLineGraph", chartSettings: { xAxis: { column: "month" }, yAxis: [{ column: "paid_companies" }] }, source: { kind: "HogQLQuery", query: "SELECT toStartOfMonth(timestamp) AS month, uniq(properties.$groups.company) AS paid_companies FROM events WHERE event = 'billing_invoice_paid' AND properties.$lib = 'suplex-billing' AND properties.billing_environment = 'production' AND isNotNull(properties.$groups.company) AND timestamp >= now() - INTERVAL 12 MONTH GROUP BY month ORDER BY month" } } },
      { key: "checkout-conversion", name: "Stripe — checkout to paid invoice by company", description: "Production checkout completion followed by a paid invoice, aggregated by company group.", query: { kind: "InsightVizNode", source: { kind: "FunnelsQuery", dateRange: { date_from: "-90d" }, series: [events("billing_checkout_completed"), events("billing_invoice_paid")], properties: [billingProperty, billingProductionProperty], funnelsFilter: { funnelOrderType: "ordered", funnelWindowInterval: 30, funnelWindowIntervalUnit: "day", funnelAggregateByHogQL: "properties.$groups.company" }, filterTestAccounts: true } } },
      { key: "cash-collected", name: "Stripe — production paid invoice minor units by currency", description: "Paid invoice amount in Stripe minor units. Each currency remains a separate row; this is not MRR.", query: { kind: "DataVisualizationNode", display: "ActionsLineGraph", chartSettings: { xAxis: { column: "month" }, yAxis: [{ column: "paid_minor_units" }], seriesBreakdownColumn: "currency" }, source: { kind: "HogQLQuery", query: "SELECT toStartOfMonth(timestamp) AS month, upper(toString(properties.currency)) AS currency, sum(toFloat(properties.amount_paid_minor)) AS paid_minor_units FROM events WHERE event = 'billing_invoice_paid' AND properties.$lib = 'suplex-billing' AND properties.billing_environment = 'production' AND notEmpty(toString(properties.currency)) AND isNotNull(properties.amount_paid_minor) AND timestamp >= now() - INTERVAL 12 MONTH GROUP BY month, currency ORDER BY month, currency" } } },
      { key: "stripe-subscriptions", name: "Stripe — subscription activity", description: "Verified production subscription creation, update, and deletion events.", query: trend([events("billing_subscription_created"), events("billing_subscription_updated"), events("billing_subscription_deleted")], "ActionsLineGraph", [billingProperty, billingProductionProperty], "week") },
      { key: "stripe-payment-risk", name: "Stripe — payment failures and required action", description: "Verified production payment failure and payment-action events.", query: trend([events("billing_payment_failed"), events("billing_payment_action_required")], "ActionsLineGraph", [billingProperty, billingProductionProperty], "week") },
      { key: "stripe-refunds", name: "Stripe — production refund minor units by currency", description: "Incremental refund amount in Stripe minor units. Each currency remains a separate row.", query: { kind: "DataVisualizationNode", display: "ActionsLineGraph", chartSettings: { xAxis: { column: "month" }, yAxis: [{ column: "refunded_minor_units" }], seriesBreakdownColumn: "currency" }, source: { kind: "HogQLQuery", query: "SELECT toStartOfMonth(timestamp) AS month, upper(toString(properties.currency)) AS currency, sum(toFloat(properties.refund_amount_minor)) AS refunded_minor_units FROM events WHERE event = 'billing_refund_issued' AND properties.$lib = 'suplex-billing' AND properties.billing_environment = 'production' AND notEmpty(toString(properties.currency)) AND isNotNull(properties.refund_amount_minor) AND timestamp >= now() - INTERVAL 12 MONTH GROUP BY month, currency ORDER BY month, currency" } } },
      { key: "revenuecat-lifecycle", name: "RevenueCat — subscription lifecycle", description: "Production RevenueCat lifecycle counts. These events carry no monetary value.", query: trend([events("revenuecat_initial_purchase"), events("revenuecat_subscription_renewed"), events("revenuecat_subscription_cancelled"), events("revenuecat_subscription_uncancelled"), events("revenuecat_subscription_expired")], "ActionsLineGraph", [billingProperty, billingProductionProperty], "week") },
      { key: "revenuecat-entitlement-risk", name: "RevenueCat — entitlement risk", description: "Production billing issue, grace-period, pause, transfer, and refund lifecycle signals. These are not cash totals.", query: trend([events("revenuecat_billing_issue"), events("revenuecat_grace_period_started"), events("revenuecat_grace_period_extended"), events("revenuecat_grace_period_ended"), events("revenuecat_subscription_paused"), events("revenuecat_subscription_transferred"), events("revenuecat_subscription_refunded")], "ActionsLineGraph", [billingProperty, billingProductionProperty], "week") },
    ],
  },
];

export const FEATURE_FLAGS = [
  { key: "suplex-website-cta-experiment", name: "Website CTA experiment", description: "Reserved website CTA experiment switch. Off until an experiment is configured.", active: false, filters: { groups: [{ properties: [], rollout_percentage: 0 }] }, tags: [OWNER_TAG, "suplex:flag:website-cta-experiment"] },
] as const;

function normalizedHost(value: string): string {
  const parsed = new URL(value);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/") throw new Error("PostHog host must be an HTTPS origin");
  return parsed.origin;
}

export function configFromEnv(argv = process.argv.slice(2), env = process.env): ProvisionConfig & { printPlan: boolean } {
  const host = normalizedHost(env.POSTHOG_HOST ?? DEFAULT_HOST);
  const projectId = env.POSTHOG_PROJECT_ID ?? DEFAULT_PROJECT;
  const allowedHosts = new Set((env.POSTHOG_ALLOWED_HOSTS ?? DEFAULT_HOST).split(",").map(item => normalizedHost(item.trim())));
  const allowedProjects = new Set((env.POSTHOG_ALLOWED_PROJECTS ?? DEFAULT_PROJECT).split(",").map(item => item.trim()));
  if (!allowedHosts.has(host)) throw new Error(`Refusing PostHog host outside POSTHOG_ALLOWED_HOSTS: ${host}`);
  if (!allowedProjects.has(projectId)) throw new Error(`Refusing PostHog project outside POSTHOG_ALLOWED_PROJECTS: ${projectId}`);
  const printPlan = argv.includes("--print-plan");
  const personalApiKey = env.POSTHOG_PERSONAL_API_KEY ?? "";
  if (!printPlan && !personalApiKey) throw new Error("POSTHOG_PERSONAL_API_KEY is required (use --print-plan for an offline preview)");
  return { host, projectId, personalApiKey, dryRun: argv.includes("--dry-run"), printPlan };
}

export class PostHogApi {
  constructor(private readonly config: ProvisionConfig, private readonly fetchImpl: Fetch = fetch) {}

  private url(path: string): string { return new URL(path, `${this.config.host}/`).toString(); }

  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const url = this.url(path);
    if (new URL(url).origin !== this.config.host) throw new Error("Refusing cross-origin PostHog API request");
    const response = await this.fetchImpl(url, { ...init, headers: { Authorization: `Bearer ${this.config.personalApiKey}`, "Content-Type": "application/json", ...init.headers } });
    if (!response.ok) {
      const raw = (await response.text()).slice(0, 2_000);
      let detail = raw;
      try {
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        detail = JSON.stringify(Object.fromEntries(["type", "code", "detail", "error"].filter(key => parsed[key] !== undefined).map(key => [key, parsed[key]])));
      } catch { /* keep the bounded response text */ }
      const safeDetail = detail
        .replaceAll(this.config.personalApiKey, "[redacted]")
        .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
        .replace(/phx_[A-Za-z0-9_-]+/g, "[redacted]")
        .slice(0, 1_000);
      throw new Error(`PostHog API ${response.status} ${response.statusText} for ${new URL(url).pathname}: ${safeDetail}`);
    }
    return await response.json() as T;
  }

  async list(path: string): Promise<ApiRecord[]> {
    const records: ApiRecord[] = [];
    let next: string | null = path;
    while (next) {
      const page: { results?: ApiRecord[]; next?: string | null } | ApiRecord[] = await this.request(next);
      if (Array.isArray(page)) return records.concat(page);
      records.push(...(page.results ?? []));
      if (page.next && new URL(page.next, `${this.config.host}/`).origin !== this.config.host) throw new Error("Refusing cross-origin PostHog pagination URL");
      next = page.next ?? null;
    }
    return records;
  }

  async upsert(path: string, records: ApiRecord[], identity: string, body: Record<string, unknown>): Promise<{ action: string; record: ApiRecord }> {
    const matches = records.filter(record => record.tags?.includes(OWNER_TAG) && record.tags.includes(identity));
    if (matches.length > 1) throw new Error(`Multiple managed PostHog resources have identity ${identity}`);
    const existing = matches[0];
    if (this.config.dryRun) return { action: existing ? "would-update" : "would-create", record: existing ?? { id: "dry-run", ...body } };
    if (existing) return { action: "updated", record: await this.request<ApiRecord>(`${path}${existing.id}/`, { method: "PATCH", body: JSON.stringify(body) }) };
    return { action: "created", record: await this.request<ApiRecord>(path, { method: "POST", body: JSON.stringify(body) }) };
  }
}

export async function provision(config: ProvisionConfig, fetchImpl: Fetch = fetch): Promise<string[]> {
  const api = new PostHogApi(config, fetchImpl);
  const base = `/api/projects/${encodeURIComponent(config.projectId)}/`;
  const [dashboards, insights, flags] = await Promise.all([api.list(`${base}dashboards/`), api.list(`${base}insights/`), api.list(`${base}feature_flags/`)]);
  const output: string[] = [];
  for (const dashboard of DASHBOARDS) {
    const dashboardTag = `suplex:dashboard:${dashboard.key}`;
    const dashboardResult = await api.upsert(`${base}dashboards/`, dashboards, dashboardTag, { name: dashboard.name, description: dashboard.description, tags: [OWNER_TAG, dashboardTag] });
    output.push(`${dashboardResult.action} dashboard ${dashboard.key}`);
    const dashboardId = dashboardResult.record.id;
    for (const insight of dashboard.insights) {
      const insightTag = `suplex:insight:${dashboard.key}:${insight.key}`;
      const result = await api.upsert(`${base}insights/`, insights, insightTag, { name: insight.name, description: insight.description, tags: [OWNER_TAG, insightTag], dashboards: dashboardId === "dry-run" ? [] : [dashboardId], query: insight.query });
      output.push(`${result.action} insight ${dashboard.key}/${insight.key}`);
    }
  }
  for (const flag of FEATURE_FLAGS) {
    const existing = flags.filter(record => record.key === flag.key);
    const owned = existing.filter(record => record.tags?.includes(OWNER_TAG));
    if (existing.length > 0 && owned.length === 0) throw new Error(`Feature flag ${flag.key} exists but is not managed by this tool`);
    const body = owned.length > 0
      ? { key: flag.key, name: flag.name, description: flag.description, tags: flag.tags }
      : { ...flag };
    const result = await api.upsert(`${base}feature_flags/`, flags, flag.tags[1], body);
    output.push(`${result.action} feature flag ${flag.key}`);
  }
  return output;
}

async function main(): Promise<void> {
  const config = configFromEnv();
  if (config.printPlan) {
    console.log(JSON.stringify({ host: config.host, projectId: config.projectId, dashboards: DASHBOARDS, featureFlags: FEATURE_FLAGS }, null, 2));
    return;
  }
  for (const line of await provision(config)) console.log(line);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
}
