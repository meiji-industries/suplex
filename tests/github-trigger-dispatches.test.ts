import { expect, test } from "vitest";

import { GithubTriggerDispatchRepository } from "../src/integrations/github/trigger-dispatches.js";
import { ForgeDatabase } from "../src/platform/database.js";
import type { GithubTriggerPort } from "../src/integrations/github/trigger-inspection.js";
import { taskRequestHash } from "../src/tasks/repository.js";
import { nativeApp } from "./helpers/native-app.js";

const github: GithubTriggerPort = {
  async observeRepository(input) { return { id: 9, fullName: input.repository }; }, async validateLabel() {}, async listOpenPullRequestsByLabel() { return []; },
  async inspectPullRequest() { throw new Error("not used"); },
};

async function linkedFixture() {
  const f = await nativeApp({ githubTrigger: github });
  const workflow = f.workflows.create(f.userId, { name: "Link", description: "", engine: "standard", deliveryTarget: "pull_request_draft", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
  const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
  const repository = new GithubTriggerDispatchRepository(f.database);
  const profiles = { root: { profileId: "profile_native_root", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const }, worker: { profileId: "profile_native_worker", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const }, advisors: {} };
  const dispatch = repository.prepare({ ruleId: rule.id, companyId: f.company.id, projectId: f.project.id, repositoryId: 9, repositoryName: "owner/repo", pullRequestNumber: 7, authorityUserId: f.userId, request: { projectId: f.project.id, title: "Dispatch", description: "Dispatch", images: [], rootProfileId: profiles.root.profileId, workerProfileId: profiles.worker.profileId, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", source: { kind: "pull_request", number: 7 }, workflow: "standard", advisorProfileIds: {} }, policy: { headSha: "a".repeat(40), baseSha: "b".repeat(40), headBranch: "feature", baseBranch: "main", protectedPaths: [], repositoryId: 9, repositoryName: "owner/repo", deliveryTarget: "pull_request_draft" }, preset: workflow, profiles });
  const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Dispatch", description: "Dispatch", startImmediately: false, idempotencyKey: dispatch.idempotencyKey });
  const configuration = { repository: "owner/repo", repositoryPath: f.project.repositoryPath, worktreeRoot: f.project.worktreeRoot, branch: "feature", baseBranch: "main", baselineSha: "b".repeat(40), startingSha: "a".repeat(40), setupCommand: f.project.setupCommand, verificationCommand: f.project.verificationCommand, runProjectTests: true, visualEvidence: "off", source: { kind: "pull_request", number: 7 }, capturedAt: new Date().toISOString() };
  f.database.authQuery(db => db.prepare("UPDATE forge_tasks SET configuration_json = ?, request_hash = ? WHERE id = ?").run(JSON.stringify(configuration), taskRequestHash(dispatch.request, { kind: "user", id: f.userId }), task.id));
  f.database.authQuery(db => db.prepare("UPDATE forge_task_controls SET status = 'backlog', delivery_target = ?, workflow = ?, root_profile_json = ?, worker_profile_json = ?, advisor_profiles_json = ? WHERE task_id = ?").run(dispatch.policy.deliveryTarget, dispatch.request.workflow, JSON.stringify(profiles.root), JSON.stringify(profiles.worker), JSON.stringify(profiles.advisors), task.id));
  return { f, repository, dispatch, task };
}

async function repairCaptureFixture() {
  const f = await nativeApp({ githubTrigger: github });
  const preset = f.workflows.create(f.userId, { name: "Repair capture", description: "", engine: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true, rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", advisorProfileIds: { rater: "profile_native_root" } });
  const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Repair", label: "ready", workflowId: preset.id, deliveryTarget: "merged", protectedPaths: [] });
  const repository = new GithubTriggerDispatchRepository(f.database);
  const root = { profileId: "profile_native_root", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const };
  const worker = { profileId: "profile_native_worker", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const };
  const input = { ruleId: rule.id, companyId: f.company.id, projectId: f.project.id, repositoryId: 9, repositoryName: "owner/repo", pullRequestNumber: 7, authorityUserId: f.userId, request: { projectId: f.project.id, title: "Repair", description: "Repair", images: [], rootProfileId: root.profileId, workerProfileId: worker.profileId, deliveryTarget: "merged" as const, runProjectTests: true, visualEvidence: "off" as const, source: { kind: "pull_request" as const, number: 7 }, workflow: "refine_pull_request" as const, advisorProfileIds: { rater: root.profileId } }, policy: { headSha: "a".repeat(40), baseSha: "b".repeat(40), headBranch: "feature", baseBranch: "main", protectedPaths: [], repositoryId: 9, repositoryName: "owner/repo", deliveryTarget: "merged" as const }, preset, profiles: { root, worker, advisors: { rater: root } } };
  return { f, repository, input };
}

test("persists one immutable normalized dispatch across repeated preparation and rule archive", async () => {
  const f = await nativeApp({ githubTrigger: github });
  try {
    const workflow = f.workflows.create(f.userId, { name: "Dispatch", description: "", engine: "standard", deliveryTarget: "pull_request_draft", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: ["src/"] });
    const repository = new GithubTriggerDispatchRepository(f.database);
    const prepare = (title: string) => repository.prepare({ ruleId: rule.id, companyId: f.company.id, projectId: f.project.id, repositoryId: 9, repositoryName: "Owner/Repo", pullRequestNumber: 7, authorityUserId: f.userId, request: { projectId: f.project.id, title, description: "Dispatch", images: [], rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", source: { kind: "pull_request", number: 7 }, workflow: "standard", advisorProfileIds: {} }, policy: { headSha: "a".repeat(40), baseSha: "b".repeat(40), headBranch: "feature", baseBranch: "main", protectedPaths: ["src/"], repositoryId: 9, repositoryName: "owner/repo", deliveryTarget: "pull_request_draft" }, preset: workflow, profiles: { root: { profileId: "profile_native_root", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high", serviceTier: "default" }, worker: { profileId: "profile_native_worker", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high", serviceTier: "default" }, advisors: {} } });
    const first = prepare("Original");
    expect(first.request).toMatchObject({ title: "Original", startImmediately: false, idempotencyKey: first.idempotencyKey, source: { kind: "pull_request", number: 7 } });
    expect(first).toEqual(repository.get(first.id));
    expect(prepare("Changed")).toMatchObject({ id: first.id, request: { title: "Original" } });
    await f.githubTriggers.update(f.userId, f.company.id, rule.id, { archived: true, expectedRevision: rule.revision });
    expect(repository.get(first.id)).toMatchObject({ id: first.id, policy: first.policy });
    expect(repository.previouslyProcessed(9, 7)).toBe(true);
  } finally { await f.close(); }
});

test("rejects a source number that differs from the captured pull request", async () => {
  const f = await nativeApp({ githubTrigger: github });
  try {
    const repository = new GithubTriggerDispatchRepository(f.database);
    const preset = f.workflows.create(f.userId, { name: "Invalid", description: "", engine: "standard", deliveryTarget: "pull_request_draft", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: preset.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    const input = { ruleId: rule.id, companyId: f.company.id, projectId: f.project.id, repositoryId: 9, repositoryName: "owner/repo", pullRequestNumber: 7, authorityUserId: f.userId, request: { projectId: f.project.id, title: "Dispatch", description: "Dispatch", images: [], rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", deliveryTarget: "pull_request_draft" as const, runProjectTests: true, visualEvidence: "off" as const, source: { kind: "pull_request" as const, number: 8 }, workflow: "standard" as const, advisorProfileIds: {} }, policy: { headSha: "a".repeat(40), baseSha: "b".repeat(40), headBranch: "feature", baseBranch: "main", protectedPaths: [], repositoryId: 9, repositoryName: "owner/repo", deliveryTarget: "pull_request_draft" as const }, preset, profiles: { root: { profileId: "profile_native_root", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const }, worker: { profileId: "profile_native_worker", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const }, advisors: {} } };
    expect(() => repository.prepare(input)).toThrow("contradictory");
  } finally { await f.close(); }
});

test("links a matching backlog task once and preserves the terminal association", async () => {
  const { f, repository, dispatch, task } = await linkedFixture();
  try {
    expect(repository.linkTask(dispatch.id, task.id)).toMatchObject({ taskId: task.id });
    expect(f.database.authQuery(db => db.prepare("SELECT status FROM forge_task_controls WHERE task_id = ?").get(task.id) as { status: string }).status).toBe("backlog");
    expect(repository.linkTask(dispatch.id, task.id)).toMatchObject({ taskId: task.id });
    f.database.authQuery(db => db.prepare("UPDATE forge_task_controls SET status = 'delivered' WHERE task_id = ?").run(task.id));
    expect(repository.linkTask(dispatch.id, task.id)).toMatchObject({ taskId: task.id });
    await expect(f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Other", description: "Other", startImmediately: false, idempotencyKey: "other-link-task" }).then(({ task: other }) => repository.linkTask(dispatch.id, other.id))).rejects.toThrow("another task");
  } finally { await f.close(); }
});

test.each(["starting_sha", "baseline_sha", "delivery_target", "root_profile_json", "request_hash", "creator_user_id", "status"])("rejects a mismatched %s before linking", async field => {
  const { f, repository, dispatch, task } = await linkedFixture();
  try {
    f.database.authQuery(db => {
      if (field === "starting_sha") db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.startingSha', ?) WHERE id = ?").run("c".repeat(40), task.id);
      else if (field === "baseline_sha") db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.baselineSha', ?) WHERE id = ?").run("c".repeat(40), task.id);
      else if (field === "delivery_target") db.prepare("UPDATE forge_task_controls SET delivery_target = 'local_worktree' WHERE task_id = ?").run(task.id);
      else if (field === "root_profile_json") db.prepare("UPDATE forge_task_controls SET root_profile_json = json_set(root_profile_json, '$.model', 'other') WHERE task_id = ?").run(task.id);
      else if (field === "request_hash") db.prepare("UPDATE forge_tasks SET request_hash = 'wrong' WHERE id = ?").run(task.id);
      else if (field === "creator_user_id") {
        db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) SELECT 'user_link_mismatch', display_name, username || '-link-mismatch', role, status, created_at, updated_at FROM forge_users WHERE id = ?").run(f.userId);
        db.prepare("UPDATE forge_tasks SET creator_user_id = 'user_link_mismatch', creator_agent_id = NULL WHERE id = ?").run(task.id);
      }
      else db.prepare("UPDATE forge_task_controls SET status = 'active' WHERE task_id = ?").run(task.id);
    });
    expect(() => repository.linkTask(dispatch.id, task.id)).toThrow();
    expect(repository.get(dispatch.id)?.taskId).toBeNull();
  } finally { await f.close(); }
});

test("reopens a linked dispatch with its exact immutable capture", async () => {
  const { f, repository, dispatch, task } = await linkedFixture();
  try {
    repository.linkTask(dispatch.id, task.id);
    const reopened = new ForgeDatabase(f.config.databasePath, { migrate: false });
    try { expect(new GithubTriggerDispatchRepository(reopened).get(dispatch.id)).toMatchObject({ request: dispatch.request, policy: dispatch.policy, idempotencyKey: dispatch.idempotencyKey, taskId: task.id }); }
    finally { reopened.close(); }
  } finally { await f.close(); }
});

test("captures a resolved repair rater with merged delivery", async () => {
  const { f, repository, input } = await repairCaptureFixture();
  try { expect(repository.prepare(input)).toMatchObject({ request: { deliveryTarget: "merged", startImmediately: false, advisorProfileIds: { rater: "profile_native_root" } }, profiles: { advisors: { rater: input.profiles.root } } }); }
  finally { await f.close(); }
});

test.each([
  ["missing request rater", (input: Awaited<ReturnType<typeof repairCaptureFixture>>["input"]) => ({ ...input, request: { ...input.request, advisorProfileIds: {} } })],
  ["missing captured rater", (input: Awaited<ReturnType<typeof repairCaptureFixture>>["input"]) => ({ ...input, profiles: { ...input.profiles, advisors: {} } })],
  ["different captured rater", (input: Awaited<ReturnType<typeof repairCaptureFixture>>["input"]) => ({ ...input, profiles: { ...input.profiles, advisors: { rater: { ...input.profiles.root, profileId: "other" } } } })],
  ["preset rater differs", (input: Awaited<ReturnType<typeof repairCaptureFixture>>["input"]) => ({ ...input, preset: { ...input.preset, advisorProfileIds: { rater: "other" } } })],
])("rejects repair capture with %s", async (_name, change) => {
  const { f, repository, input } = await repairCaptureFixture();
  try { expect(() => repository.prepare(change(input))).toThrow(); expect(repository.listByRule(f.company.id, input.ruleId)).toEqual([]); }
  finally { await f.close(); }
});

test("keeps the original repair capture when retry input and preset change", async () => {
  const { f, repository, input } = await repairCaptureFixture();
  try {
    const first = repository.prepare(input);
    const edited = f.workflows.update(f.userId, input.preset.id, { description: "Edited", visualEvidence: "capture" });
    const retry = repository.prepare({ ...input, request: { ...input.request, title: "Changed" }, preset: edited });
    expect(retry).toEqual(first);
    expect(f.database.authQuery(db => db.prepare("SELECT request_json FROM forge_github_trigger_dispatches WHERE id = ?").get(first.id) as { request_json: string }).request_json).toBe(JSON.stringify(first.request));
    expect(() => repository.prepare({ ...input, authorityUserId: "other" })).toThrow();
    expect(() => repository.prepare({ ...input, companyId: "other" })).toThrow();
  } finally { await f.close(); }
});
