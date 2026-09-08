import { expect, test } from "vitest";

import { GithubReleaseFailure } from "../src/integrations/github/delivery.js";
import type { GithubTriggerPort } from "../src/integrations/github/trigger-inspection.js";
import { nativeApp } from "./helpers/native-app.js";

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(next => { resolve = next; });
  return { promise, resolve };
}

const trigger = (candidates: number[] = []): GithubTriggerPort => ({
  async observeRepository(input) { return { id: 9, fullName: input.repository }; },
  async validateLabel() {},
  async listOpenPullRequestsByLabel() { return candidates.map(number => ({ number })); },
  async inspectPullRequest(input) { return { number: input.number, url: `https://github.com/owner/repo/pull/${input.number}`, title: "Candidate", state: "open", isDraft: false, labels: ["ready"], changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [] }; },
});

test("creates disabled rules with the actor as authority and allows Check now without task creation", async () => {
  const f = await nativeApp({ githubTrigger: trigger() });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Trigger", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const payload = { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: ["src/"] };
    const created = await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers`, headers: f.headers, payload });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ enabled: false, authorityUserId: f.userId, repositoryId: 9 });
    const before = f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count;
    const checked = await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers/${created.json().id}/check`, headers: f.headers });
    expect(checked.statusCode).toBe(200);
    expect(checked.json()).toEqual({ activity: [] });
    expect(f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count).toBe(before);
  } finally { await f.close(); }
});

test("rejects public authority injection and prevents cross-company reads", async () => {
  const f = await nativeApp({ githubTrigger: trigger() });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Trigger", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const payload = { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [], authorityUserId: "other" };
    const rejected = await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers`, headers: f.headers, payload });
    expect(rejected.statusCode).toBe(400);
    const other = f.auth.createCompany(f.userId, "Other");
    const listed = await f.app.inject({ method: "GET", url: `/api/companies/${other.id}/github-triggers`, headers: f.headers });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toEqual({ rules: [] });
  } finally { await f.close(); }
});

test("records protected-path and wrong-base exclusions without creating tasks", async () => {
  const provider = trigger([7]);
  provider.inspectPullRequest = async input => ({ number: input.number, url: "https://github.com/owner/repo/pull/7", title: "Candidate", state: "open", isDraft: false, labels: ["ready"], changedFiles: 1, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "release", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [{ sha: "c", filename: "src/new.ts", status: "renamed", additions: 1, deletions: 0, changes: 1, blobUrl: "https://github.com/a", rawUrl: "https://github.com/a", contentsUrl: "https://github.com/a", previousFilename: "src/old.ts" }] });
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Trigger", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const created = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: ["src/"] });
    await f.githubTriggers.update(f.userId, f.company.id, created.id, { enabled: true, expectedRevision: created.revision });
    const checked = await f.githubTriggers.check(f.userId, f.company.id, created.id);
    expect(checked[0]).toMatchObject({ outcome: "excluded", reason: "The pull request targets a different base branch.", matchingPaths: ["src/new.ts", "src/old.ts"] });
  } finally { await f.close(); }
});

test("retains candidate observations when a later inspection fails", async () => {
  const provider = trigger([7, 8]);
  provider.inspectPullRequest = async input => {
    if (input.number === 8) throw new Error("unavailable");
    return { number: 7, url: "https://github.com/owner/repo/pull/7", title: "Candidate", state: "open", isDraft: false, labels: ["ready"], changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [] };
  };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Trigger", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const created = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    await expect(f.githubTriggers.check(f.userId, f.company.id, created.id)).rejects.toMatchObject({ statusCode: 502 });
    expect(f.githubTriggers.activity(f.userId, f.company.id, created.id)).toMatchObject([{ pullRequestNumber: 7, outcome: "eligible" }, { pullRequestNumber: 8, outcome: "error" }]);
  } finally { await f.close(); }
});

test("excludes pull requests whose immutable repository identity does not match", async () => {
  const provider = trigger([7]);
  provider.inspectPullRequest = async input => ({ number: input.number, url: "https://github.com/owner/repo/pull/7", title: "Candidate", state: "open", isDraft: false, labels: ["ready"], changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 10, fullName: "owner/repo" }, isCrossRepository: false, files: [] });
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Trigger", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    await expect(f.githubTriggers.check(f.userId, f.company.id, rule.id)).resolves.toMatchObject([{ outcome: "excluded", reason: "The pull request repository does not match this rule." }]);
  } finally { await f.close(); }
});

test("retains the latest provider retry time after candidate failures", async () => {
  const retryAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const provider = trigger([7]);
  provider.inspectPullRequest = async () => { throw new GithubReleaseFailure("provider-rate-limited", "rate limited", retryAt); };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Trigger", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    await expect(f.githubTriggers.check(f.userId, f.company.id, rule.id)).rejects.toMatchObject({ statusCode: 502 });
    expect(f.githubTriggers.repository.get(f.company.id, rule.id)).toMatchObject({ nextRetryAt: retryAt, lastSuccessfulCheckAt: null });
  } finally { await f.close(); }
});

test.each([
  ["configuring authority is disabled", async (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_users SET status = 'revoked' WHERE id = ?").run(f.userId)); }],
  ["company is paused", async (f: Awaited<ReturnType<typeof nativeApp>>) => { f.auth.setCompanyStatus(f.userId, f.company.id, "paused"); }],
  ["effective preset changes", async (f: Awaited<ReturnType<typeof nativeApp>>, workflowId: string) => { f.workflows.update(f.userId, workflowId, { runProjectTests: false }); }],
  ["project base branch changes", async (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_projects SET base_branch = 'release' WHERE id = ?").run(f.project.id)); }],
  ["project repository changes", async (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_projects SET repository_identity = 'owner/other' WHERE id = ?").run(f.project.id)); }],
  ["resolved profile changes", async (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_profiles SET model = 'changed', updated_at = ? WHERE id = ?").run(new Date().toISOString(), f.project.rootProfileId)); }],
])("rejects preview when %s during candidate inspection", async (_name, mutate) => {
  const started = deferred();
  const release = deferred();
  const provider = trigger([7]);
  provider.inspectPullRequest = async input => {
    started.resolve();
    await release.promise;
    return { number: input.number, url: "https://github.com/owner/repo/pull/7", title: "Candidate", state: "open", isDraft: false, labels: ["ready"], changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [] };
  };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Race", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const check = f.githubTriggers.check(f.userId, f.company.id, rule.id);
    await started.promise;
    await mutate(f, workflow.id);
    release.resolve();
    await expect(check).rejects.toBeInstanceOf(Error);
    expect(f.githubTriggers.repository.get(f.company.id, rule.id)).toMatchObject({ lastSuccessfulCheckAt: null, latestError: expect.any(String) });
    expect(f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count).toBe(0);
  } finally { await f.close(); }
});

const irrelevantChanges = [
  ["user display name", (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_users SET display_name = 'Renamed user', updated_at = ? WHERE id = ?").run(new Date().toISOString(), f.userId)); }],
  ["company display name", (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_companies SET name = 'Renamed company' WHERE id = ?").run(f.company.id)); }],
  ["project display name", (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_projects SET name = 'Renamed project', updated_at = ? WHERE id = ?").run(new Date().toISOString(), f.project.id)); }],
  ["workflow display name", (f: Awaited<ReturnType<typeof nativeApp>>, workflowId: string) => { f.database.authQuery(db => db.prepare("UPDATE forge_workflows SET name = 'Renamed workflow', updated_at = ? WHERE id = ?").run(new Date().toISOString(), workflowId)); }],
  ["profile update time", (f: Awaited<ReturnType<typeof nativeApp>>) => { f.database.authQuery(db => db.prepare("UPDATE forge_profiles SET updated_at = ? WHERE id = ?").run(new Date(Date.now() + 1_000).toISOString(), f.project.rootProfileId)); }],
  ["overridden workflow delivery target", (f: Awaited<ReturnType<typeof nativeApp>>, workflowId: string) => { f.workflows.update(f.userId, workflowId, { deliveryTarget: "merged" }); }],
  ["overridden project profile default", (f: Awaited<ReturnType<typeof nativeApp>>) => {
    const alternate = f.profiles.create(f.userId, { name: "Alternate default", role: "root", avatarSeed: "f".repeat(32), provider: "openai", model: "gpt-5.6-luna", reasoningLevel: "medium", serviceTier: "default" });
    f.database.authQuery(db => db.prepare("UPDATE forge_projects SET root_profile_id = ?, updated_at = ? WHERE id = ?").run(alternate.id, new Date().toISOString(), f.project.id));
  }],
] as const;

test.each(["preview", "create", "update"].flatMap(operation => irrelevantChanges.map(([change, mutate]) => [operation, change, mutate] as const)))("allows %s when only the %s changes during provider work", async (operation, _change, mutate) => {
  const started = deferred();
  const release = deferred();
  let block = false;
  const provider = trigger(operation === "preview" ? [7] : []);
  provider.observeRepository = async input => {
    if (block && operation !== "preview") { started.resolve(); await release.promise; }
    return { id: 9, fullName: input.repository };
  };
  provider.inspectPullRequest = async input => {
    if (block && operation === "preview") { started.resolve(); await release.promise; }
    return { number: input.number, url: "https://github.com/owner/repo/pull/7", title: "Candidate", state: "open", isDraft: false, labels: ["ready"], changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [] };
  };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Metadata race", description: "", engine: "standard", deliveryTarget: "pull_request_draft", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
    const input = { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft" as const, protectedPaths: [] };
    const rule = operation === "create" ? null : await f.githubTriggers.create(f.userId, f.company.id, input);
    block = true;
    const pending = operation === "preview"
      ? f.githubTriggers.check(f.userId, f.company.id, rule!.id)
      : operation === "create"
        ? f.githubTriggers.create(f.userId, f.company.id, input)
        : f.githubTriggers.update(f.userId, f.company.id, rule!.id, { name: "Changed", expectedRevision: rule!.revision });
    await started.promise;
    mutate(f, workflow.id);
    release.resolve();
    await expect(pending).resolves.toBeDefined();
    if (operation === "create") expect(f.githubTriggers.repository.list(f.company.id)).toHaveLength(1);
    if (operation === "update") expect(f.githubTriggers.repository.get(f.company.id, rule!.id)).toMatchObject({ name: "Changed", revision: rule!.revision + 1 });
    if (operation === "preview") expect(f.githubTriggers.repository.get(f.company.id, rule!.id)?.lastSuccessfulCheckAt).not.toBeNull();
  } finally { await f.close(); }
});

test("does not create a rule when the project changes during repository observation", async () => {
  const started = deferred();
  const release = deferred();
  const provider = trigger();
  provider.observeRepository = async input => { started.resolve(); await release.promise; return { id: 9, fullName: input.repository }; };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Race", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const created = f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    await started.promise;
    f.database.authQuery(db => db.prepare("UPDATE forge_projects SET base_branch = 'release' WHERE id = ?").run(f.project.id));
    release.resolve();
    await expect(created).rejects.toMatchObject({ statusCode: 409 });
    expect(f.githubTriggers.repository.list(f.company.id)).toEqual([]);
  } finally { await f.close(); }
});

test("preserves a rule when its preset changes during repository observation", async () => {
  const started = deferred();
  const release = deferred();
  let block = false;
  const provider = trigger();
  provider.observeRepository = async input => { if (block) { started.resolve(); await release.promise; } return { id: 9, fullName: input.repository }; };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Race", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Original", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    block = true;
    const updated = f.githubTriggers.update(f.userId, f.company.id, rule.id, { name: "Changed", expectedRevision: rule.revision });
    await started.promise;
    f.workflows.update(f.userId, workflow.id, { runProjectTests: false });
    release.resolve();
    await expect(updated).rejects.toMatchObject({ statusCode: 409 });
    expect(f.githubTriggers.repository.get(f.company.id, rule.id)).toMatchObject({ name: "Original", revision: rule.revision });
  } finally { await f.close(); }
});

test("serializes overlapping checks, recovers after failure, and retains failure activity", async () => {
  const started = deferred();
  const release = deferred();
  let inspections = 0;
  let maximum = 0;
  let attempts = 0;
  const provider = trigger([7]);
  provider.inspectPullRequest = async input => {
    inspections += 1;
    maximum = Math.max(maximum, inspections);
    started.resolve();
    await release.promise;
    inspections -= 1;
    attempts += 1;
    if (attempts === 1) throw new Error("temporary failure");
    return { number: input.number, url: "https://github.com/owner/repo/pull/7", title: "Candidate", state: "open", isDraft: false, labels: ["ready"], changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [] };
  };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Queue", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const first = f.githubTriggers.check(f.userId, f.company.id, rule.id);
    const second = f.githubTriggers.check(f.userId, f.company.id, rule.id);
    await started.promise;
    release.resolve();
    await expect(first).rejects.toMatchObject({ statusCode: 502 });
    await expect(second).resolves.toMatchObject([{ outcome: "eligible" }]);
    expect(maximum).toBe(1);
    expect(f.githubTriggers.repository.activity(f.company.id, rule.id)).toHaveLength(2);
  } finally { await f.close(); }
});

test("rejects a stale concurrent update without overwriting the committed rule", async () => {
  const started = deferred();
  const release = deferred();
  let block = false;
  const provider = trigger();
  provider.observeRepository = async input => { if (block) { block = false; started.resolve(); await release.promise; } return { id: 9, fullName: input.repository }; };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Conflict", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Original", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    block = true;
    const stale = f.githubTriggers.update(f.userId, f.company.id, rule.id, { name: "Stale", expectedRevision: rule.revision });
    await started.promise;
    const fresh = await f.githubTriggers.update(f.userId, f.company.id, rule.id, { name: "Fresh", expectedRevision: rule.revision });
    release.resolve();
    await expect(stale).rejects.toMatchObject({ statusCode: 409 });
    expect(f.githubTriggers.repository.get(f.company.id, rule.id)).toMatchObject({ name: "Fresh", revision: fresh.revision });
  } finally { await f.close(); }
});

test("archives and restores rules without enabling them or losing activity", async () => {
  const f = await nativeApp({ githubTrigger: trigger([7]) });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Archive", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    await f.githubTriggers.check(f.userId, f.company.id, rule.id);
    const archived = await f.githubTriggers.update(f.userId, f.company.id, rule.id, { archived: true, expectedRevision: f.githubTriggers.repository.get(f.company.id, rule.id)?.revision ?? rule.revision });
    await expect(f.githubTriggers.update(f.userId, f.company.id, rule.id, { archived: false, enabled: true, expectedRevision: archived.revision })).rejects.toMatchObject({ statusCode: 422 });
    const restored = await f.githubTriggers.update(f.userId, f.company.id, rule.id, { archived: false, expectedRevision: archived.revision });
    expect(restored).toMatchObject({ archivedAt: null, enabled: false });
    expect(f.githubTriggers.repository.activity(f.company.id, rule.id)).toMatchObject([{ pullRequestNumber: 7, outcome: "eligible" }]);
  } finally { await f.close(); }
});

test("requires an authenticated session and scopes rules to their company", async () => {
  const f = await nativeApp({ githubTrigger: trigger() });
  try {
    expect((await f.app.inject({ method: "GET", url: `/api/companies/${f.company.id}/github-triggers` })).statusCode).toBe(401);
    const workflow = f.workflows.create(f.userId, { name: "Scope", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const other = f.auth.createCompany(f.userId, "Other");
    expect((await f.app.inject({ method: "POST", url: `/api/companies/${other.id}/github-triggers/${rule.id}/check`, headers: f.headers })).statusCode).toBe(404);
  } finally { await f.close(); }
});

test("excludes delivery-intent ownership in another company until its task is cancelled", async () => {
  const f = await nativeApp({ githubTrigger: trigger([7]) });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Ownership", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const other = f.auth.createCompany(f.userId, "Owner");
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Private owner", description: "Private", startImmediately: false, idempotencyKey: "cross-owner" });
    f.database.authQuery(db => {
      db.prepare("UPDATE forge_tasks SET company_id = ? WHERE id = ?").run(other.id, task.id);
      db.prepare("UPDATE forge_task_controls SET status = 'active', delivery_intent_json = ? WHERE task_id = ?").run(JSON.stringify({ repository: "owner/repo", headBranch: "feature", baseBranch: "main", baselineSha: "a".repeat(40), pullRequestNumber: 7 }), task.id);
    });
    await expect(f.githubTriggers.check(f.userId, f.company.id, rule.id)).resolves.toMatchObject([{ outcome: "excluded", reason: "A task already uses this pull request." }]);
    expect(JSON.stringify(f.githubTriggers.activity(f.userId, f.company.id, rule.id))).not.toContain(task.id);
    f.database.authQuery(db => db.prepare("UPDATE forge_task_controls SET status = 'cancelled' WHERE task_id = ?").run(task.id));
    await expect(f.githubTriggers.check(f.userId, f.company.id, rule.id)).resolves.toMatchObject([{ outcome: "eligible" }]);
  } finally { await f.close(); }
});

test("excludes adopted ownership in another company until the task is delivered", async () => {
  const f = await nativeApp({ githubTrigger: trigger([7]) });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Adopted", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const other = f.auth.createCompany(f.userId, "Adopter");
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Private adopted", description: "Private", startImmediately: false, idempotencyKey: "cross-adopted" });
    f.database.authQuery(db => {
      db.prepare("UPDATE forge_tasks SET company_id = ? WHERE id = ?").run(other.id, task.id);
      db.prepare("UPDATE forge_task_controls SET status = 'active', delivery_intent_json = ?, pull_request_json = ? WHERE task_id = ?").run(JSON.stringify({ repository: "owner/repo", headBranch: "feature", baseBranch: "main", baselineSha: "a".repeat(40), pullRequestNumber: null }), JSON.stringify({ repository: "owner/repo", number: 7, url: "https://github.com/owner/repo/pull/7", headSha: "a".repeat(40), state: "open", mergedAt: null }), task.id);
    });
    await expect(f.githubTriggers.check(f.userId, f.company.id, rule.id)).resolves.toMatchObject([{ outcome: "excluded", reason: "A task already uses this pull request." }]);
    f.database.authQuery(db => db.prepare("UPDATE forge_task_controls SET status = 'delivered' WHERE task_id = ?").run(task.id));
    await expect(f.githubTriggers.check(f.userId, f.company.id, rule.id)).resolves.toMatchObject([{ outcome: "eligible" }]);
  } finally { await f.close(); }
});

test("allows exactly one concurrent enabled rule for a shared repository", async () => {
  const started = deferred();
  const release = deferred();
  let calls = 0;
  const provider = trigger();
  provider.observeRepository = async input => { calls += 1; if (calls > 2) { if (calls === 4) started.resolve(); await release.promise; } return { id: 9, fullName: input.repository }; };
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const other = f.auth.createCompany(f.userId, "Other rule");
    const projectId = "project_cross_company";
    f.database.authQuery(db => db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, created_at, updated_at) SELECT ?, ?, 'Repository B', repository_path || '-other', worktree_root || '-other', 'owner/other', base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, ?, ? FROM forge_projects WHERE id = ?").run(projectId, other.id, new Date().toISOString(), new Date().toISOString(), f.project.id));
    const workflow = f.workflows.create(f.userId, { name: "Unique", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const first = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "A", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const second = await f.githubTriggers.create(f.userId, other.id, { projectId, name: "B", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const results = [f.githubTriggers.update(f.userId, f.company.id, first.id, { enabled: true, expectedRevision: first.revision }), f.githubTriggers.update(f.userId, other.id, second.id, { enabled: true, expectedRevision: second.revision })];
    await started.promise;
    release.resolve();
    const settled = await Promise.allSettled(results);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toMatchObject([{ reason: { statusCode: 409 } }]);
    expect(f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_github_trigger_rules WHERE repository_id = 9 AND enabled = 1").get() as { count: number }).count).toBe(1);
  } finally { await f.close(); }
});

test("denies rule routes to an authenticated member without changing data", async () => {
  const f = await nativeApp({ githubTrigger: trigger() });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Member", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    f.database.authQuery(db => {
      db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES (?, ?, ?)").run(f.userId, f.company.id, new Date().toISOString());
      db.prepare("UPDATE forge_users SET role = 'member' WHERE id = ?").run(f.userId);
    });
    const payload = { projectId: f.project.id, name: "New", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] };
    expect((await f.app.inject({ method: "GET", url: `/api/companies/${f.company.id}/github-triggers`, headers: f.headers })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers`, headers: f.headers, payload })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers/${rule.id}/check`, headers: f.headers })).statusCode).toBe(403);
    expect(f.githubTriggers.repository.list(f.company.id)).toHaveLength(1);
    expect(f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count).toBe(0);
  } finally { await f.close(); }
});

test("rejects invalid-origin rule writes while permitting the valid session origin", async () => {
  const f = await nativeApp({ githubTrigger: trigger() });
  try {
    const workflow = f.workflows.create(f.userId, { name: "CSRF", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const payload = { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] };
    const invalid = { ...f.headers, origin: "https://invalid.example" };
    expect((await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers`, headers: invalid, payload })).statusCode).toBe(403);
    const created = await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers`, headers: f.headers, payload });
    expect(created.statusCode).toBe(201);
    expect((await f.app.inject({ method: "PATCH", url: `/api/companies/${f.company.id}/github-triggers/${created.json().id}`, headers: invalid, payload: { name: "Blocked", expectedRevision: created.json().revision } })).statusCode).toBe(403);
    expect((await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers`, payload })).statusCode).toBe(401);
    expect((await f.app.inject({ method: "POST", url: `/api/companies/${f.company.id}/github-triggers/${created.json().id}/check` })).statusCode).toBe(401);
  } finally { await f.close(); }
});

test("stops and archives a rule without provider access while preserving activity", async () => {
  const provider = trigger([7]);
  const f = await nativeApp({ githubTrigger: provider });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Stop", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    await f.githubTriggers.check(f.userId, f.company.id, rule.id);
    provider.observeRepository = async () => { throw new Error("provider unavailable"); };
    const current = f.githubTriggers.repository.get(f.company.id, rule.id)!;
    await expect(f.githubTriggers.update(f.userId, f.company.id, rule.id, { enabled: false, name: "Combined", expectedRevision: current.revision })).rejects.toMatchObject({ statusCode: 422 });
    const stopped = await f.githubTriggers.update(f.userId, f.company.id, rule.id, { enabled: false, expectedRevision: current.revision });
    await expect(f.githubTriggers.update(f.userId, f.company.id, rule.id, { archived: true, name: "Combined", expectedRevision: stopped.revision })).rejects.toMatchObject({ statusCode: 422 });
    const archived = await f.githubTriggers.update(f.userId, f.company.id, rule.id, { archived: true, expectedRevision: stopped.revision });
    const restored = await f.githubTriggers.update(f.userId, f.company.id, rule.id, { archived: false, expectedRevision: archived.revision });
    expect(restored).toMatchObject({ enabled: false, archivedAt: null });
    expect(f.githubTriggers.repository.activity(f.company.id, rule.id)).toMatchObject([{ pullRequestNumber: 7, outcome: "eligible" }]);
  } finally { await f.close(); }
});
