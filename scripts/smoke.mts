import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POLL_INTERVAL_MS = 5_000;

export interface SmokeTask {
  id: string;
  phase: string;
  owner: string;
  pendingAction: string | null;
  revision: number;
  release?: { pullRequestUrl?: string | null } | null;
}

export interface SmokeMilestones {
  planning: boolean;
  approval: boolean;
  development: boolean;
  builderPid: boolean;
  reviewingDelivery: boolean;
  releasing: boolean;
}

export interface FailureDump {
  error: string;
  task: unknown;
  activity: unknown;
}

export const emptyMilestones = (): SmokeMilestones => ({ planning: false, approval: false, development: false, builderPid: false, reviewingDelivery: false, releasing: false });

const afterPlanning = new Set(["planning", "supplemental_review", "plan_consolidation", "approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done"]);
const afterApproval = new Set(["approval", "ready_for_development", "development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done"]);
const afterDevelopment = new Set(["development", "delivery_ready", "reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done"]);
const afterReview = new Set(["reviewing_delivery", "repair_required", "delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done"]);
const afterReleaseReview = new Set(["delivery_reviewed", "releasing", "merge_conflict_reviewing", "merge_conflict_required", "merge_conflict_resolving", "ci_waiting", "ci_repair_planning", "ci_repairing", "ci_repair_required", "final_review", "accepted", "ready_reconciliation", "manual_merge", "done"]);
const failedPhases = new Set(["blocked", "delivery_blocked", "cancelled", "failed", "repair_required", "merge_conflict_required", "ci_repair_required"]);

export function advanceMilestones(task: SmokeTask, milestones: SmokeMilestones, builderPid: number | null): { milestones: SmokeMilestones; error?: string } {
  const next = { ...milestones };
  if (afterPlanning.has(task.phase)) next.planning = true;
  if (afterApproval.has(task.phase)) next.approval = true;
  if (afterDevelopment.has(task.phase)) next.development = true;
  if (afterReview.has(task.phase)) next.reviewingDelivery = true;
  if (afterReleaseReview.has(task.phase)) next.releasing = true;
  if (builderPid && builderPid > 0 && next.development) next.builderPid = true;
  if (failedPhases.has(task.phase)) return { milestones: next, error: `task entered failure phase ${task.phase}` };
  if (task.owner === "human" && task.phase !== "approval") return { milestones: next, error: `task requires human action in ${task.phase}: ${task.pendingAction ?? "no pending action"}` };
  return { milestones: next };
}

export function formatFailureDump(input: FailureDump): string {
  const activity = input.activity && typeof input.activity === "object" && Array.isArray((input.activity as { events?: unknown[] }).events)
    ? { ...(input.activity as Record<string, unknown>), events: (input.activity as { events: unknown[] }).events.slice(-40) }
    : input.activity;
  return [`SMOKE FAILURE: ${input.error}`, "TASK JSON:", JSON.stringify(input.task, null, 2), "ACTIVITY (last 40 rows):", JSON.stringify(activity, null, 2)].join("\n");
}

function env(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseCookie(response: Response): string {
  const values = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [response.headers.get("set-cookie") ?? ""];
  return values.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
}

function builderPid(diagnostics: unknown): number | null {
  if (!diagnostics || typeof diagnostics !== "object") return null;
  const executions = (diagnostics as { executions?: unknown }).executions;
  if (!Array.isArray(executions)) return null;
  const builder = executions.find((execution) => execution && typeof execution === "object" && (execution as { kind?: unknown }).kind === "developer" && typeof (execution as { pid?: unknown }).pid === "number");
  return builder ? (builder as { pid: number }).pid : null;
}

async function jsonRequest(baseUrl: string, cookie: string, path: string, options: RequestInit = {}): Promise<unknown> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Origin: baseUrl, Cookie: cookie, ...(options.headers ?? {}) },
  });
  const body = await response.json().catch(() => ({ error: "non-JSON response" }));
  if (!response.ok) throw new Error(`${options.method ?? "GET"} ${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

async function dumpAndFail(baseUrl: string, cookie: string, task: SmokeTask | undefined, error: string): Promise<never> {
  const activity = task ? await jsonRequest(baseUrl, cookie, `/api/tasks/${encodeURIComponent(task.id)}/activity`).catch((cause: unknown) => ({ error: cause instanceof Error ? cause.message : String(cause) })) : null;
  process.stderr.write(`${formatFailureDump({ error, task, activity })}\n`);
  throw new Error(error);
}

async function cleanup(baseUrl: string, cookie: string, task: SmokeTask, pullRequestUrl: string): Promise<void> {
  await jsonRequest(baseUrl, cookie, `/api/tasks/${encodeURIComponent(task.id)}/cancel`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: task.revision }) });
  await execFileAsync("gh", ["pr", "close", pullRequestUrl]);
  process.stdout.write("Smoke cleanup: task cancelled and draft pull request closed.\n");
}

async function main(): Promise<void> {
  const port = env("FORGE_PORT", "4111");
  const baseUrl = `http://127.0.0.1:${port}`;
  const timeoutMs = Number(env("FORGE_SMOKE_TIMEOUT_MINUTES", "30")) * 60_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("FORGE_SMOKE_TIMEOUT_MINUTES must be a positive number");

  const auth = await fetch(`${baseUrl}/api/auth/me`, { headers: { Origin: baseUrl } });
  if (!auth.ok) throw new Error(`development auth returned ${auth.status}; run this only against the loopback dev stack with FORGE_DEVELOPMENT_AUTO_LOGIN=1`);
  const cookie = parseCookie(auth);
  if (!cookie) throw new Error("development auth did not issue a session cookie");
  const companies = (await jsonRequest(baseUrl, cookie, "/api/companies")) as { companies?: Array<{ id: string }> };
  const requestedProjectId = process.env.FORGE_SMOKE_PROJECT_ID;
  let companyId: string | undefined;
  let projectId = requestedProjectId;
  const visibleCompanies = companies.companies ?? [];
  const companiesToSearch = requestedProjectId ? visibleCompanies : visibleCompanies.slice(0, 1);
  for (const company of companiesToSearch) {
    const projects = (await jsonRequest(baseUrl, cookie, `/api/companies/${encodeURIComponent(company.id)}/projects`)) as { projects?: Array<{ id: string }> };
    const match = requestedProjectId ? projects.projects?.find((project) => project.id === requestedProjectId) : projects.projects?.[0];
    if (match) { companyId = company.id; projectId = match.id; break; }
  }
  if (!companyId || !projectId) throw new Error(requestedProjectId ? `project ${requestedProjectId} was not found in a visible company` : "no project was found in the first visible company");

  const timestamp = new Date().toISOString();
  const payload = {
    projectId,
    title: env("FORGE_SMOKE_TITLE", `Smoke ${timestamp}`),
    description: env("FORGE_SMOKE_BRIEF", `Add a line to docs/SMOKE.md saying smoke ${timestamp}`),
    idempotencyKey: `smoke-${randomUUID()}`,
    autoApprovePlan: true,
    deliveryTarget: env("FORGE_SMOKE_DELIVERY", "pull_request_draft"),
    runProjectTests: false,
    visualEvidence: "off",
  };
  if (process.env.FORGE_SMOKE_DRY_RUN === "1") {
    process.stdout.write(`Smoke dry run passed: authenticated and resolved company ${companyId}, project ${projectId}.\n`);
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  const created = await jsonRequest(baseUrl, cookie, `/api/companies/${encodeURIComponent(companyId)}/tasks`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }) as SmokeTask;
  let task = await jsonRequest(baseUrl, cookie, `/api/tasks/${encodeURIComponent(created.id)}/start-planning`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: created.revision, automatic: true }) }) as SmokeTask;
  let milestones = emptyMilestones();
  let lastPhase = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (task.phase !== lastPhase) {
      lastPhase = task.phase;
      process.stdout.write(`${new Date().toISOString()} phase=${task.phase} pendingAction=${task.pendingAction ?? "none"}\n`);
    }
    const diagnostics = task.phase === "development" || milestones.development ? await jsonRequest(baseUrl, cookie, `/api/tasks/${encodeURIComponent(task.id)}/diagnostics`).catch(() => null) : null;
    const evaluated = advanceMilestones(task, milestones, builderPid(diagnostics));
    milestones = evaluated.milestones;
    if (evaluated.error) await dumpAndFail(baseUrl, cookie, task, evaluated.error);
    const pullRequestUrl = task.release?.pullRequestUrl;
    if (milestones.planning && milestones.approval && milestones.development && milestones.builderPid && milestones.reviewingDelivery && milestones.releasing && pullRequestUrl) {
      process.stdout.write(`Smoke success: ${pullRequestUrl}\n`);
      if (process.env.FORGE_SMOKE_CLEANUP === "1") await cleanup(baseUrl, cookie, task, pullRequestUrl);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    task = await jsonRequest(baseUrl, cookie, `/api/tasks/${encodeURIComponent(task.id)}`) as SmokeTask;
  }
  await dumpAndFail(baseUrl, cookie, task, `timed out after ${timeoutMs / 60_000} minutes; milestones=${JSON.stringify(milestones)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
