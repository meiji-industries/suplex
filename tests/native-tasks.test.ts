import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthService } from "../src/identity/auth.js";
import { createTestConfig } from "../src/platform/config.js";
import { SuplexDatabase } from "../src/platform/database.js";
import { TaskService, type TaskServicePorts } from "../src/tasks/tasks.js";
import { prepareIssueContext, taskTracker } from "../src/tasks/issue-context.js";
import type { IssueAssociation } from "../src/tasks/issue-association.js";
import { ArtifactStore } from "../src/platform/artifacts.js";
import type { Project } from "../src/projects/projects.js";
import { TaskControlStore } from "../src/coordination/root-session-store.js";

const cleanups: Array<() => Promise<void>> = [];
test("only legacy projects infer GitHub Issues from their repository", () => {
  expect(taskTracker({ repository: "owner/repo" })).toEqual({ kind: "github", repository: "owner/repo" });
  expect(() => taskTracker({ repository: "owner/repo", integration: { repository: { kind: "github" }, tracker: null } })).toThrow("Configure an issue tracker");
});
test("generated evidence is listed separately and remains readable after archive", async () => {
  const f = await fixture();
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  const artifact = await new ArtifactStore(f.config.artifactRoot, f.database).putArtifact("company", "delivery-evidence", { taskId: task.id, filename: "verification.txt", mimeType: "text/plain", bytes: Buffer.from("Checks passed") });
  f.tasks.repository.setArchived(task.id, true);
  expect(f.tasks.getTask("alice", task.id)).toMatchObject({ images: [], artifacts: [{ artifactId: artifact.id, filename: "verification.txt" }] });
  expect((await f.tasks.getTaskArtifact("alice", task.id, artifact.id)).bytes.toString()).toBe("Checks passed");
  await expect(f.tasks.getTaskArtifact("bob", task.id, artifact.id)).rejects.toMatchObject({ statusCode: 404 });
});
test("Bitbucket rejects ready and merge targets on both create and backlog edits", async () => {
  const f = await fixture();
  f.project.integration = { repository: { kind: "bitbucket", tokenEnvironment: "BB_TOKEN" }, tracker: null };
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  expect(task.deliveryTarget).toBe("pull_request_draft");
  for (const deliveryTarget of ["pull_request_ready", "merged"] as const) {
    await expect(f.tasks.createTask("alice", "company", { ...f.input, idempotencyKey: `bitbucket-${deliveryTarget}`, deliveryTarget })).rejects.toThrow("Bitbucket supports draft");
    expect(() => f.tasks.updateTaskDetails("alice", task.id, { deliveryTarget })).toThrow("Bitbucket supports draft");
  }
  expect(f.tasks.updateTaskDetails("alice", task.id, { deliveryTarget: "local_worktree" }).deliveryTarget).toBe("local_worktree");
});
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture(ports: TaskServicePorts = {}) {
  const directory = await mkdtemp(join(tmpdir(), "suplex-native-intake-"));
  const config = createTestConfig(directory);
  const database = new SuplexDatabase(config.databasePath);
  cleanups.push(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const auth = new AuthService(database, config);
  const stamp = new Date().toISOString();
  database.authTransaction(db => {
    for (const id of ["alice", "bob"]) db.prepare("INSERT INTO suplex_users (id, display_name, username, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)").run(id, id, id, stamp, stamp);
    db.prepare("INSERT INTO suplex_companies (id, name, status, issue_code, created_at) VALUES ('company', 'Company', 'active', 'TEST', ?)").run(stamp);
    db.prepare("INSERT INTO suplex_memberships (user_id, company_id, created_at) VALUES ('alice', 'company', ?)").run(stamp);
    db.prepare("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', '', ?, ?)").run(directory, join(directory, "worktrees"), stamp, stamp);
  });
  const project: Project = { id: "project", companyId: "company", name: "Project", repositoryPath: directory, worktreeRoot: join(directory, "worktrees"), repository: "owner/repo", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", createdAt: stamp, updatedAt: stamp };
  let captures = 0;
  let duringCapture = (): void => {};
  const tasks = new TaskService(database, auth, {
    getProject: () => project, getProjectInCompany: () => project,
    resolveTaskSource: async () => ({ kind: "branch", branch: "existing", headSha: "b".repeat(40) }),
    captureTaskConfiguration: async () => { captures++; duringCapture(); return { baseSha: "a".repeat(40), targetSha: "a".repeat(40) }; },
  }, config, ports);
  const input = { projectId: "project", title: "Change one thing", description: "Keep the rest.", idempotencyKey: "native-request-1", startImmediately: true };
  return { directory, config, database, tasks, input, project, captures: () => captures, duringCapture: (callback: () => void) => { duringCapture = callback; } };
}

test("issue association preserves authored scope and captures refreshed context only before native work", async () => {
  let text = "Original remote scope";
  let reads = 0;
  const image = { filename: "issue-screen.png", mimeType: "image/png", bytes: Buffer.from("test image bytes") };
  const issueTracker = () => ({
    read: async (issue: IssueAssociation) => { reads++; return { issue: { ...issue, title: "Remote issue" }, text, capturedAt: new Date().toISOString() }; },
    images: async () => ({ images: [image], notes: ["PDF attachment was not loaded."] }),
  });
  const f = await fixture({ issueTracker });
  const issue: IssueAssociation = { kind: "jira", site: "https://client.atlassian.net", id: "10", key: "APP-10", title: "Local title", url: "https://client.atlassian.net/browse/APP-10" };
  f.project.integration = { repository: { kind: "bitbucket", tokenEnvironment: "BB_TOKEN" }, tracker: { kind: "jira", site: issue.site, project: "APP", emailEnvironment: "JIRA_EMAIL", tokenEnvironment: "JIRA_TOKEN" } };
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, issue });
  expect(task).toMatchObject({ issue: { title: "Remote issue" }, title: f.input.title, description: f.input.description });
  text = "Refreshed remote scope";
  const imageRoot = join(f.directory, "custom-issue-artifacts");
  await prepareIssueContext(f.database, task.id, issueTracker, imageRoot);
  const stored = f.tasks.getTask("alice", task.id).images;
  expect(stored).toHaveLength(1);
  expect(new TaskControlStore(f.database).context(task.id).images).toEqual([{ artifactId: stored[0]?.artifactId, filename: image.filename }]);
  const artifact = new TaskControlStore(f.database).image(task.id, stored[0]!.artifactId);
  expect(await new ArtifactStore(imageRoot).getArtifact(artifact)).toEqual(image.bytes);
  const context = () => f.database.authQuery(db => db.prepare("SELECT issue_context_json FROM suplex_tasks WHERE id = ?").get(task.id));
  const before = context();
  expect(JSON.stringify(before)).toContain(text);
  expect(JSON.stringify(before)).toContain("PDF attachment was not loaded");
  expect(JSON.stringify(before)).not.toContain(image.bytes.toString("base64"));
  f.database.authTransaction(db => db.prepare("INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, native_session_id, lifecycle, created_at, updated_at) VALUES ('native-root', ?, 'root', 1, 1, 'native-id', 'live', 'now', 'now')").run(task.id));
  await f.tasks.setTaskIssue("alice", task.id, { ...issue, id: "11", key: "APP-11", url: "https://client.atlassian.net/browse/APP-11" });
  await prepareIssueContext(f.database, task.id, issueTracker);
  expect(context()).toEqual(before);
  expect(f.tasks.getTask("alice", task.id).images).toHaveLength(1);
  expect(reads).toBe(3);
  const cleared = await f.tasks.setTaskIssue("alice", task.id, null);
  expect(cleared).toMatchObject({ issue: null, title: f.input.title, description: f.input.description, status: "active" });
  expect(context()).toEqual(before);
  await expect(f.tasks.setTaskIssue("bob", task.id, issue)).rejects.toMatchObject({ statusCode: 404 });
});

test("project provider policy selects eligible defaults and rejects every disallowed role", async () => {
  const f = await fixture();
  f.project.providerPolicy = { allowedProviders: ["claude-code"], allowedInstanceIds: ["dedicated"] };
  f.database.authTransaction(db => {
    db.prepare("INSERT INTO suplex_provider_instances (id, provider, label, home_directory, created_at, updated_at) VALUES ('dedicated', 'claude-code', 'Client', ?, 'now', 'now')").run(join(f.directory, "client"));
    for (const role of ["root", "worker"]) db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, provider_instance_id, model, reasoning_level, service_tier, created_at, updated_at) VALUES (?, ?, ?, 'seed', 'claude-code', 'dedicated', 'sonnet', 'high', 'default', 'now', 'now')").run(`client-${role}`, role, role);
    db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('global-claude', 'Global', 'root', 'seed', 'claude-code', 'sonnet', 'high', 'default', 'now', 'now')").run();
  });
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false, workflow: "independent_review" });
  for (const profile of [task.rootProfile, task.workerProfile, task.advisorProfiles.reviewer]) expect(profile).toMatchObject({ providerInstanceId: "dedicated", instanceHomeDirectory: join(f.directory, "client") });
  expect(task.configuration.providerPolicy).toEqual(f.project.providerPolicy);
  const globalProfileTask = await f.tasks.createTask("alice", "company", { ...f.input, idempotencyKey: "global-claude", workflow: "independent_review", rootProfileId: "global-claude" });
  expect(globalProfileTask.task.rootProfile).toMatchObject({ profileId: "global-claude", providerInstanceId: null });
  for (const selection of [{ rootProfileId: "profile_native_root" }, { workerProfileId: "profile_native_worker" }, { advisorProfileIds: { reviewer: "profile_native_root" } }]) {
    await expect(f.tasks.createTask("alice", "company", { ...f.input, idempotencyKey: `rejected-${JSON.stringify(selection)}`.replace(/[^a-zA-Z0-9]/g, "-"), workflow: "independent_review", ...selection })).rejects.toThrow("allowed by this project");
    expect(() => f.tasks.updateTaskDetails("alice", task.id, selection)).toThrow("allowed by this project");
  }
});

test("creation persists active intent without a planning projection or running harness", async () => {
  const f = await fixture();
  const result = await f.tasks.createTask("alice", "company", f.input);
  expect(result.created).toBe(true);
  expect(result.task).toMatchObject({ status: "active", issueKey: "TEST-1", rootProfile: { provider: "codex" }, workerProfile: { reasoningLevel: "max" }, configuration: { setupCommand: "pnpm install", verificationCommand: "pnpm test" } });
  expect(f.database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE name = 'suplex_issue_projections'").all())).toEqual([]);
  f.database.close();
  const reopened = new SuplexDatabase(f.config.databasePath);
  try { expect(new TaskControlStore(reopened).get(result.task.id).status).toBe("active"); } finally { reopened.close(); }
});

test("an exact retry returns the original task before observing external state again", async () => {
  const f = await fixture();
  const first = await f.tasks.createTask("alice", "company", f.input);
  f.duringCapture(() => { throw new Error("Git is offline"); });
  expect(await f.tasks.createTask("alice", "company", f.input)).toEqual({ task: first.task, created: false });
  expect(f.captures()).toBe(1);
  await expect(f.tasks.createTask("alice", "company", { ...f.input, description: "Different" })).rejects.toMatchObject({ statusCode: 409 });
});

test("concurrent identical creation produces one task, one control and one issue number", async () => {
  const f = await fixture();
  const results = await Promise.all([f.tasks.createTask("alice", "company", f.input), f.tasks.createTask("alice", "company", f.input)]);
  expect(results.map(result => result.created).sort()).toEqual([false, true]);
  expect(new Set(results.map(result => result.task.id)).size).toBe(1);
  expect(f.tasks.listTasks("alice")).toHaveLength(1);
});

test("revoked scope during external capture prevents creation", async () => {
  const f = await fixture();
  f.duringCapture(() => f.database.authTransaction(db => db.prepare("DELETE FROM suplex_memberships WHERE user_id = 'alice'").run()));
  await expect(f.tasks.createTask("alice", "company", f.input)).rejects.toMatchObject({ statusCode: 404 });
  expect(f.database.authQuery(db => db.prepare("SELECT * FROM suplex_tasks").all())).toEqual([]);
});

test("backlog starts explicitly and active tasks cannot be archived", async () => {
  const f = await fixture();
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  expect(task.status).toBe("backlog");
  expect(f.tasks.startTask("alice", task.id).status).toBe("active");
  const worktree = { path: join(f.directory, "work"), branch: "task", baseSha: "a", headSha: "b", dirty: true };
  f.tasks.repository.controls.setWorktree(task.id, worktree);
  await expect(f.tasks.archiveTask("alice", task.id)).rejects.toThrow("Cancel the task");
  f.tasks.cancelTask("alice", task.id);
  f.tasks.repository.setArchived(task.id, true);
  expect(f.tasks.listTasks("alice")).toEqual([]);
  expect(f.tasks.listTasks("alice", "company", true)).toHaveLength(1);
});

test("task artifacts require current company access and exact task ownership and hash", async () => {
  const f = await fixture();
  const image = { filename: "image.png", mimeType: "image/png" as const, base64: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64") };
  const first = await f.tasks.createTask("alice", "company", { ...f.input, images: [image] });
  const second = await f.tasks.createTask("alice", "company", { ...f.input, idempotencyKey: "native-request-2" });
  const id = first.task.images[0]!.artifactId;
  await expect(f.tasks.getTaskArtifact("bob", first.task.id, id)).rejects.toMatchObject({ statusCode: 404 });
  await expect(f.tasks.getTaskArtifact("alice", second.task.id, id)).rejects.toMatchObject({ statusCode: 404 });
  const original = await f.tasks.getTaskArtifact("alice", first.task.id, id);
  expect(original.bytes.toString("base64")).toBe(image.base64);
  await writeFile(join(f.config.artifactRoot, original.artifact.storagePath), "changed");
  await expect(f.tasks.getTaskArtifact("alice", first.task.id, id)).rejects.toMatchObject({ statusCode: 409 });
});

test("invalid image bytes leave no task or partial control", async () => {
  const f = await fixture();
  await expect(f.tasks.createTask("alice", "company", { ...f.input, images: [{ filename: "fake.png", mimeType: "image/png", base64: "bm90IHBuZw==" }] })).rejects.toThrow("Image data is invalid");
  expect(f.tasks.listTasks("alice")).toEqual([]);
});

test("task recency follows control changes without a task-list projection", async () => {
  const f = await fixture();
  const first = await f.tasks.createTask("alice", "company", f.input);
  await f.tasks.createTask("alice", "company", { ...f.input, idempotencyKey: "native-request-2" });
  const observedAt = "2099-01-01T00:00:00.000Z";
  f.database.authTransaction(db => db.prepare("UPDATE suplex_task_controls SET updated_at = ? WHERE task_id = ?").run(observedAt, first.task.id));
  expect(f.tasks.listTasks("alice")[0]).toMatchObject({ id: first.task.id, updatedAt: observedAt });
});

test("editing the objective checks backlog ownership in the same transaction as the write", async () => {
  const f = await fixture();
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  expect(f.tasks.updateTaskDetails("alice", task.id, { title: "Updated title" })).toMatchObject({ title: "Updated title", description: f.input.description });
  expect(f.tasks.repository.controls.get(task.id).objective).toBe(`Updated title\n\n${f.input.description}`);
  f.tasks.repository.setArchived(task.id, true);
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { title: "Archived edit" })).toThrow("Only tasks in the backlog");
  f.tasks.unarchiveTask("alice", task.id);
  f.tasks.startTask("alice", task.id);
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { title: "Late edit" })).toThrow("Only tasks in the backlog");
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { description: "Late edit" })).toThrow("Only tasks in the backlog");
  expect(f.tasks.getTask("alice", task.id).title).toBe("Updated title");
  expect(f.tasks.repository.controls.get(task.id).objective).toBe(`Updated title\n\n${f.input.description}`);
});

test("editing a backlog task saves its profiles, workflow, delivery target and checks", async () => {
  const f = await fixture();
  const stamp = new Date().toISOString();
  f.database.authTransaction(db => db.prepare("INSERT INTO suplex_profiles (id, name, role, avatar_seed, provider, model, reasoning_level, service_tier, created_at, updated_at) VALUES ('profile_review', 'Review', 'root', 'review', 'claude-code', 'claude-opus-5', 'high', 'default', ?, ?)").run(stamp, stamp));
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  const edited = f.tasks.updateTaskDetails("alice", task.id, {
    title: "Edited title", description: "Edited objective", rootProfileId: "profile_review", workerProfileId: "profile_native_worker",
    workflow: "independent_review", advisorProfileIds: { reviewer: "profile_review" }, deliveryTarget: "merged", runProjectTests: false, visualEvidence: "required",
  });
  expect(edited).toMatchObject({
    title: "Edited title", description: "Edited objective", deliveryTarget: "merged", workflow: "independent_review",
    rootProfile: { profileId: "profile_review", model: "claude-opus-5" }, advisorProfiles: { reviewer: { profileId: "profile_review" } },
    configuration: { runProjectTests: false, visualEvidence: "required" },
  });
  const control = f.tasks.repository.controls.get(task.id);
  expect(control).toMatchObject({ objective: "Edited title\n\nEdited objective", deliveryTarget: "merged", workflow: "independent_review" });
  expect(control.advisorProfiles.reviewer?.profileId).toBe("profile_review");
  // The Reviewer now differs from the Coordinator, so the next two edits show which one an Advisor resolves to.
  const distinct = f.tasks.updateTaskDetails("alice", task.id, { rootProfileId: "profile_native_root", advisorProfileIds: { reviewer: "profile_review" } });
  expect(distinct.advisorProfiles.reviewer).toMatchObject({ profileId: "profile_review" });
  // An edit that names no Advisor at all, such as a title-only edit, keeps every stored Advisor.
  expect(f.tasks.updateTaskDetails("alice", task.id, { title: "Kept Advisors" }).advisorProfiles.reviewer).toMatchObject({ profileId: "profile_review" });
  // Clearing the Reviewer in the dialog sends an Advisor selection without that role, which resets it to the Coordinator profile.
  const cleared = f.tasks.updateTaskDetails("alice", task.id, { workflow: "independent_review", advisorProfileIds: {} });
  expect(cleared.advisorProfiles.reviewer).toMatchObject({ profileId: "profile_native_root" });
  // A role the request never names on a new workflow starts at the workflow's default, which is the Coordinator profile.
  const combined = f.tasks.updateTaskDetails("alice", task.id, { workflow: "competing_plans" });
  expect(combined.advisorProfiles).toMatchObject({ planner_a: { profileId: "profile_native_root" }, planner_b: { profileId: "profile_native_root" } });
  expect(combined.advisorProfiles.reviewer).toBeUndefined();
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { rootProfileId: "profile_missing" })).toThrow("The selected agent profile does not exist");
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { workflow: "competing_plans", advisorProfileIds: { reviewer: "profile_review" } })).toThrow("Reviewer");
});

test("editing to pull request repair needs a pull request source and forces its delivery rules", async () => {
  const f = await fixture();
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  expect(task.configuration.source).toBeNull();
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { workflow: "refine_pull_request" })).toThrow("Select a pull request source");
  f.database.authTransaction(db => db.prepare("UPDATE suplex_tasks SET configuration_json = json_set(configuration_json, '$.source', json(?)) WHERE id = ?").run(JSON.stringify({ kind: "pull_request", number: 7 }), task.id));
  const repaired = f.tasks.updateTaskDetails("alice", task.id, { workflow: "refine_pull_request", visualEvidence: "capture" });
  expect(repaired).toMatchObject({ workflow: "refine_pull_request", deliveryTarget: "merged", configuration: { runProjectTests: true, visualEvidence: "capture" } });
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { deliveryTarget: "remote_branch" })).toThrow("merged pull request");
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { runProjectTests: false })).toThrow("runs the project tests");
});

test("editing details can clear the description without leaving objective whitespace", async () => {
  const f = await fixture();
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  expect(f.tasks.updateTaskDetails("alice", task.id, { description: "" })).toMatchObject({ title: f.input.title, description: "" });
  expect(f.tasks.repository.controls.get(task.id).objective).toBe(f.input.title);
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { title: "" })).toThrow();
});

test("renaming a started task leaves its objective unchanged and rejects an empty title", async () => {
  const f = await fixture();
  const { task } = await f.tasks.createTask("alice", "company", f.input);
  const objective = f.tasks.repository.controls.get(task.id).objective;
  expect(f.tasks.renameTask("alice", task.id, { title: "Renamed task" })).toMatchObject({ title: "Renamed task" });
  expect(f.tasks.repository.controls.get(task.id).objective).toBe(objective);
  expect(() => f.tasks.renameTask("alice", task.id, { title: "   " })).toThrow();
});
