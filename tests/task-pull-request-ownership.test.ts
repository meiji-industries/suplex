import { expect, test } from "vitest";

import { hasPullRequestOwner } from "../src/task-pull-request-ownership.js";
import { TaskService } from "../src/tasks.js";
import { nativeApp } from "./helpers/native-app.js";

test("starts a branch-source backlog task without claiming a pull request", async () => {
  const f = await nativeApp();
  try {
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Branch", description: "Branch", startImmediately: false, idempotencyKey: "branch-source-owner" });
    f.database.authQuery(db => db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.source', json(?)) WHERE id = ?").run(JSON.stringify({ kind: "branch", branch: "feature" }), task.id));
    expect(f.tasks.startTask(f.userId, task.id)).toMatchObject({ status: "active" });
  } finally { await f.close(); }
});

test("recognizes ownership across persisted repository aliases with one immutable ID", async () => {
  const f = await nativeApp();
  try {
    const workflow = f.workflows.create(f.userId, { name: "Alias", description: "", engine: "standard", deliveryTarget: "pull_request_draft" });
    const rule = await f.githubTriggers.create(f.userId, f.company.id, { projectId: f.project.id, name: "Old", label: "ready", workflowId: workflow.id, deliveryTarget: "pull_request_draft", protectedPaths: [] });
    f.database.authQuery(db => { db.prepare("UPDATE forge_github_trigger_rules SET repository_name = 'old/repo' WHERE id = ?").run(rule.id); db.prepare("INSERT INTO forge_github_trigger_rules (id, company_id, project_id, name, label, workflow_id, delivery_target, protected_paths_json, repository_id, repository_name, authority_user_id, enabled, archived_at, revision, last_successful_check_at, next_retry_at, latest_error, failure_count, recent_activity_json, created_at, updated_at) SELECT 'github_trigger_alias', company_id, project_id, 'New', label, workflow_id, delivery_target, protected_paths_json, repository_id, 'new/repo', authority_user_id, 0, NULL, 1, NULL, NULL, NULL, 0, '[]', created_at, updated_at FROM forge_github_trigger_rules WHERE id = ?").run(rule.id); });
    const { task } = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Owner", description: "Owner", startImmediately: false, idempotencyKey: "alias-owner" });
    f.database.authQuery(db => { db.prepare("UPDATE forge_tasks SET configuration_json = json_set(configuration_json, '$.repository', 'old/repo', '$.source', json(?)) WHERE id = ?").run(JSON.stringify({ kind: "pull_request", number: 7 }), task.id); db.prepare("UPDATE forge_task_controls SET status = 'active', delivery_intent_json = ? WHERE task_id = ?").run(JSON.stringify({ repository: "old/repo", headBranch: "feature", baseBranch: "main", baselineSha: "a".repeat(40), pullRequestNumber: 7 }), task.id); });
    expect(f.database.authQuery(db => hasPullRequestOwner(db, { repository: "new/repo", number: 7 }))).toBe(true);
    expect(f.database.authQuery(db => hasPullRequestOwner(db, { repository: "other/repo", number: 7 }))).toBe(false);
    expect(f.database.authQuery(db => hasPullRequestOwner(db, { taskId: task.id, repository: "new/repo", number: 7 }))).toBe(false);
  } finally { await f.close(); }
});

test("serializes concurrent manual pull request admissions", async () => {
  const f = await nativeApp();
  try {
    let entered = 0;
    let release!: () => void;
    let both!: () => void;
    const released = new Promise<void>(resolve => { release = resolve; });
    const bothEntered = new Promise<void>(resolve => { both = resolve; });
    const tasks = new TaskService(f.database, f.auth, { getProject: f.projects.getProject.bind(f.projects), getProjectInCompany: f.projects.getProjectInCompany.bind(f.projects), async resolveTaskSource() { entered += 1; if (entered === 2) both(); await released; return { kind: "pull_request", number: 7, url: "https://github.com/owner/repo/pull/7", headBranch: "feature", baseBranch: "main", headSha: "a".repeat(40), baseSha: "b".repeat(40) }; }, async captureTaskConfiguration() { return { baseSha: "b".repeat(40) }; } }, f.config);
    const create = (key: string) => tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: key, description: key, startImmediately: false, idempotencyKey: key, source: { kind: "pull_request", number: 7 } });
    const pending = [create("owner-race-one"), create("owner-race-two")];
    await bothEntered;
    release();
    const settled = await Promise.allSettled(pending);
    expect(settled.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter(result => result.status === "rejected")).toMatchObject([{ reason: { statusCode: 409 } }]);
    expect(f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_tasks").get() as { count: number }).count).toBe(1);
    expect(f.database.authQuery(db => db.prepare("SELECT count(*) AS count FROM forge_task_controls").get() as { count: number }).count).toBe(1);
  } finally { await f.close(); }
});
