import { execFile } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

import { ArtifactStore } from "../src/artifacts.js";
import { AgentService, LeadOutputSchema, runCodexProcess, type LeadProcessRunner, type SessionStore } from "../src/codex-lead.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

const execFileAsync = promisify(execFile);

async function fixture(model = "gpt-5-codex"): Promise<{ root: string; database: ForgeDatabase; config: ReturnType<typeof createTestConfig>; briefId: string }> {
  const root = await mkdtemp(join(tmpdir(), "forge-codex-lead-test-"));
  const repositoryPath = join(root, "repo");
  await mkdir(repositoryPath, { recursive: true });
  await writeFile(join(repositoryPath, "README.md"), "fixture\n");
  await execFileAsync("git", ["init"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.email", "forge-test@example.invalid"], { cwd: repositoryPath });
  await execFileAsync("git", ["config", "user.name", "Forge Test"], { cwd: repositoryPath });
  await execFileAsync("git", ["add", "README.md"], { cwd: repositoryPath });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: repositoryPath });
  const config = createTestConfig(root, { repositoryRoot: root, artifactRoot: join(root, "artifacts"), runtimeRoot: join(root, "runtime") });
  const database = new ForgeDatabase(config.databasePath);
  const artifactStore = new ArtifactStore(config.artifactRoot);
  const brief = await artifactStore.put("company_1", "task-brief", { filename: "task.md", mimeType: "text/markdown", bytes: Buffer.from("Investigate the fixture repository.") });
  database.authQuery((db) => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO forge_users (id, display_name, username, role, status, created_at, updated_at) VALUES ('user_1', 'Forge Test', 'forge-test', 'admin', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company_1', 'Company One', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_profiles (id, name, provider, model, reasoning_level, service_priority, capacity, created_at, updated_at) VALUES ('profile_1', 'Lead', 'codex', ?, 'medium', 'standard', 1, ?, ?)").run(model, now, now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, allowed_profiles_json, role_defaults_json, status, active_revision_id, created_at, updated_at) VALUES ('project_1', 'company_1', 'Project One', ?, ?, 'acme/forge', 'main', 'main', 'pnpm install', 'pnpm test', '[]', '[\"profile_1\"]', '{\"lead\":\"profile_1\"}', 'active', 'revision_1', ?, ?)").run(repositoryPath, join(root, "worktrees"), now, now);
    db.prepare("INSERT INTO forge_project_revisions (id, project_id, revision, identity, normalized_json, actor_user_id, created_at) VALUES ('revision_1', 'project_1', 1, 'identity_1', '{\"repository\":\"acme/forge\"}', 'user_1', ?)").run(now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES (?, 'company_1', ?, ?, ?, ?, ?, ?, ?)").run(brief.id, brief.kind, brief.filename, brief.mimeType, brief.byteSize, brief.sha256, brief.storagePath, brief.createdAt);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_profiles_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, created_at, updated_at) VALUES ('task_1', 'company_1', 'project_1', 'Fixture task', ?, '[]', '{\"lead\":\"profile_1\"}', 0, 'workflow-test-issue-task_1', 'revision_1', 'idempotency_1', ?, ?)").run(brief.id, now, now);
  });
  return { root, database, config, briefId: brief.id };
}

test("Lead planning resumes the same opaque session after malformed JSON and stores only sanitized evidence", async () => {
  const value = await fixture();
  const sessions = new Map<string, string>();
  const sessionStore: SessionStore = { async create(raw) { sessions.set("session_opaque", raw); return "session_opaque"; }, async read(ref) { return sessions.get(ref) ?? ""; } };
  const calls: string[][] = [];
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4321, "2026-08-11T00:00:00.000Z");
    calls.push(invocation.args);
    if (calls.length === 1) {
      await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-session-1" }));
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "not json Bearer gho_secret" } }));
    } else {
      await invocation.onLine(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ kind: "plan", summary: "A bounded fixture plan", reproduction: null, rootCauseAnalysis: "The fixture was incomplete.", steps: [{ number: 1, instruction: "Inspect the fixture", verification: "The fixture test passes" }], compatibilityAnalysis: "No compatibility change is required.", operationalAnalysis: "The change is local.", verificationStrategy: "Run the focused suite.", unresolvedTechnicalQuestions: [] }) } }));
    }
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore });
    const result = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 });
    expect(result.leadSessionRef).toBe("session_opaque");
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("raw-session-1");
    expect(sessions.get("session_opaque")).toBe("raw-session-1");
    expect(value.database.authQuery((db) => db.prepare("SELECT status, session_ref, process_start_identity FROM forge_agent_executions WHERE id = ?").get(result.leadExecutionId))).toEqual({ status: "completed", session_ref: "session_opaque", process_start_identity: "4321:2026-08-11T00:00:00.000Z" });
    const evidence = value.database.authQuery((db) => db.prepare("SELECT a.storage_path, a.sha256 FROM forge_artifacts a WHERE a.id = ?").get(result.leadEvidenceArtifactId) as { storage_path: string; sha256: string });
    const evidenceText = await new ArtifactStore(value.config.artifactRoot).read({ storagePath: evidence.storage_path, sha256: evidence.sha256 });
    expect(evidenceText.toString("utf8")).not.toContain("gho_secret");
    expect(value.database.authQuery((db) => db.prepare("SELECT kind, revision, session_ref FROM forge_issue_outputs WHERE task_id = 'task_1'").get())).toEqual({ kind: "plan", revision: 1, session_ref: "session_opaque" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test("Lead output schema rejects unresolved technical questions and malformed blockers", () => {
  expect(LeadOutputSchema.safeParse({ kind: "plan", summary: "x", reproduction: null, rootCauseAnalysis: null, steps: [], compatibilityAnalysis: "x", operationalAnalysis: "x", verificationStrategy: "x", unresolvedTechnicalQuestions: ["choose"] }).success).toBe(false);
  expect(LeadOutputSchema.safeParse({ kind: "decision_blocker", summary: "x", evidence: "x", owner: "developer", question: "x", nextAction: "x" }).success).toBe(false);
});

test("Lead planning classifies a successful process without schema output", async () => {
  const value = await fixture();
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4323, "2026-08-11T00:00:00.000Z");
    return { exitCode: 0, stderr: "" };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_missing"; }, async read() { return "raw-missing-session"; } } });
    await expect(service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 })).rejects.toMatchObject({ code: "missing-output" });
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test.each([
  ["login-expired", "OAuth authorization required"],
  ["rate-limited", "HTTP 429: rate limit exceeded"],
  ["process-exited", "worker crashed"],
])("Lead process failures are typed without exposing provider stderr (%s)", async (code, stderr) => {
  const value = await fixture();
  const runner: LeadProcessRunner = async (invocation) => {
    await invocation.onStart(4322, "2026-08-11T00:00:00.000Z");
    await invocation.onLine(JSON.stringify({ type: "thread.started", thread_id: "raw-failure-session" }));
    return { exitCode: 1, stderr };
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner, sessionStore: { async create() { return "session_failure"; }, async read() { return "raw-failure-session"; } } });
    await expect(service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 })).rejects.toMatchObject({ code });
    const failure = value.database.authQuery((db) => db.prepare("SELECT failure_code, failure_summary FROM forge_agent_executions WHERE task_id = 'task_1'").get() as { failure_code: string; failure_summary: string });
    expect(failure).toEqual({ failure_code: code, failure_summary: "Codex Lead execution did not complete" });
    expect(failure.failure_summary).not.toContain(stderr);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
});

test.skipIf(process.env.FORGE_RUN_REAL_CODEX !== "1")("real authenticated Codex produces a Lead result in the isolated fixture repository", async () => {
  const value = await fixture(process.env.FORGE_CODEX_REAL_MODEL ?? "gpt-5.6-luna");
  const calls: string[][] = [];
  let firstTurn = true;
  const runner: LeadProcessRunner = async (invocation) => {
    calls.push(invocation.args);
    if (!firstTurn) return runCodexProcess(invocation);
    firstTurn = false;
    const lines: string[] = [];
    const result = await runCodexProcess({ ...invocation, onLine: async (line) => { lines.push(line); } });
    let changed = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const event = JSON.parse(lines[index]!) as { type?: unknown; item?: { type?: unknown; text?: unknown } };
        if (event.type === "item.completed" && event.item?.type === "agent_message" && typeof event.item.text === "string") {
          lines[index] = JSON.stringify({ ...event, item: { ...event.item, text: "not valid Lead JSON" } });
          changed = true;
          break;
        }
      } catch {
        // Ignore non-JSON diagnostic lines; the real runner already records them as evidence.
      }
    }
    expect(changed).toBe(true);
    for (const line of lines) await invocation.onLine(line);
    return result;
  };
  try {
    const service = new AgentService(value.database, value.config, { processRunner: runner });
    const result = await service.runLeadPlanning({ taskId: "task_1", companyId: "company_1", workflowId: "workflow-test-issue-task_1", projectId: "project_1", projectRevisionId: "revision_1", briefArtifactId: value.briefId, imageArtifactIds: [], roleProfiles: { lead: "profile_1" }, revision: 1 });
    expect(result.leadSessionRef).toMatch(/^session_[a-f0-9]{24}$/);
    expect(result.leadOutputKind).toBe("plan");
    expect(calls).toHaveLength(2);
    expect(calls[1]?.slice(0, 4)).toEqual(["exec", "resume", expect.any(String), "--json"]);
  } finally {
    value.database.close();
    await rm(value.root, { recursive: true, force: true });
  }
}, 180_000);
