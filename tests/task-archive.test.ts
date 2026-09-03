import { expect, test } from "vitest";

import { at } from "../src/issue-phases.js";
import { buildInitialIssueWorkflowState } from "../src/engine/issue-contracts.js";
import { TaskArchiveService, type WorktreeCleanupPort } from "../src/task-archive.js";
import { TaskFailure } from "../src/tasks.js";

type FixtureOptions = { worktreeFailure?: "workflow-update-rejected" | "stale-revision"; cleanupWorktree?: WorktreeCleanupPort };

function snapshotState(step: "backlog" | "cancelled") {
  return { ...buildInitialIssueWorkflowState({ workflowId: "workflow_1", companyId: "company", projectId: "project", issueId: "task", projectRevisionId: "revision_1", briefArtifactId: "brief", imageArtifactIds: [], roleProfiles: {}, supplementalReview: false }), revision: 1, ...at(step), owner: "human" as const, allowedCommands: ["delete_worktree"], worktreeState: "present" as const, lastEventId: "workflow_1:1" };
}

function fixture(phase: "backlog" | "cancelled" = "cancelled", dirty = false, cleanupFailure = false, options: FixtureOptions = {}) {
  let archivedAt: string | null = null;
  let task = { id: "task", companyId: "company", workflowId: "workflow_1", phase, revision: 1, worktreeState: "present", allowedCommands: [] as string[], pendingAction: null as string | null };
  const commands: string[] = [];
  const projected: Record<string, unknown>[] = [];
  const tasks = {
    getTask: () => ({ ...task, archivedAt }),
    executeCommand: async (_actor: string, _taskId: string, command: string, input: { confirmDiscardDirty?: boolean }) => {
      commands.push(command);
      if (command === "delete_worktree" && options.worktreeFailure === "workflow-update-rejected") throw new TaskFailure("Refresh — this action is no longer available", [{ code: "workflow-update-rejected", field: "worktree", message: "Refresh — this action is no longer available" }], 409, { ...task, archivedAt } as never);
      if (command === "delete_worktree" && options.worktreeFailure === "stale-revision") throw new TaskFailure("Task changed before this action was accepted", [{ code: "stale-revision", field: "expectedRevision", message: "Refresh the issue before this action" }], 409, { ...task, archivedAt } as never);
      if (command === "delete_worktree" && cleanupFailure) throw new TaskFailure("Forge does not own the requested worktree", [{ code: "illegal-command", field: "phase", message: "Cleanup failed" }], 409, task as never);
      if (command === "cancel_issue") task = { ...task, phase: "cancelled", revision: task.revision + 1, allowedCommands: ["delete_worktree"] };
      if (command === "delete_worktree" && dirty && !input.confirmDiscardDirty) return { ...task, pendingAction: "Worktree has 2 uncommitted changes" };
      if (command === "delete_worktree") task = { ...task, worktreeState: "cleaned", allowedCommands: [] };
      return { ...task, archivedAt };
    },
  };
  const database = {
    authTransaction: (callback: (db: { prepare: () => { run: (...args: string[]) => void } }) => void) => callback({ prepare: () => ({ run: (...args) => { archivedAt = args.length === 3 ? args[0] ?? null : null; } }) }),
    authQuery: (callback: (db: unknown) => unknown) => callback({ prepare: () => ({ get: () => ({ state_json: JSON.stringify(snapshotState(phase)), runId: "workflow_1" }) }) }),
    projectIssueEvent: (event: Record<string, unknown>) => { projected.push(event); },
  };
  return { archive: new TaskArchiveService(tasks as never, database as never, () => new Date("2026-08-28T00:00:00.000Z"), options.cleanupWorktree ? { cleanupWorktree: options.cleanupWorktree } : {}), commands, projected, current: () => ({ ...task, archivedAt }) };
}

function port(outcomes: Array<{ outcome: "cleaned" | "already_absent" | "dirty_confirmation_required" | "not_owned"; dirtyFileCount?: number }>) {
  const calls: Array<{ input: { taskId: string; companyId: string; workflowId: string; confirmDiscardDirty?: boolean } }> = [];
  const cleanupWorktree: WorktreeCleanupPort = async (input) => {
    calls.push({ input });
    const next = outcomes[Math.min(calls.length - 1, outcomes.length - 1)] ?? outcomes[0]!;
    return { outcome: next.outcome, dirtyFileCount: next.dirtyFileCount ?? 0 };
  };
  return { cleanupWorktree, calls };
}

test("archives a terminal task by deleting its worktree", async () => {
  const value = fixture();
  const first = await value.archive.archiveTask("user", "task", 1);
  const second = await value.archive.archiveTask("user", "task", 2);
  expect(first).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(value.commands).toEqual(["delete_worktree"]);
  expect(second).toEqual(first);
});

test("rejects an active task", async () => {
  const value = fixture("backlog");
  await expect(value.archive.archiveTask("user", "task", 1)).rejects.toMatchObject({ statusCode: 409, findings: [{ code: "illegal-command" }] });
  expect(value.commands).toEqual([]);
});

test("requires dirty worktree confirmation before archiving", async () => {
  const value = fixture("cancelled", true);
  const blocked = await value.archive.archiveTask("user", "task", 1);
  const confirmed = await value.archive.archiveTask("user", "task", 1, { confirmDiscardDirty: true });
  expect(blocked).toMatchObject({ status: "confirmation_required", dirtyFileCount: 2 });
  expect(confirmed).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(value.commands).toEqual(["delete_worktree", "delete_worktree"]);
});

test("does not archive when worktree cleanup fails", async () => {
  const value = fixture("cancelled", false, true);
  await expect(value.archive.archiveTask("user", "task", 1)).rejects.toMatchObject({ statusCode: 409, message: "Worktree could not be removed", findings: [{ code: "worktree-cleanup-failed" }] });
  expect(value.current().archivedAt).toBeNull();
});

test("unarchive restores visibility without recreating the worktree", async () => {
  const value = fixture();
  await value.archive.archiveTask("user", "task", 1);
  const first = value.archive.unarchiveTask("user", "task");
  const second = value.archive.unarchiveTask("user", "task");
  expect(first).toMatchObject({ archivedAt: null });
  expect(second).toEqual(first);
  expect(value.commands).toEqual(["delete_worktree"]);
});

test("cleans the worktree locally when the workflow rejects the update, then archives", async () => {
  const fake = port([{ outcome: "cleaned" }]);
  const value = fixture("cancelled", false, false, { worktreeFailure: "workflow-update-rejected", cleanupWorktree: fake.cleanupWorktree });
  const result = await value.archive.archiveTask("user", "task", 1);
  expect(result).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(value.commands).toEqual(["delete_worktree"]);
  expect(fake.calls).toEqual([{ input: { taskId: "task", companyId: "company", workflowId: "workflow_1" } }]);
  const event = value.projected[0] as { eventId: string; state: { revision: number; allowedCommands: string[] } };
  expect(event.state).toMatchObject({ revision: 2, allowedCommands: [] });
  expect(event.state.allowedCommands).not.toContain("delete_worktree");
  expect(event.eventId).toBe("workflow_1:2");
});

test("archives when the local cleanup reports the worktree already absent", async () => {
  const fake = port([{ outcome: "already_absent" }]);
  const value = fixture("cancelled", false, false, { worktreeFailure: "workflow-update-rejected", cleanupWorktree: fake.cleanupWorktree });
  const result = await value.archive.archiveTask("user", "task", 1);
  expect(result).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(fake.calls).toHaveLength(1);
});

test("asks for dirty confirmation from the local cleanup and archives after confirmation", async () => {
  const fake = port([{ outcome: "dirty_confirmation_required", dirtyFileCount: 2 }, { outcome: "cleaned", dirtyFileCount: 2 }]);
  const value = fixture("cancelled", false, false, { worktreeFailure: "workflow-update-rejected", cleanupWorktree: fake.cleanupWorktree });
  const blocked = await value.archive.archiveTask("user", "task", 1);
  expect(blocked).toMatchObject({ status: "confirmation_required", dirtyFileCount: 2 });
  expect(value.current().archivedAt).toBeNull();
  const confirmed = await value.archive.archiveTask("user", "task", 1, { confirmDiscardDirty: true });
  expect(confirmed).toMatchObject({ status: "archived", task: { archivedAt: "2026-08-28T00:00:00.000Z" } });
  expect(fake.calls[0]?.input).not.toHaveProperty("confirmDiscardDirty");
  expect(fake.calls[1]?.input).toMatchObject({ taskId: "task", companyId: "company", workflowId: "workflow_1", confirmDiscardDirty: true });
});

test("returns 409 without archiving when the local cleanup does not own the worktree", async () => {
  const fake = port([{ outcome: "not_owned" }]);
  const value = fixture("cancelled", false, false, { worktreeFailure: "workflow-update-rejected", cleanupWorktree: fake.cleanupWorktree });
  await expect(value.archive.archiveTask("user", "task", 1)).rejects.toMatchObject({ statusCode: 409, message: "Worktree could not be removed", findings: [{ code: "worktree-cleanup-failed", message: "Forge does not own the requested worktree" }] });
  expect(value.current().archivedAt).toBeNull();
  expect(value.projected).toEqual([]);
});

test("does not run the local cleanup for a stale-revision failure", async () => {
  const fake = port([{ outcome: "cleaned" }]);
  const value = fixture("cancelled", false, false, { worktreeFailure: "stale-revision", cleanupWorktree: fake.cleanupWorktree });
  await expect(value.archive.archiveTask("user", "task", 1)).rejects.toMatchObject({ statusCode: 409, message: "Worktree could not be removed", findings: [{ code: "worktree-cleanup-failed" }] });
  expect(fake.calls).toEqual([]);
  expect(value.current().archivedAt).toBeNull();
  expect(value.projected).toEqual([]);
});

test("keeps the existing 409 when no cleanup port is injected", async () => {
  const value = fixture("cancelled", false, false, { worktreeFailure: "workflow-update-rejected" });
  await expect(value.archive.archiveTask("user", "task", 1)).rejects.toMatchObject({ statusCode: 409, message: "Worktree could not be removed", findings: [{ code: "worktree-cleanup-failed", message: "Refresh — this action is no longer available" }] });
  expect(value.current().archivedAt).toBeNull();
  expect(value.projected).toEqual([]);
});
