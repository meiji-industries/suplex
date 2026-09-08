import { expect, test, vi } from "vitest";

import { GithubTriggerDispatchRepository } from "../src/integrations/github/trigger-dispatches.js";
import type { GithubTriggerPort } from "../src/integrations/github/trigger-inspection.js";
import { TaskService } from "../src/tasks/tasks.js";
import { nativeApp } from "./helpers/native-app.js";

const port: GithubTriggerPort = { async observeRepository(input) { return { id: 9, fullName: input.repository }; }, async validateLabel() {}, async listOpenPullRequestsByLabel() { return []; }, async inspectPullRequest() { throw new Error("not used"); } };

async function fixture() {
  const f = await nativeApp({ githubTrigger: port });
  const preset = f.workflows.create(f.userId, { name: "Admission", description: "", engine: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true, rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", advisorProfileIds: { rater: "profile_native_root" } });
  const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Admission", label: "ready", workflowId: preset.id, deliveryTarget: "merged", protectedPaths: [] });
  await f.githubTriggers.update(f.userId, f.company.id, rule.id, { enabled: true, expectedRevision: rule.revision });
  const profiles = { root: { profileId: "profile_native_root", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const }, worker: { profileId: "profile_native_worker", provider: "opencode", model: "gpt-5.6-sol", reasoningLevel: "high" as const, serviceTier: "default" as const }, advisors: {} };
  const dispatch = new GithubTriggerDispatchRepository(f.database).prepare({ ruleId: rule.id, companyId: f.company.id, projectId: f.project.id, repositoryId: 9, repositoryName: "owner/repo", pullRequestNumber: 7, authorityUserId: f.userId, request: { projectId: f.project.id, title: "Admission", description: "Admission", images: [], rootProfileId: profiles.root.profileId, workerProfileId: profiles.worker.profileId, deliveryTarget: "merged", runProjectTests: true, visualEvidence: "off", source: { kind: "pull_request", number: 7 }, workflow: "refine_pull_request", advisorProfileIds: { rater: profiles.root.profileId } }, policy: { headSha: "a".repeat(40), baseSha: "b".repeat(40), headBranch: "feature", baseBranch: "main", protectedPaths: [], repositoryId: 9, repositoryName: "owner/repo", deliveryTarget: "merged" }, preset, profiles: { ...profiles, advisors: { rater: profiles.root } } });
  let source = { kind: "pull_request" as const, number: 7, url: "https://github.com/owner/repo/pull/7", headBranch: "feature", baseBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40) };
  let reads = 0;
  let started: { resolve: () => void; promise: Promise<void> } | undefined;
  let release: Promise<void> | undefined;
  const projects = { getProject: f.projects.getProject.bind(f.projects), getProjectInCompany: f.projects.getProjectInCompany.bind(f.projects), async resolveTaskSource() { reads += 1; started?.resolve(); await release; return source; }, async captureTaskConfiguration() { return { baseSha: "b".repeat(40) }; } };
  const tasks = new TaskService(f.database, f.auth, projects, f.config);
  return { f, rule, dispatch, tasks, get reads() { return reads; }, setSource(next: Partial<typeof source>) { source = { ...source, ...next }; }, blockSource() { let resolveStarted!: () => void; let resolveRelease!: () => void; started = { promise: new Promise<void>(resolve => { resolveStarted = resolve; }), resolve: resolveStarted }; release = new Promise<void>(resolve => { resolveRelease = resolve; }); return { started: started.promise, release: resolveRelease }; } };
}

test("admits one linked repair backlog task and retries without source reads", async () => {
  const value = await fixture();
  try {
    const first = await value.tasks.createTaskFromGithubTrigger(value.dispatch.id);
    expect(first).toMatchObject({ created: true, task: { status: "backlog", deliveryTarget: "merged", workflow: "refine_pull_request", configuration: { startingSha: "a".repeat(40), baselineSha: "b".repeat(40) }, rootProfile: value.dispatch.profiles.root, workerProfile: value.dispatch.profiles.worker, advisorProfiles: { rater: value.dispatch.profiles.root } } });
    expect(new GithubTriggerDispatchRepository(value.f.database).get(value.dispatch.id)).toMatchObject({ taskId: first.task.id });
    value.f.workflows.update(value.f.userId, value.dispatch.preset.id, { description: "Edited" });
    const current = value.f.githubTriggers.repository.get(value.f.company.id, value.rule.id)!;
    await value.f.githubTriggers.update(value.f.userId, value.f.company.id, value.rule.id, { enabled: false, expectedRevision: current.revision });
    const before = value.reads;
    await expect(value.tasks.createTaskFromGithubTrigger(value.dispatch.id)).resolves.toMatchObject({ created: false, task: { id: first.task.id } });
    expect(value.reads).toBe(before);
  } finally { await value.f.close(); }
});

test("rolls back task admission when dispatch linkage fails", async () => {
  const value = await fixture();
  const spy = vi.spyOn(GithubTriggerDispatchRepository.prototype, "linkTask").mockImplementationOnce(() => { throw new Error("link failed"); });
  try {
    const counter = value.f.database.authQuery(db => db.prepare("SELECT next_issue_number FROM forge_companies WHERE id = ?").get(value.f.company.id) as { next_issue_number: number }).next_issue_number;
    const audits = value.f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_audit_events WHERE action = 'task_created'").get() as { count: number }).count;
    await expect(value.tasks.createTaskFromGithubTrigger(value.dispatch.id)).rejects.toThrow("link failed");
    expect(value.f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count).toBe(0);
    expect(value.f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_task_controls").get() as { count: number }).count).toBe(0);
    expect(value.f.database.authQuery(db => db.prepare("SELECT next_issue_number FROM forge_companies WHERE id = ?").get(value.f.company.id) as { next_issue_number: number }).next_issue_number).toBe(counter);
    expect(value.f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_audit_events WHERE action = 'task_created'").get() as { count: number }).count).toBe(audits);
    expect(new GithubTriggerDispatchRepository(value.f.database).get(value.dispatch.id)?.taskId).toBeNull();
    spy.mockRestore();
    await expect(value.tasks.createTaskFromGithubTrigger(value.dispatch.id)).resolves.toMatchObject({ created: true, task: { status: "backlog" } });
    expect(new GithubTriggerDispatchRepository(value.f.database).get(value.dispatch.id)?.taskId).not.toBeNull();
  } finally { spy.mockRestore(); await value.f.close(); }
});

test.each(["headSha", "baseSha"])("rejects %s drift before creating a task", async field => {
  const value = await fixture();
  try {
    value.setSource({ [field]: "c".repeat(40) });
    await expect(value.tasks.createTaskFromGithubTrigger(value.dispatch.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(value.f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count).toBe(0);
    expect(new GithubTriggerDispatchRepository(value.f.database).get(value.dispatch.id)?.taskId).toBeNull();
  } finally { await value.f.close(); }
});

test.each(["rule", "project"])("rejects %s changes during source resolution", async change => {
  const value = await fixture();
  try {
    const barrier = value.blockSource();
    const admission = value.tasks.createTaskFromGithubTrigger(value.dispatch.id);
    await barrier.started;
    if (change === "rule") {
      const current = value.f.githubTriggers.repository.get(value.f.company.id, value.rule.id)!;
      await value.f.githubTriggers.update(value.f.userId, value.f.company.id, value.rule.id, { enabled: false, expectedRevision: current.revision });
    } else value.f.database.authQuery(db => db.prepare("UPDATE forge_projects SET base_branch = 'release' WHERE id = ?").run(value.f.project.id));
    barrier.release();
    await expect(admission).rejects.toMatchObject({ statusCode: 409 });
    expect(value.f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count).toBe(0);
    expect(new GithubTriggerDispatchRepository(value.f.database).get(value.dispatch.id)?.taskId).toBeNull();
  } finally { await value.f.close(); }
});
