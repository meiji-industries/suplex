import { insertNativeTaskRow } from "./native-task-row.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ForgeDatabase } from "../../src/platform/database.js";
import { RootController } from "../../src/coordination/root-controller.js";
import { TaskControlStore } from "../../src/coordination/root-session-store.js";
import { TaskUsageSchema } from "../../src/tasks/usage.js";
import type { TaskSession } from "../../src/tasks/control.js";
import { FakeTaskHarness } from "./fake-task-harness.js";
import { createTestDatabase } from "./test-database.js";

const cleanups: Array<() => Promise<void>> = [];

export async function cleanupRootControllerFixtures(): Promise<void> {
  for (const cleanup of cleanups.splice(0)) await cleanup();
}

export function usage(sessionId: string, cost: number) {
  return TaskUsageSchema.parse({ sessionId, messageId: `usage-${cost}`, turnId: `turn-${cost}`, role: "root", provider: "openai", model: "gpt-5.6-luna", startedAt: 1, completedAt: 2, failed: false, summary: false, steps: 1, cost, subsidized: false, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, source: "message" });
}

export function ageDispatch(database: ForgeDatabase, turnId: string): void {
  database.authTransaction(db => db.prepare("UPDATE forge_task_turns SET dispatch_attempt_json = json_set(dispatch_attempt_json, '$.claimedAt', '2020-01-01T00:00:00.000Z') WHERE id = ?").run(turnId));
}

export async function fixture(startImmediately = true) {
  const directory = await mkdtemp(join(tmpdir(), "forge-native-controller-"));
  const database = createTestDatabase(join(directory, "forge.sqlite"));
  cleanups.push(async () => { database.close(); await rm(directory, { recursive: true, force: true }); });
  const stamp = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, setup_command, verification_command, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', '', '', ?, ?)").run(directory, directory, stamp, stamp);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
      insertNativeTaskRow(db);
  });
  const profile = { profileId: "profile", provider: "opencode", model: "openai/gpt-5.6-luna", reasoningLevel: "max", serviceTier: "priority" } as const;
  const store = new TaskControlStore(database);
  store.create({ taskId: "task", startImmediately, objective: "Ship it", deliveryTarget: "merged", deliveryIntent: { repository: "owner/repo", headBranch: "task", baseBranch: "main", baselineSha: "a", pullRequestNumber: null }, rootProfile: profile, workerProfile: profile, worktree: { path: directory, branch: "task", baseSha: "a", headSha: "a", dirty: false } });
  const harness = new FakeTaskHarness();
  const nativeUsage = new Map<string, ReturnType<typeof usage>[]>();
  let usageError: Error | null = null;
  const reader = (session: TaskSession) => ({
    turnEvidence: async () => ({ tools: [], limitation: null }),
    timeline: async () => {
      if (usageError) throw usageError;
      return { usage: nativeUsage.get(session.id) ?? [], liveMessageId: null };
    },
  });
  const controller = new RootController(store, harness, undefined, undefined, undefined, reader, async () => undefined);
  const identity = () => {
    const root = store.currentSession("task", "root");
    if (!root) throw new Error("Coordinator not created");
    return { taskId: "task", sessionId: root.id, generation: root.generation };
  };
  return { directory, database, store, harness, controller, identity, nativeUsage, setUsageError(error: Error | null) { usageError = error; }, reader };
}
