import { createHash } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expect, test } from "vitest";
import { z } from "zod";
import { ForgeDatabase } from "../src/platform/database.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";
import { TaskSchema } from "../src/tasks/contracts.js";
import { composeAdvisorAssignment, composeWorkerAssignment, IMPLEMENTATION_COMMIT_PROMPT, initialCoordinatorPrompt, VERIFICATION_WORKER_PROMPT, workerAssignmentPreamble } from "../src/coordination/workflow-prompts.js";
import { normalizeWorkflowInput, parseAdvisorReport, PublicWorkflowStateSchema, reviewGate, roleLabel, WORKFLOWS, workflowDefinition, type ReviewRecord } from "../src/coordination/workflows.js";
import { nativeApp } from "./helpers/native-app.js";

const sha = (letter: string) => letter.repeat(40);
const range = { baseSha: sha("a"), headSha: sha("b"), files: ["src/a.ts"], commits: [sha("b")] };

test("the catalog has five workflows with fixed roles and defaults", () => {
  expect(WORKFLOWS.map(definition => definition.id)).toEqual(["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request"]);
  expect(WORKFLOWS.map(definition => definition.name)).toEqual(["Standard", "Direct build", "Second opinion", "Combined planning", "Pull request repair"]);
  expect(workflowDefinition("independent_review").advisorRoles).toEqual(["reviewer"]);
  expect(workflowDefinition("competing_plans").advisorRoles).toEqual(["planner_a", "planner_b"]);
  expect(workflowDefinition("refine_pull_request").advisorRoles).toEqual(["rater"]);
  expect(normalizeWorkflowInput({}, { requireSource: true })).toEqual({ workflow: "standard", advisorProfileIds: {} });
  expect(() => normalizeWorkflowInput({ workflow: "fast_track" }, { requireSource: true })).toThrow("does not exist");
  expect(() => normalizeWorkflowInput({ workflow: "independent_review", advisorProfileIds: { rater: "p" } }, { requireSource: true })).toThrow("no Rater Advisor");
  expect(() => normalizeWorkflowInput({ workflow: "standard", advisorProfileIds: { auditor: "p" } }, { requireSource: true })).toThrow("not valid");
  expect(roleLabel({ kind: "worker", advisorRole: "planner_b" })).toBe("Plan B");
  expect(roleLabel({ kind: "worker", advisorRole: null })).toBe("Worker");
  expect(roleLabel({ kind: "root" })).toBe("Coordinator");
});

test("repair normalization enforces the merged target, project tests, and a pull request source", () => {
  const source = { kind: "pull_request", number: 7 };
  expect(normalizeWorkflowInput({ workflow: "refine_pull_request", source }, { requireSource: true })).toMatchObject({ deliveryTarget: "merged", runProjectTests: true });
  expect(normalizeWorkflowInput({ workflow: "refine_pull_request" }, { requireSource: false })).toMatchObject({ deliveryTarget: "merged", runProjectTests: true });
  expect(() => normalizeWorkflowInput({ workflow: "refine_pull_request", source, deliveryTarget: "pull_request_draft" }, { requireSource: true })).toThrow("merged pull request");
  expect(() => normalizeWorkflowInput({ workflow: "refine_pull_request", source, runProjectTests: false }, { requireSource: true })).toThrow("project tests");
  expect(() => normalizeWorkflowInput({ workflow: "refine_pull_request" }, { requireSource: true })).toThrow("Select a pull request source");
  expect(() => normalizeWorkflowInput({ workflow: "refine_pull_request", source: { kind: "branch", branch: "feature" } }, { requireSource: true })).toThrow("Select a pull request source");
  expect(normalizeWorkflowInput({ workflow: "direct_build", deliveryTarget: "remote_branch", runProjectTests: false }, { requireSource: true })).toMatchObject({ deliveryTarget: "remote_branch", runProjectTests: false });
});

test("advisor reports parse from the last json block and reject a pass with blockers or missing checks", () => {
  const report = (json: string) => `Assessment prose.\n\`\`\`json\n{"draft":true}\n\`\`\`\nFinal:\n\`\`\`json\n${json}\n\`\`\`\n`;
  expect(parseAdvisorReport("rater", report('{"rating":7,"blockingFindings":["src/a.ts: null deref"],"verification":"passed","verificationSummary":"pnpm test passed","summary":"Needs repair"}'))).toMatchObject({ result: { role: "rater", rating: 7 }, invalidReason: null });
  expect(parseAdvisorReport("rater", report('{"rating":9,"blockingFindings":["src/a.ts: null deref"],"verification":"passed","verificationSummary":"ok","summary":"ok"}')).result).toBeNull();
  expect(parseAdvisorReport("rater", report('{"rating":9,"blockingFindings":[],"verification":"missing","verificationSummary":"no checks ran","summary":"ok"}')).result).toBeNull();
  expect(parseAdvisorReport("rater", report('{"rating":9.5,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"}')).result).toBeNull();
  expect(parseAdvisorReport("rater", report('{"rating":11,"blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"}')).result).toBeNull();
  expect(parseAdvisorReport("rater", report('{"rating":9,"role":"reviewer","blockingFindings":[],"verification":"passed","verificationSummary":"ok","summary":"ok"}'))).toMatchObject({ result: { role: "rater", rating: 9 } });
  expect(parseAdvisorReport("rater", report('{"rating":8,"blockingFindings":[{"id":"B1","description":"routes/plans.py rejects saved owners"},{"file":"tests/test_plans.py","defect":"no coverage"}],"verification":"missing","verificationSummary":"no local checks","summary":"repair"}'))).toMatchObject({ result: { role: "rater", rating: 8, blockingFindings: ["B1: routes/plans.py rejects saved owners", "tests/test_plans.py: no coverage"] }, invalidReason: null });
  expect(parseAdvisorReport("reviewer", report('{"approved":false,"blockingFindings":[{"note":42}],"verification":"failed","verificationSummary":"x","summary":"y"}')).result).toBeNull();
  expect(parseAdvisorReport("reviewer", report('{"approved":true,"blockingFindings":["src/a.ts: bug"],"verification":"passed","verificationSummary":"ok","summary":"ok"}')).result).toBeNull();
  expect(parseAdvisorReport("reviewer", report('{"approved":false,"blockingFindings":["src/a.ts: bug"],"verification":"failed","verificationSummary":"tests fail","summary":"reject"}'))).toMatchObject({ result: { role: "reviewer", approved: false } });
  expect(parseAdvisorReport("planner_a", report('{"summary":"Add a helper"}'))).toMatchObject({ result: { role: "planner_a", summary: "Add a helper" } });
  expect(parseAdvisorReport("planner_b", "No json here")).toMatchObject({ result: null, invalidReason: expect.stringContaining("no fenced json") });
  expect(parseAdvisorReport("rater", report("{not json"))).toMatchObject({ result: null, invalidReason: expect.stringContaining("not valid JSON") });
});

test("the review gate uses the latest same-role record for the actual range", () => {
  const record = (role: "rater" | "reviewer", result: ReviewRecord["result"], overrides: Partial<ReviewRecord> = {}): ReviewRecord => ({ sessionId: "s", turnId: "t", role, range, result, invalidReason: result ? null : "malformed", recordedAt: "2026-09-06T00:00:00.000Z", ...overrides } as ReviewRecord);
  const pass = { role: "rater" as const, rating: 9, blockingFindings: [], verification: "passed" as const, verificationSummary: "ok", summary: "ok" };
  expect(reviewGate("standard", [], range)).toEqual({ ok: true });
  expect(reviewGate("refine_pull_request", [], range).ok).toBe(false);
  expect(reviewGate("refine_pull_request", [record("rater", pass)], range)).toEqual({ ok: true });
  expect(reviewGate("refine_pull_request", [record("rater", pass), record("rater", null)], range)).toMatchObject({ ok: false, reason: expect.stringContaining("invalid") });
  expect(reviewGate("refine_pull_request", [record("rater", pass), record("rater", { ...pass, rating: 8 })], range)).toMatchObject({ ok: false, reason: expect.stringContaining("8/10") });
  expect(reviewGate("refine_pull_request", [record("rater", pass, { range: { ...range, headSha: sha("c") } })], range)).toMatchObject({ ok: false, reason: expect.stringContaining("not the current range") });
  expect(reviewGate("independent_review", [record("reviewer", { role: "reviewer", approved: true, blockingFindings: [], verification: "not_applicable", verificationSummary: "docs only", summary: "ok" })], range)).toEqual({ ok: true });
  expect(reviewGate("independent_review", [record("reviewer", { role: "reviewer", approved: false, blockingFindings: ["x"], verification: "passed", verificationSummary: "ok", summary: "no" })], range).ok).toBe(false);
});

test("task creation captures workflow and Advisor profiles and keeps pre-upgrade idempotency hashes", async () => {
  const f = await nativeApp();
  try {
    const url = `/api/companies/${f.company.id}/tasks`;
    const legacy = { projectId: f.project.id, title: "Legacy task", description: "Created before workflows", idempotencyKey: "legacy-request-1", startImmediately: false };
    const created = await f.app.inject({ method: "POST", url, headers: f.headers, payload: legacy });
    expect(created.statusCode, created.body).toBe(201);
    const task = TaskSchema.parse(created.json());
    expect(task).toMatchObject({ workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], acceptedDelivery: null, deliveryWait: null, completion: null } });
    expect(created.json().workflowState).not.toHaveProperty("toolOwner");
    const preUpgradeHash = createHash("sha256").update(JSON.stringify({ input: { projectId: f.project.id, title: "Legacy task", description: "Created before workflows", idempotencyKey: "legacy-request-1", images: [], startImmediately: false, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" }, creator: { kind: "user", id: f.userId } })).digest("hex");
    expect(f.database.authQuery(db => db.prepare("SELECT request_hash FROM forge_tasks WHERE id = ?").get(task.id))).toEqual({ request_hash: preUpgradeHash });
    // A row written by the pre-upgrade build retries through the new code without conflict.
    f.database.authTransaction(db => db.prepare("UPDATE forge_tasks SET request_hash = ? WHERE id = ?").run(preUpgradeHash, task.id));
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...legacy, workflow: "standard", advisorProfileIds: {} } })).statusCode).toBe(200);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...legacy, workflow: "direct_build" } })).statusCode).toBe(409);
    expect(f.tasks.listTasks(f.userId)).toHaveLength(1);

    const review = f.profiles.create(f.userId, { name: "Second opinion model", role: "root", avatarSeed: "f".repeat(32), provider: "openai", model: "gpt-5.6-luna", reasoningLevel: "high", serviceTier: "default" });
    const planned = { projectId: f.project.id, title: "Combined", description: "Plan twice", idempotencyKey: "combined-1", workflow: "competing_plans", advisorProfileIds: { planner_b: review.id, planner_a: "profile_native_root" } };
    const first = await f.app.inject({ method: "POST", url, headers: f.headers, payload: planned });
    expect(first.statusCode, first.body).toBe(201);
    expect(first.json().advisorProfiles).toEqual({ planner_a: expect.objectContaining({ profileId: "profile_native_root" }), planner_b: expect.objectContaining({ profileId: review.id, reasoningLevel: "high" }) });
    const reordered = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...planned, advisorProfileIds: { planner_a: "profile_native_root", planner_b: review.id } } });
    expect(reordered.statusCode).toBe(200);
    expect(reordered.json().id).toBe(first.json().id);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { ...planned, advisorProfileIds: { planner_a: "profile_native_root" } } })).statusCode).toBe(409);
    f.profiles.update(f.userId, review.id, { reasoningLevel: "low" });
    expect(f.tasks.getTask(f.userId, first.json().id).advisorProfiles.planner_b?.reasoningLevel).toBe("high");

    const defaulted = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { projectId: f.project.id, title: "Reviewed", description: "Second opinion", idempotencyKey: "review-1", workflow: "independent_review", rootProfileId: review.id } });
    expect(defaulted.statusCode, defaulted.body).toBe(201);
    expect(defaulted.json().advisorProfiles.reviewer.profileId).toBe(review.id);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { projectId: f.project.id, title: "Wrong role", description: "Worker as reviewer", idempotencyKey: "review-2", workflow: "independent_review", advisorProfileIds: { reviewer: "profile_native_worker" } } })).statusCode).toBe(422);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { projectId: f.project.id, title: "Wrong role", description: "Rater on review", idempotencyKey: "review-3", workflow: "independent_review", advisorProfileIds: { rater: review.id } } })).statusCode).toBe(422);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { projectId: f.project.id, title: "Unknown", description: "Unknown workflow", idempotencyKey: "review-4", workflow: "fast" } })).statusCode).toBe(422);
  } finally { await f.close(); }
});

test("repair tasks require an open same-repository pull request and the fixed target through HTTP and the service", async () => {
  const f = await nativeApp();
  try {
    const url = `/api/companies/${f.company.id}/tasks`;
    const base = { projectId: f.project.id, title: "Repair", description: "Repair the pull request", workflow: "refine_pull_request" };
    const post = (payload: Record<string, unknown>) => f.app.inject({ method: "POST", url, headers: f.headers, payload });
    expect((await post({ ...base, idempotencyKey: "repair-no-source" })).statusCode).toBe(422);
    expect((await post({ ...base, idempotencyKey: "repair-branch", source: { kind: "branch", branch: "feature" } })).statusCode).toBe(422);
    expect((await post({ ...base, idempotencyKey: "repair-target", source: { kind: "pull_request", number: 7 }, deliveryTarget: "pull_request_ready" })).statusCode).toBe(422);
    expect((await post({ ...base, idempotencyKey: "repair-tests", source: { kind: "pull_request", number: 7 }, runProjectTests: false })).statusCode).toBe(422);
    expect(f.tasks.listTasks(f.userId)).toEqual([]);
    const pull = { number: 7, url: "https://github.com/owner/repo/pull/7", repository: "owner/repo", headBranch: "feature", baseBranch: "main", headSha: sha("b"), baseSha: sha("a"), isDraft: true, state: "open" as const, mergedAt: null };
    const service = new (await import("../src/tasks/tasks.js")).TaskService(f.database, f.auth, {
      getProject: f.projects.getProject.bind(f.projects), getProjectInCompany: f.projects.getProjectInCompany.bind(f.projects),
      captureTaskConfiguration: async () => ({ baseSha: sha("a") }),
      resolveTaskSource: async (_project, selector) => {
        if (selector.kind !== "pull_request") throw new Error("unexpected");
        if (selector.number === 8) throw new (await import("../src/tasks/sources.js")).TaskSourceFailure("source-pull-request-closed", "The pull request is not open");
        if (selector.number === 9) throw new (await import("../src/tasks/sources.js")).TaskSourceFailure("source-unsupported-fork", "Fork pull requests cannot be used as task sources");
        return { kind: "pull_request", ...pull };
      },
    }, f.config);
    await expect(service.createTask(f.userId, f.company.id, { ...base, workflow: "refine_pull_request", idempotencyKey: "repair-closed", source: { kind: "pull_request", number: 8 } })).rejects.toMatchObject({ code: "source-pull-request-closed" });
    await expect(service.createTask(f.userId, f.company.id, { ...base, workflow: "refine_pull_request", idempotencyKey: "repair-fork", source: { kind: "pull_request", number: 9 } })).rejects.toMatchObject({ code: "source-unsupported-fork" });
    await expect(service.createTask(f.userId, f.company.id, { ...base, workflow: "refine_pull_request", idempotencyKey: "repair-explicit", source: { kind: "pull_request", number: 7 }, deliveryTarget: "merged", runProjectTests: false })).rejects.toMatchObject({ statusCode: 422 });
    const { task } = await service.createTask(f.userId, f.company.id, { ...base, workflow: "refine_pull_request", idempotencyKey: "repair-ok", source: { kind: "pull_request", number: 7 } });
    expect(task).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", configuration: { runProjectTests: true, branch: "feature", baseBranch: "main", startingSha: sha("b"), baselineSha: sha("a") }, advisorProfiles: { rater: { profileId: "profile_native_root" } } });
    expect(service.repository.controls.get(task.id).deliveryIntent.pullRequestNumber).toBe(7);
    const issued = f.hermes.create(f.userId, { name: "Hermes Bot", companyId: f.company.id, projectIds: [f.project.id] });
    const credential = f.hermes.exchange({ pairingCode: issued.pairingCode, profileId: "profile-bot" }).credential;
    const hermes = await f.app.inject({ method: "POST", url: "/api/hermes/tasks", headers: { Authorization: `Bearer ${credential}` }, payload: { projectId: f.project.id, title: "Hermes", description: "Restricted", idempotencyKey: "hermes-standard", workflow: "refine_pull_request", deliveryTarget: "merged" } });
    expect(hermes.statusCode, hermes.body).toBe(201);
    expect(f.tasks.getTask(f.userId, hermes.json().id)).toMatchObject({ workflow: "standard", deliveryTarget: "pull_request_draft", advisorProfiles: {} });
  } finally { await f.close(); }
});

test("templates round-trip workflow selections, switch to repair with its defaults, and parse old JSON as Standard", async () => {
  const f = await nativeApp();
  try {
    const url = `/api/projects/${f.project.id}/task-templates`;
    const created = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { name: "Second opinion", description: "Review twice", deliveryTarget: "pull_request_ready", runProjectTests: false, visualEvidence: "off", workflow: "independent_review", advisorProfileIds: { reviewer: "profile_native_root" } } });
    expect(created.statusCode, created.body).toBe(201);
    expect(created.json()).toMatchObject({ workflow: "independent_review", advisorProfileIds: { reviewer: "profile_native_root" } });
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { name: "Wrong advisor", description: "x", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", workflow: "direct_build", advisorProfileIds: { reviewer: "profile_native_root" } } })).statusCode).toBe(422);
    expect((await f.app.inject({ method: "POST", url, headers: f.headers, payload: { name: "Repair wrong target", description: "x", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", workflow: "refine_pull_request" } })).statusCode).toBe(422);
    const repair = await f.app.inject({ method: "POST", url, headers: f.headers, payload: { name: "Repair", description: "Repair", visualEvidence: "off", workflow: "refine_pull_request" } });
    expect(repair.statusCode, repair.body).toBe(201);
    expect(repair.json()).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true });
    const id = created.json().id;
    const switched = await f.app.inject({ method: "PATCH", url: `/api/task-templates/${id}`, headers: f.headers, payload: { workflow: "refine_pull_request" } });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json()).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true, advisorProfileIds: {} });
    expect((await f.app.inject({ method: "PATCH", url: `/api/task-templates/${id}`, headers: f.headers, payload: { deliveryTarget: "pull_request_ready" } })).statusCode).toBe(422);
    const back = await f.app.inject({ method: "PATCH", url: `/api/task-templates/${id}`, headers: f.headers, payload: { workflow: "direct_build", deliveryTarget: "remote_branch" } });
    expect(back.json()).toMatchObject({ workflow: "direct_build", deliveryTarget: "remote_branch", runProjectTests: true });
    const preserved = await f.app.inject({ method: "PATCH", url: `/api/task-templates/${id}`, headers: f.headers, payload: { workflow: "independent_review" } });
    expect(preserved.json()).toMatchObject({ workflow: "independent_review", deliveryTarget: "remote_branch" });
    const stamp = new Date().toISOString();
    f.database.authTransaction(db => db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES ('template_old', ?, 'Old', ?, ?, ?)").run(f.project.id, JSON.stringify({ name: "Old", description: "Pre-workflow template", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" }), stamp, stamp));
    expect(f.templates.list(f.userId, f.project.id).find(template => template.id === "template_old")).toMatchObject({ workflow: "standard", advisorProfileIds: {} });
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Save me", description: "As template", idempotencyKey: "save-template", workflow: "competing_plans", advisorProfileIds: { planner_a: "profile_native_root" } });
    const saved = await f.app.inject({ method: "POST", url: `/api/tasks/${task.id}/save-as-template`, headers: f.headers, payload: { name: "From task" } });
    expect(saved.statusCode, saved.body).toBe(201);
    expect(saved.json()).toMatchObject({ workflow: "competing_plans", advisorProfileIds: { planner_a: "profile_native_root", planner_b: "profile_native_root" } });
  } finally { await f.close(); }
});

test("a populated pre-workflow database keeps sessions, claims, turns, and templates and parses old tasks as Standard", async () => {
  const root = await mkdtemp(join(tmpdir(), "forge-workflows-migration-"));
  const repositoryRoot = process.cwd();
  const filename = join(root, "forge.sqlite");
  try {
    await cp(join(repositoryRoot, "drizzle"), join(root, "drizzle"), { recursive: true, filter: source => !source.endsWith(".sql") || basename(source) < "20260906224011461_workflows.sql" });
    process.chdir(root);
    const legacy = new ForgeDatabase(filename);
    const now = "2026-09-01T00:00:00.000Z";
    legacy.authTransaction(db => {
      db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'User', 'user', 'admin', 'active', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company', 'active', ?)").run(now);
      db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project', '/repo', '/worktrees', 'acme/forge', 'main', '', '', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, description, configuration_json, idempotency_key, request_hash, creator_user_id, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Old', 'Old task', ?, 'key', 'hash', 'user_1', ?, ?)").run(JSON.stringify({ repository: "acme/forge", repositoryPath: "/repo", worktreeRoot: "/worktrees", branch: "task", baseBranch: "main", baselineSha: sha("a"), startingSha: sha("a"), setupCommand: "", verificationCommand: "", runProjectTests: true, visualEvidence: "off", source: null, capturedAt: now }), now, now);
      const profile = JSON.stringify({ profileId: "profile_native_root", provider: "openai", model: "gpt-5.6-sol", reasoningLevel: "medium", serviceTier: "default" });
      db.prepare("INSERT INTO forge_task_controls (task_id, objective, delivery_target, delivery_intent_json, status, root_session_id, root_profile_json, worker_profile_json, created_at, updated_at) VALUES ('task_1', 'Old', 'pull_request_draft', ?, 'active', 'session_1', ?, ?, ?, ?)").run(JSON.stringify({ repository: "acme/forge", headBranch: "task", baseBranch: "main", baselineSha: sha("a"), pullRequestNumber: null }), profile, profile, now, now);
      db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, native_session_id, lifecycle, launch_owner, launch_owner_pid, launch_owner_start_time, stop_requested_at, created_at, updated_at) VALUES ('session_1', 'task_1', 'root', 1, 1, 'ses_old', 'live', 'owner', 4242, 'start', NULL, ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, native_session_id, lifecycle, stop_requested_at, created_at, updated_at) VALUES ('session_2', 'task_1', 'worker', 1, 1, 'ses_worker', 'stopped', ?, ?, ?)").run(now, now, now);
      db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES ('turn_1', 'task_1', 'session_1', 1, 'h', 'Pending prompt', 'pending_prompt', ?, ?)").run(now, now);
      db.prepare("INSERT INTO forge_task_templates (id, project_id, name, configuration_json, created_at, updated_at) VALUES ('template_1', 'project_1', 'Old template', ?, ?, ?)").run(JSON.stringify({ name: "Old template", description: "Old", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" }), now, now);
    });
    legacy.close();
    process.chdir(repositoryRoot);
    const current = new ForgeDatabase(filename);
    try {
      expect(current.schemaStatus().state).toBe("current");
      const store = new TaskControlStore(current);
      expect(store.get("task_1")).toMatchObject({ workflow: "standard", advisorProfiles: {}, workflowState: { version: 1, reviews: [], toolOwner: null }, rootSessionId: "session_1" });
      expect(store.currentSession("task_1", "root")).toMatchObject({ nativeSessionId: "ses_old", lifecycle: "live", launchOwner: "owner", launchOwnerPid: 4242, launchOwnerStartTime: "start", advisorRole: null, workflowInput: null });
      expect(store.currentSession("task_1", "worker")).toMatchObject({ nativeSessionId: "ses_worker", stopRequestedAt: now, stoppedAt: null });
      expect(store.pendingTurns("session_1")).toMatchObject([{ id: "turn_1", status: "pending_prompt", promptText: "Pending prompt" }]);
      expect(current.authQuery(db => db.prepare("SELECT configuration_json FROM forge_task_templates WHERE id = 'template_1'").get())).toEqual({ configuration_json: JSON.stringify({ name: "Old template", description: "Old", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" }) });
    } finally { current.close(); }
    const empty = new ForgeDatabase(join(root, "empty.sqlite"));
    try { expect(empty.schemaStatus().state).toBe("current"); } finally { empty.close(); }
  } finally {
    process.chdir(repositoryRoot);
    await rm(root, { recursive: true, force: true });
  }
});

test("implementation Workers are told to commit and verification Workers are told not to", () => {
  for (const mode of ["planned", "direct"] as const) {
    expect(workerAssignmentPreamble(mode, "implementation")).toContain(IMPLEMENTATION_COMMIT_PROMPT);
    expect(workerAssignmentPreamble(mode, "implementation")).toContain("For configured verification commands, set a 30-minute shell timeout, or the tool maximum if lower. Normal completion ends the command immediately.");
    expect(workerAssignmentPreamble(mode, "verification")).toContain(VERIFICATION_WORKER_PROMPT);
    expect(workerAssignmentPreamble(mode, "verification")).toContain("For configured verification commands, set a 30-minute shell timeout, or the tool maximum if lower. Normal completion ends the command immediately.");
    expect(workerAssignmentPreamble(mode, "verification")).not.toContain(IMPLEMENTATION_COMMIT_PROMPT);
  }
});

test("Coordinator and implementation prompts share one Worker ownership boundary", () => {
  const context = { configuration: { visualEvidence: "off" as const }, images: [] };
  for (const workflow of ["standard", "direct_build", "independent_review", "competing_plans", "refine_pull_request"] as const) {
    const coordinator = initialCoordinatorPrompt({ objective: "Complete the change", deliveryTarget: "pull_request_draft", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", pullRequestNumber: workflow === "refine_pull_request" ? 7 : null }, workflow }, context);
    expect(coordinator).toContain("The Worker owns design and implementation choices within the accepted scope");
    expect(coordinator).toContain("End your turn after successful delegation");
    expect(coordinator).not.toMatch(/Do not delegate planning, design decisions|file-by-file or test-by-test slices.*Delegate/);
  }

  for (const mode of ["planned", "direct"] as const) {
    const worker = workerAssignmentPreamble(mode, "implementation");
    expect(worker).toContain("routine internal seams, fixture corrections, and tests");
    expect(worker).toContain("Continue until the complete assignment and its necessary checks are done");
    expect(worker).not.toMatch(/Coordinator owns planning, design decisions|Return missing design decisions|Do not take over task planning/);
  }
});

test("prompt assignments explain the Screenshots setting", () => {
  const control = (workflow: "standard" | "independent_review") => ({ objective: "Update a button", deliveryTarget: "pull_request_draft", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", pullRequestNumber: null }, workflow });
  const context = { configuration: { visualEvidence: "off" as const }, images: [] };
  const standard = initialCoordinatorPrompt(control("standard"), context);
  const independentReview = initialCoordinatorPrompt(control("independent_review"), context);
  const worker = composeWorkerAssignment({ mode: "planned", purpose: "implementation", plan: "Make the update", acceptanceCriteria: ["The button is updated"], instruction: "Implement the plan.", visualEvidence: "off" });
  const advisor = composeAdvisorAssignment({ role: "reviewer", objective: "Update a button", configuration: context.configuration, visualEvidence: "off", images: [], repository: "owner/repo", headBranch: "task", baseBranch: "main", pullRequestNumber: null, range, evidenceDirectory: "/tmp/evidence", attachments: [], brief: "Plan and criteria", priorFindings: null, repairEvidence: null });
  for (const prompt of [standard, independentReview, worker, advisor]) expect(prompt).toContain("Screenshots are off for this task");
  expect(standard).not.toContain("Require browser evidence when requested");
  expect(independentReview).not.toContain("Require browser evidence when requested");
  expect(composeWorkerAssignment({ mode: "planned", purpose: "implementation", plan: "Make the update", acceptanceCriteria: [], instruction: "Implement the plan.", visualEvidence: "required" })).toContain("Screenshots are necessary for this task");
});

test("Coordinator prompts reuse relevant checks and Advisor prompts assess implementation-turn source evidence", () => {
  const control = { objective: "Add one type import", deliveryTarget: "pull_request_draft", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", pullRequestNumber: null }, workflow: "independent_review" as const };
  const context = { configuration: { visualEvidence: "off" as const, runProjectTests: true, verificationCommand: "pnpm test" }, images: [] };
  const coordinator = initialCoordinatorPrompt(control, context);
  expect(coordinator).toContain("When runProjectTests is true, the configured project checks are required before delivery");
  expect(coordinator).toContain("affected checks during development");
  expect(coordinator).toContain("Reuse successful check evidence");
  expect(coordinator).not.toMatch(/every Worker assignment.*configured verification command/i);

  const advisor = composeAdvisorAssignment({ role: "reviewer", objective: control.objective, configuration: { runProjectTests: true, verificationCommand: "pnpm test" }, visualEvidence: "off", images: [], repository: "owner/repo", headBranch: "task", baseBranch: "main", pullRequestNumber: null, range, evidenceDirectory: "/tmp/evidence", attachments: [], brief: "Plan and criteria", priorFindings: null, repairEvidence: null });
  expect(advisor).toContain("implementation or historical turns");
  expect(advisor).toContain("actual native command inputs and outputs");
  expect(advisor).toContain("Git source-state evidence");
  expect(advisor).toContain("Missing verificationRange is not proof that a check is invalid");
  expect(advisor).toContain("dirty edits after a check");
  expect(advisor).not.toContain("implementation turns, older turns) do not establish");
});

test("workflow state with review records encodes for task API responses", () => {
  const range = { baseSha: "a".repeat(40), headSha: "b".repeat(40), files: ["src.ts"], commits: ["b".repeat(40)] };
  const result = { role: "rater" as const, rating: 8, blockingFindings: ["src.ts: null deref"], verification: "missing" as const, verificationSummary: "no checks", summary: "repair" };
  const record: ReviewRecord = { sessionId: "s", turnId: "t", role: "rater", range, invalidReason: null, recordedAt: "2026-09-07T00:00:00.000Z", result };
  expect(z.encode(PublicWorkflowStateSchema, { version: 1, reviews: [record], acceptedDelivery: null, deliveryWait: null, completion: null })).toMatchObject({ reviews: [{ result: { rating: 8 } }] });
});
