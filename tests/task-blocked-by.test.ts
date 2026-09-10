import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";
import { TaskSchema } from "../src/tasks/contracts.js";

test("tasks persist and resolve an informational blocked-by task", async () => {
  const f = await nativeApp();
  try {
    const create = (title: string, key: string) => f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title, idempotencyKey: key });
    const first = await create("Prepare the schema", "blocked-by-first");
    const replacement = await create("Prepare the API", "blocked-by-replacement");
    const dependent = await create("Use the API", "blocked-by-dependent");
    const url = `/api/tasks/${dependent.task.id}/blocked-by`;

    const set = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { blockedByTaskId: first.task.id } });
    expect(set.statusCode, set.body).toBe(200);
    expect(TaskSchema.parse(set.json()).blockedBy).toMatchObject({ id: first.task.id, title: "Prepare the schema", status: "backlog" });
    expect(f.wakes).toEqual([]);

    await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { blockedByTaskId: replacement.task.id } });
    expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy).toMatchObject({ id: replacement.task.id, title: "Prepare the API", status: "backlog" });
    expect((await f.app.inject({ method: "PATCH", url: `/api/tasks/${dependent.task.id}`, headers: f.headers, payload: { description: "Keep the reference" } })).statusCode).toBe(200);
    expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy?.id).toBe(replacement.task.id);

    f.tasks.renameTask(f.userId, replacement.task.id, { title: "Prepare the updated API" });
    f.tasks.startTask(f.userId, replacement.task.id);
    expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy).toMatchObject({ title: "Prepare the updated API", status: "active" });

    f.tasks.repository.setArchived(replacement.task.id, true);
    expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy).toMatchObject({ id: replacement.task.id, title: "Prepare the updated API", status: "active" });
    expect(f.tasks.startTask(f.userId, dependent.task.id).status).toBe("active");

    const cleared = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { blockedByTaskId: null } });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect(TaskSchema.parse(cleared.json()).blockedBy).toBeNull();
  } finally { await f.close(); }
});

test("blocked-by rejects unavailable, self, and other-project tasks without mutation", async () => {
  const f = await nativeApp();
  try {
    const target = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Allowed target", idempotencyKey: "blocked-by-allowed" });
    const dependent = await f.tasks.createTask(f.userId, f.company.id, { projectId: f.project.id, title: "Dependent task", idempotencyKey: "blocked-by-invalid" });
    const otherProjectId = "project_other";
    const now = new Date().toISOString();
    f.database.authTransaction(db => db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, root_profile_id, worker_profile_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(otherProjectId, f.company.id, "Other repository", `${f.project.repositoryPath}-other`, `${f.project.worktreeRoot}-other`, "owner/other-repo", "main", "pnpm install", "pnpm test", "profile_native_root", "profile_native_worker", now, now));
    const other = await f.tasks.createTask(f.userId, f.company.id, { projectId: otherProjectId, title: "Other project task", idempotencyKey: "blocked-by-other-project" });
    const url = `/api/tasks/${dependent.task.id}/blocked-by`;

    for (const blockedByTaskId of ["task_missing", dependent.task.id, other.task.id]) {
      const response = await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { blockedByTaskId } });
      expect(response.statusCode, response.body).toBe(404);
      expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy).toBeNull();
    }

    expect((await f.app.inject({ method: "PATCH", url, headers: f.headers, payload: { blockedByTaskId: target.task.id } })).statusCode).toBe(200);
    expect(f.tasks.getTask(f.userId, dependent.task.id).blockedBy?.id).toBe(target.task.id);
  } finally { await f.close(); }
});
