import { expect, test, vi } from "vitest";

import type { GithubTriggerPort } from "../src/github-trigger-inspection.js";
import { GithubTriggerService } from "../src/github-triggers.js";
import { TaskService } from "../src/tasks.js";
import { nativeApp } from "./helpers/native-app.js";

test("enabled rule dispatch creates one linked backlog task and preview is read-only", async () => {
  let inspections = 0;
  const github: GithubTriggerPort = {
    async observeRepository(input) { return { id: 9, fullName: input.repository }; },
    async validateLabel() {},
    async listOpenPullRequestsByLabel() { return [{ number: 7 }]; },
    async inspectPullRequest() {
      inspections += 1;
      return { number: 7, url: "https://github.com/owner/repo/pull/7", title: "Repair parser", state: "open" as const, isDraft: false, labels: ["ready"], changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [] };
    },
  };
  const f = await nativeApp({ githubTrigger: github });
  try {
    const preset = f.workflows.create(f.userId, { name: "Repair", description: "", engine: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true, rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", advisorProfileIds: { rater: "profile_native_root" } });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: preset.id, deliveryTarget: "merged", protectedPaths: [] });
    await f.githubTriggers.update(f.userId, f.company.id, rule.id, { enabled: true, expectedRevision: rule.revision });
    const projects = { getProject: f.projects.getProject.bind(f.projects), getProjectInCompany: f.projects.getProjectInCompany.bind(f.projects), async resolveTaskSource() { return { kind: "pull_request" as const, number: 7, url: "https://github.com/owner/repo/pull/7", headBranch: "feature", baseBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40) }; }, async captureTaskConfiguration() { return { baseSha: "b".repeat(40) }; } };
    const tasks = new TaskService(f.database, f.auth, projects, f.config);
    const service = new GithubTriggerService(f.database, f.auth, f.projects, f.workflows, github, tasks);
    await service.check(f.userId, f.company.id, rule.id);
    expect(f.tasks.listTasks(f.userId, f.company.id)).toHaveLength(0);
    await service.processEnabledRules();
    const created = tasks.listTasks(f.userId, f.company.id);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ status: "active", title: "Repair parser", deliveryTarget: "merged", workflow: "refine_pull_request" });
    await service.processEnabledRules();
    expect(tasks.listTasks(f.userId, f.company.id)).toHaveLength(1);
    expect(inspections).toBeGreaterThan(1);
    tasks.cancelTask(f.userId, created[0]!.id);
    expect(service.activity(f.userId, f.company.id, rule.id)).toContainEqual(expect.objectContaining({ taskId: created[0]!.id, taskStatus: "cancelled" }));
  } finally { await f.close(); }
});

async function fixture() {
  let labels = ["ready"];
  let listed = [7];
  let inspect = 0;
  let mutation: "head" | "fork" | "protected" | "disable" | null = null;
  const pull = (number: number) => ({ number, url: `https://github.com/owner/repo/pull/${number}`, title: `Repair ${number}`, state: "open" as const, isDraft: false, labels, changedFiles: 0, headSha: "a".repeat(40), headBranch: "feature", baseSha: "b".repeat(40), baseBranch: "main", headRepository: { id: 9, fullName: "owner/repo" }, baseRepository: { id: 9, fullName: "owner/repo" }, isCrossRepository: false, files: [] as Array<{ sha: string; filename: string; status: "added"; additions: number; deletions: number; changes: number; blobUrl: string; rawUrl: string; contentsUrl: string; previousFilename: null }> });
  let f: Awaited<ReturnType<typeof nativeApp>>;
  const github: GithubTriggerPort = { async observeRepository(input) { return { id: 9, fullName: input.repository }; }, async validateLabel() {}, async listOpenPullRequestsByLabel() { return listed.map(number => ({ number })); }, async inspectPullRequest(input) { inspect += 1; const value = pull(input.number); if (inspect % 2 === 0 && mutation) { if (mutation === "head") value.headSha = "c".repeat(40); if (mutation === "fork") { value.isCrossRepository = true; value.headRepository = { id: 10, fullName: "fork/repo" }; } if (mutation === "protected") { value.changedFiles = 1; value.files = [{ sha: "a", filename: "src/secret.ts", status: "added", additions: 1, deletions: 0, changes: 1, blobUrl: "https://example.com/blob", rawUrl: "https://example.com/raw", contentsUrl: "https://example.com/contents", previousFilename: null }]; } if (mutation === "disable") { const current = f.githubTriggers.repository.get(f.company.id, rule!.id)!; await f.githubTriggers.update(f.userId, f.company.id, current.id, { enabled: false, expectedRevision: current.revision }); } } return value; } };
  f = await nativeApp({ githubTrigger: github });
  let rule: Awaited<ReturnType<typeof f.githubTriggers.create>> | undefined;
  const preset = f.workflows.create(f.userId, { name: "Repair", description: "", engine: "refine_pull_request", deliveryTarget: "merged", runProjectTests: true, rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", advisorProfileIds: { rater: "profile_native_root" } });
  rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Ready", label: "ready", workflowId: preset.id, deliveryTarget: "merged", protectedPaths: ["src/"] });
  await f.githubTriggers.update(f.userId, f.company.id, rule.id, { enabled: true, expectedRevision: rule.revision });
  rule = f.githubTriggers.repository.get(f.company.id, rule.id)!;
  const projects = { getProject: f.projects.getProject.bind(f.projects), getProjectInCompany: f.projects.getProjectInCompany.bind(f.projects), async resolveTaskSource() { return { kind: "pull_request" as const, number: 7, url: "https://github.com/owner/repo/pull/7", headBranch: "feature", baseBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40) }; }, async captureTaskConfiguration() { return { baseSha: "b".repeat(40) }; } };
  const tasks = new TaskService(f.database, f.auth, projects, f.config);
  const service = new GithubTriggerService(f.database, f.auth, f.projects, f.workflows, github, tasks);
  return { f, rule, preset, tasks, service, get inspect() { return inspect; }, setLabels(value: string[]) { labels = value; }, setListed(value: number[]) { listed = value; }, setMutation(value: typeof mutation) { mutation = value; inspect = 0; } };
}

test("recovery preserves immutable request and fails closed while the label is absent", async () => {
  const value = await fixture();
  try {
    vi.spyOn(value.tasks, "createTaskFromGithubTrigger").mockRejectedValueOnce(new Error("transient"));
    await value.service.processEnabledRules();
    expect(value.tasks.listTasks(value.f.userId, value.f.company.id)).toHaveLength(0);
    const dispatch = value.f.database.authQuery(db => db.prepare("SELECT request_json, idempotency_key FROM forge_github_trigger_dispatches").get() as { request_json: string; idempotency_key: string });
    expect(JSON.parse(dispatch.request_json)).toMatchObject({ title: "Repair 7", visualEvidence: "off" });
    value.f.database.authQuery(db => db.prepare("UPDATE forge_github_trigger_rules SET next_retry_at = NULL").run());
    value.setLabels([]); await value.service.processEnabledRules();
    expect(value.tasks.listTasks(value.f.userId, value.f.company.id)).toHaveLength(0);
    value.f.database.authQuery(db => db.prepare("UPDATE forge_github_trigger_rules SET next_retry_at = NULL").run());
    value.setLabels(["ready"]); value.f.workflows.update(value.f.userId, value.preset.id, { visualEvidence: "required" });
    await value.service.processEnabledRules();
    expect(value.tasks.listTasks(value.f.userId, value.f.company.id)).toHaveLength(1);
    expect(JSON.parse(dispatch.request_json)).toMatchObject({ title: "Repair 7", visualEvidence: "off", idempotencyKey: dispatch.idempotency_key });
  } finally { await value.f.close(); }
});

test.each(["head", "fork", "protected", "disable"] as const)("final inspection %s creates neither dispatch nor task", async mutation => {
  const value = await fixture();
  try {
    value.setMutation(mutation); await value.service.processEnabledRules();
    expect(value.tasks.listTasks(value.f.userId, value.f.company.id)).toHaveLength(0);
    expect(value.f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_github_trigger_dispatches").get() as { count: number }).count).toBe(0);
  } finally { await value.f.close(); }
});
