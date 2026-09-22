import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { nativeApp } from "./helpers/native-app.js";

test("clearing a company removes native records and artifacts but preserves worktrees and other companies", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Clear me", description: "Preserve local files", idempotencyKey: "clear-task", startImmediately: false });
    const worktree = join(value.project.worktreeRoot, "external-work");
    await mkdir(worktree, { recursive: true });
    await writeFile(join(worktree, "keep.txt"), "uncommitted work");
    value.tasks.startTask(value.userId, task.id);
    value.tasks.repository.controls.setWorktree(task.id, { path: worktree, branch: "task", baseSha: "a", headSha: "b", dirty: true });
    value.tasks.cancelTask(value.userId, task.id);
    const artifactDirectory = join(value.config.artifactRoot, value.company.id);
    await mkdir(artifactDirectory, { recursive: true });
    await writeFile(join(artifactDirectory, "attachment.png"), "test artifact");
    const other = value.auth.createCompany(value.userId, "Keep me");
    const stamp = new Date().toISOString();
    value.database.authTransaction(db => {
      db.prepare("INSERT INTO suplex_projects (id, company_id, name, repository_path, worktree_root, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('other-project', ?, 'Other project', '/other', '/other-worktrees', 'main', '', '', ?, ?)").run(other.id, stamp, stamp);
      db.prepare("INSERT INTO suplex_agents (id, name, avatar_seed, created_at, updated_at) VALUES ('clear-hermes', 'Hermes', 'seed', ?, ?)").run(stamp, stamp);
      db.prepare("INSERT INTO suplex_external_agents (id, company_id, status, created_at, updated_at) VALUES ('clear-hermes', ?, 'pending', ?, ?)").run(value.company.id, stamp, stamp);
      db.prepare("INSERT INTO suplex_external_agent_project_grants (agent_id, company_id, project_id, created_at) VALUES ('clear-hermes', ?, ?, ?)").run(value.company.id, value.project.id, stamp);
    });
    const cleared = await value.auth.clearCompany(value.userId, value.company.id);
    expect(cleared).toMatchObject({ status: "active", issueCode: null });
    for (const table of ["suplex_tasks", "suplex_projects", "suplex_external_agents", "suplex_artifacts"]) {
      expect(value.database.authQuery(db => db.prepare(`SELECT count(*) AS n FROM ${table} WHERE company_id = ?`).get(value.company.id))).toEqual({ n: 0 });
    }
    expect(value.database.authQuery(db => db.prepare("SELECT id FROM suplex_task_templates WHERE project_id = ?").all(value.project.id))).toEqual([]);
    expect(value.database.authQuery(db => db.prepare("SELECT * FROM suplex_task_controls WHERE task_id = ?").all(task.id))).toEqual([]);
    expect(value.database.authQuery(db => db.prepare("SELECT * FROM suplex_agents WHERE id = 'clear-hermes'").all())).toEqual([]);
    expect(value.database.authQuery(db => db.prepare("SELECT name FROM suplex_projects WHERE id = 'other-project'").get())).toEqual({ name: "Other project" });
    expect(value.database.authQuery(db => db.prepare("PRAGMA foreign_key_check").all())).toEqual([]);
    expect(existsSync(artifactDirectory)).toBe(false);
    expect(await readFile(join(worktree, "keep.txt"), "utf8")).toBe("uncommitted work");
    expect(value.database.authQuery(db => db.prepare("SELECT action FROM suplex_audit_events WHERE company_id = ? AND action = 'company_cleared'").all(value.company.id))).toHaveLength(1);
  } finally { await value.close(); }
});

test("clearing a company rejects active work and pending native stops without removing data", async () => {
  const value = await nativeApp();
  try {
    const { task } = await value.tasks.createTask(value.userId, value.company.id, { projectId: value.project.id, title: "Active", description: "Keep active work", idempotencyKey: "active-task", startImmediately: true });
    await expect(value.auth.clearCompany(value.userId, value.company.id)).rejects.toMatchObject({ statusCode: 409, code: "company_has_live_sessions" });
    const root = value.tasks.repository.controls.claimRoot({ taskId: task.id });
    value.tasks.cancelTask(value.userId, task.id);
    await expect(value.auth.clearCompany(value.userId, value.company.id)).rejects.toMatchObject({ statusCode: 409 });
    expect(value.tasks.getTask(value.userId, task.id).status).toBe("cancelled");
    value.tasks.repository.controls.completeStop(root.id);
    await value.auth.clearCompany(value.userId, value.company.id);
    expect(value.tasks.listTasks(value.userId, value.company.id)).toEqual([]);
  } finally { await value.close(); }
});

test("company clearing requires an administrator and preserves memberships and audit history", async () => {
  const value = await nativeApp();
  try {
    const invitation = value.auth.inviteUser(value.userId, { displayName: "Member" });
    const options = await value.auth.beginInvitationRegistration(invitation.token);
    const member = (await value.auth.completeInvitationRegistration({ token: invitation.token, challengeId: options.challengeId, response: { id: "clear-member", type: "public-key" } })).user;
    value.auth.addMembership(value.userId, member.id, value.company.id);
    await expect(value.auth.clearCompany(member.id, value.company.id)).rejects.toMatchObject({ statusCode: 404 });
    await value.auth.clearCompany(value.userId, value.company.id);
    expect(value.database.authQuery(db => db.prepare("SELECT user_id FROM suplex_memberships WHERE company_id = ?").all(value.company.id))).toEqual([{ user_id: member.id }]);
    expect(value.database.authQuery(db => db.prepare("SELECT action FROM suplex_audit_events WHERE company_id = ? AND action = 'company_cleared'").all(value.company.id))).toHaveLength(1);
  } finally { await value.close(); }
});
