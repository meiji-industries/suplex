import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { AuthService } from "../src/auth.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";
import { TaskService } from "../src/tasks.js";
import type { Project } from "../src/projects.js";
import { TaskControlStore } from "../src/root-session-store.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0)) await cleanup(); });

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "forge-native-intake-"));
  const config = createTestConfig(directory);
  const database = new ForgeDatabase(config.databasePath);
  cleanups.push(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const auth = new AuthService(database, config);
  const stamp = new Date().toISOString();
  database.authTransaction(db => {
    for (const id of ["alice", "bob"]) db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES (?, ?, ?, 'member', 'active', ?, ?)").run(id, id, id, stamp, stamp);
    db.prepare("INSERT INTO forge_companies (id, name, status, issue_code, created_at) VALUES ('company', 'Company', 'active', 'TEST', ?)").run(stamp);
    db.prepare("INSERT INTO forge_memberships (user_id, company_id, created_at) VALUES ('alice', 'company', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', '', ?, ?)").run(directory, join(directory, "worktrees"), stamp, stamp);
  });
  const project: Project = { id: "project", companyId: "company", name: "Project", repositoryPath: directory, worktreeRoot: join(directory, "worktrees"), repository: "owner/repo", baseBranch: "main", setupCommand: "pnpm install", verificationCommand: "pnpm test", rootProfileId: "profile_native_root", workerProfileId: "profile_native_worker", createdAt: stamp, updatedAt: stamp };
  let captures = 0;
  let duringCapture = (): void => {};
  const tasks = new TaskService(database, auth, {
    getProject: () => project, getProjectInCompany: () => project,
    resolveTaskSource: async () => ({ kind: "branch", branch: "existing", headSha: "b".repeat(40) }),
    captureTaskConfiguration: async () => { captures++; duringCapture(); return { baseSha: "a".repeat(40), targetSha: "a".repeat(40) }; },
  }, config);
  const input = { projectId: "project", title: "Change one thing", description: "Keep the rest.", idempotencyKey: "native-request-1", startImmediately: true };
  return { directory, config, database, tasks, input, captures: () => captures, duringCapture: (callback: () => void) => { duringCapture = callback; } };
}

test("creation persists active intent without a planning projection or running harness", async () => {
  const f = await fixture();
  const result = await f.tasks.createTask("alice", "company", f.input);
  expect(result.created).toBe(true);
  expect(result.task).toMatchObject({ status: "active", issueKey: "TEST-1", rootProfile: { provider: "openai" }, workerProfile: { reasoningLevel: "max" }, configuration: { setupCommand: "pnpm install", verificationCommand: "pnpm test" } });
  expect(f.database.authQuery(db => db.prepare("SELECT name FROM sqlite_master WHERE name = 'forge_issue_projections'").all())).toEqual([]);
  f.database.close();
  const reopened = new ForgeDatabase(f.config.databasePath);
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
  f.duringCapture(() => f.database.authTransaction(db => db.prepare("DELETE FROM forge_memberships WHERE user_id = 'alice'").run()));
  await expect(f.tasks.createTask("alice", "company", f.input)).rejects.toMatchObject({ statusCode: 404 });
  expect(f.database.authQuery(db => db.prepare("SELECT * FROM forge_tasks").all())).toEqual([]);
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
  f.database.authTransaction(db => db.prepare("UPDATE forge_task_controls SET updated_at = ? WHERE task_id = ?").run(observedAt, first.task.id));
  expect(f.tasks.listTasks("alice")[0]).toMatchObject({ id: first.task.id, updatedAt: observedAt });
});

test("editing the objective checks backlog ownership in the same transaction as the write", async () => {
  const f = await fixture();
  const { task } = await f.tasks.createTask("alice", "company", { ...f.input, startImmediately: false });
  expect(f.tasks.updateTaskDetails("alice", task.id, { title: "Updated title" })).toMatchObject({ title: "Updated title", description: f.input.description });
  expect(f.tasks.repository.controls.get(task.id).objective).toBe(`Updated title\n\n${f.input.description}`);
  f.tasks.repository.setArchived(task.id, true);
  expect(f.tasks.repository.updateDetails(task.id, { title: "Archived edit" })).toBe(false);
  f.tasks.unarchiveTask("alice", task.id);
  f.tasks.startTask("alice", task.id);
  expect(f.tasks.repository.updateDetails(task.id, { title: "Late edit" })).toBe(false);
  expect(() => f.tasks.updateTaskDetails("alice", task.id, { description: "Late edit" })).toThrow("Only tasks in the backlog");
  expect(f.tasks.getTask("alice", task.id).title).toBe("Updated title");
  expect(f.tasks.repository.controls.get(task.id).objective).toBe(`Updated title\n\n${f.input.description}`);
});
