import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { ForgeDatabase } from "../src/database.js";
import { RootController, productionRootRuntime } from "../src/root-controller.js";
import { TaskControlStore } from "../src/root-session-store.js";

const run = promisify(execFile);
const profile = { profileId: "profile", provider: "codex" as const, model: "gpt-5.6-sol", reasoningLevel: "medium" as const, serviceTier: "default" as const };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-root-control-"));
  const repository = join(root, "repo");
  await run("git", ["init", repository]);
  await run("git", ["-C", repository, "config", "user.email", "test@example.com"]);
  await run("git", ["-C", repository, "config", "user.name", "Test"]);
  await run("git", ["-C", repository, "commit", "--allow-empty", "-m", "seed"]);
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const stamp = new Date().toISOString();
  database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(stamp);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', ?, ?, 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(repository, root, stamp, stamp);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief', 'text/plain', 1, ?, 'brief', ?)").run("a".repeat(64), stamp);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), stamp, stamp);
  });
  const store = new TaskControlStore(database);
  store.create({ taskId: "task", objective: "Ship it", deliveryTarget: "pull request", rootProfile: profile, workerProfile: profile, worktree: { path: repository, branch: "main", baseSha: "a", headSha: "a", dirty: false } });
  return { root, database, store };
}

test("separate stores converge initial Root claim and reject a second Worker", async () => {
  const value = await fixture();
  const second = new ForgeDatabase(join(value.root, "forge.sqlite"), { migrate: false });
  try {
    const other = new TaskControlStore(second);
    const [one, two] = await Promise.all([Promise.resolve(value.store.claimRoot({ taskId: "task" })), Promise.resolve(other.claimRoot({ taskId: "task" }))]);
    expect(one.id).toBe(two.id);
    value.store.bindLive({ sessionId: one.id, generation: one.generation, paneId: "root-pane", agentName: "root" });
    const first = value.store.launchWorker({ taskId: "task", rootSessionId: one.id, rootGeneration: one.generation, instruction: "Make one change." });
    expect(() => other.launchWorker({ taskId: "task", rootSessionId: one.id, rootGeneration: one.generation, instruction: "Make another change." })).toThrow("worker_already_assigned");
    expect(first.lifecycle).toBe("reserved");
  } finally { second.close(); value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("unknown launch stays assigned and an unknown prompt is not resent from a short transcript", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  value.store.bindLive({ sessionId: root.id, generation: root.generation, paneId: "root-pane", agentName: "root" });
  const prompts: string[] = [];
  const controller = new RootController(value.store, { runtimeSnapshot: async () => ({ agents: [{ name: "root", paneId: "root-pane", status: "working" }], panes: [] }), prompt: async (_name, prompt) => { prompts.push(prompt); throw new Error("timeout"); }, readAgent: async () => "only a short tail" }, { launch: async () => { throw new Error("timeout"); } });
  try {
    await expect(controller.delegateWorker({ taskId: "task", sessionId: root.id, generation: root.generation }, "Change one file.")).rejects.toThrow("timeout");
    expect(value.store.currentSession("task", "worker")?.lifecycle).toBe("unknown");
    await controller.wakeRoot({ taskId: "task", sessionId: root.id, generation: root.generation }, "Inspect Worker evidence.");
    await controller.recover("task");
    expect(prompts).toHaveLength(1);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("duplicate Worker receipt wakes Root once and cancellation fences late receipts", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  value.store.bindLive({ sessionId: root.id, generation: root.generation, paneId: "root-pane", agentName: "root" });
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Change one file." });
  value.store.bindLive({ sessionId: worker.id, generation: worker.generation, paneId: "worker-pane", agentName: "worker" });
  const prompts: string[] = [];
  const controller = new RootController(value.store, { runtimeSnapshot: async () => ({ agents: [], panes: [] }), prompt: async (_name, prompt) => { prompts.push(prompt); return { name: "root", paneId: "root-pane" }; }, readAgent: async () => "" });
  try {
    await controller.recordWorkerResult({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "receipt", observation: "done" });
    await controller.recordWorkerResult({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "receipt", observation: "done" });
    expect(prompts).toHaveLength(1);
    value.store.cancel("task");
    expect(() => value.store.recordWorkerTurn({ taskId: "task", sessionId: worker.id, generation: worker.generation, receiptId: "late", terminalObservation: "late" })).toThrow("stale_generation");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("restart replaces a terminal Root through Herdr while retaining a live Worker", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  value.store.bindLive({ sessionId: root.id, generation: root.generation, paneId: "old-root", agentName: "old-root" });
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Keep editing." });
  value.store.bindLive({ sessionId: worker.id, generation: worker.generation, paneId: "worker", agentName: "worker", nativeSessionId: "worker-native" });
  const starts: string[] = []; const prompts: string[] = [];
  const herdr = {
    runtimeSnapshot: async () => ({ agents: [{ name: "old-root", paneId: "old-root", status: "done" }, { name: "worker", paneId: "worker", agentSession: "worker-native", status: "working" }], panes: [] }),
    readAgent: async () => "",
    prompt: async (name: string, prompt: string) => { prompts.push(`${name}:${prompt}`); return { name, paneId: "new-root", agentSession: "new-native" }; },
    createWorkspace: async () => ({ workspace: { workspaceId: "workspace", label: "task" }, tab: { tabId: "tab", label: "task" }, rootPane: { paneId: "new-root" } }),
    startAgent: async (input: { name: string; paneId: string }) => { starts.push(input.name); return { name: input.name, paneId: input.paneId, agentSession: "new-native" }; },
  };
  const controller = new RootController(value.store, herdr, undefined, productionRootRuntime(value.database.filename(), value.store, herdr));
  try {
    await controller.recover("task");
    expect(starts).toHaveLength(1); expect(prompts).toHaveLength(1);
    expect(value.store.currentSession("task", "root")?.generation).toBe(2);
    expect(value.store.currentSession("task", "worker")).toMatchObject({ id: worker.id, lifecycle: "live" });
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("recovery ingests a completed Worker transcript and wakes Root once", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  value.store.bindLive({ sessionId: root.id, generation: root.generation, paneId: "root-pane", agentName: "root" });
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Change one file." });
  value.store.bindLive({ sessionId: worker.id, generation: worker.generation, paneId: "worker-pane", agentName: "worker" });
  const marker = `forge-worker-assignment:${worker.id}:${worker.generation}:${worker.assignmentHash}`;
  const prompts: string[] = [];
  const herdr = {
    runtimeSnapshot: async () => ({ agents: [{ name: "root", paneId: "root-pane", status: "working" }, { name: "worker", paneId: "worker-pane", status: "done" }], panes: [] }),
    readAgent: async (name: string) => name === "worker" ? `completed\n[${marker}]` : "",
    prompt: async (_name: string, prompt: string) => { prompts.push(prompt); return { name: "root", paneId: "root-pane" }; },
  };
  try {
    await new RootController(value.store, herdr).recover("task");
    await new RootController(new TaskControlStore(value.database), herdr).recover("task");
    expect(prompts).toHaveLength(1);
    expect(value.store.currentSession("task", "worker")?.lifecycle).toBe("stopped");
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});

test("an idle Worker after a long pane transcript wakes Root without tail matching", async () => {
  const value = await fixture();
  const root = value.store.claimRoot({ taskId: "task" });
  value.store.bindLive({ sessionId: root.id, generation: root.generation, paneId: "root-pane", agentName: "root" });
  const worker = value.store.launchWorker({ taskId: "task", rootSessionId: root.id, rootGeneration: root.generation, instruction: "Change one file." });
  value.store.bindLive({ sessionId: worker.id, generation: worker.generation, paneId: "worker-pane", agentName: "worker" });
  const prompts: string[] = [];
  const herdr = {
    runtimeSnapshot: async () => ({ agents: [{ name: "root", paneId: "root-pane", status: "working" }, { name: "worker", paneId: "worker-pane", status: "idle" }], panes: [] }),
    readAgent: async () => Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"),
    prompt: async (_name: string, prompt: string) => { prompts.push(prompt); return { name: "root", paneId: "root-pane" }; },
  };
  try {
    await new RootController(value.store, herdr).recover("task");
    await new RootController(new TaskControlStore(value.database), herdr).recover("task");
    expect(prompts).toHaveLength(1);
  } finally { value.database.close(); await rm(value.root, { recursive: true, force: true }); }
});
