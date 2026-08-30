import { appendFile, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { gunzipSync } from "node:zlib";

import { expect, test } from "vitest";
import { z } from "zod";

import { ArtifactStore } from "../src/artifacts.js";
import { AgentFailure } from "../src/agent-failure.js";
import { ForgeDatabase } from "../src/database.js";
import { HerdrFailure } from "../src/herdr-client.js";
import { HerdrTurnRunner, type HerdrTurnInput } from "../src/herdr-turn-runner.js";
import { IssueTimelineEvents } from "../src/issue-timeline-events.js";
import { runCommand } from "../src/command-runner.js";
import { DeveloperDeliverySchema } from "../src/developer-contracts.js";

// The runner polls Herdr every second in production; the tests only need ordering, not wall-clock time.
const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const fastSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, Math.min(ms, 20)));
const makeRunner = (...args: ConstructorParameters<typeof HerdrTurnRunner>) => new HerdrTurnRunner(args[0], args[1], args[2], args[3], args[4], args[5], args[6] ?? fastSleep, args[7]);
const ResultSchema = z.object({ status: z.enum(["ok", "blocked"]) }).strict();
const task = { taskId: "task", projectId: "project", projectSlug: "project", worktreePath: "/worktree", runtimeRoot: "" };
const line = (payload: Record<string, unknown>) => `${JSON.stringify({ timestamp: "2026-08-24T00:00:00.000Z", type: "event_msg", payload })}\n`;

interface FakeSession { id: string; provider: "codex" | "claude" | "openrouter"; agentName: string; paneId: string; codexSessionId: string | null; generation: number; rolloutPath: string | undefined; launched?: boolean; live: { name: string; paneId: string; agentSession?: string; status: string }; }

async function fixture(): Promise<{ root: string; database: ForgeDatabase; input: HerdrTurnInput<z.infer<typeof ResultSchema>>; session: FakeSession }> {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-turn-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.md', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, rollout_path, status, created_at, updated_at) VALUES ('session', 'task', 'planner', 1, 1, 'codex', 'codex-session', 'planner', 'pane', ?, 'ready', ?, ?)").run(join(root, "rollout.jsonl"), now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, heartbeat_at) VALUES ('execution', 'task', 'company', 'workflow', 'planner', 'running', 1, ?, ?)").run(now, now);
  });
  const rolloutPath = join(root, "rollout.jsonl");
  await writeFile(rolloutPath, "");
  return {
    root,
    database,
    session: { id: "session", provider: "codex", agentName: "lead", paneId: "pane", codexSessionId: "codex-session", generation: 1, rolloutPath, live: { name: "lead", paneId: "pane", agentSession: "codex-session", status: "working" } },
    input: { task: { ...task, runtimeRoot: root }, executionRole: "planner", ledger: "agent", executionId: "execution", promptKind: "plan", prompt: "Plan this", profile: { model: "gpt", reasoningLevel: "high", servicePriority: "priority" }, resultSchema: ResultSchema, schemaPath: "schema.json", companyId: "company", workflowId: "workflow", revision: 1 },
  };
}

function resultPath(prompt: string): string {
  return /Atomically write exactly one JSON object to (.+?) \(write a sibling/.exec(prompt)?.[1] ?? "";
}
function marker(prompt: string): string { return /^\[forge-turn:[^\]]+\]/.exec(prompt)?.[0] ?? ""; }
async function complete(session: FakeSession, prompt: string, result?: unknown, extra = ""): Promise<void> {
  const turn = `codex-${marker(prompt).slice(-6, -1)}`;
  await appendFile(session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: turn })}${extra}${line({ type: "task_complete", turn_id: turn, duration_ms: 1 })}`);
  if (result !== undefined) setTimeout(() => void writeFile(resultPath(prompt), JSON.stringify(result)), 10);
}

async function runScenario(callback: (prompt: string, session: FakeSession) => Promise<void>, snapshots = false): Promise<{ value: z.infer<typeof ResultSchema>; database: ForgeDatabase; root: string }> {
  const setup = await fixture();
  const herdr = {
    prompt: async (_name: string, prompt: string) => { await callback(prompt, setup.session); return setup.session.live; },
    getAgent: async () => setup.session.live,
  };
  const sessions = { ensureRoleSession: async () => setup.session };
  const artifacts = snapshots ? new ArtifactStore(join(setup.root, "artifacts"), setup.database) : undefined;
  const runner = makeRunner(setup.database, herdr as never, sessions as never, new IssueTimelineEvents(setup.database), artifacts);
  const output = await runner.run(setup.input);
  return { value: output.result, database: setup.database, root: setup.root };
}

async function freshIdentityFixture(): Promise<Awaited<ReturnType<typeof fixture>> & { candidates: string[] }> {
  const setup = await fixture();
  const worktree = join(setup.root, "worktree");
  await mkdir(worktree, { recursive: true });
  setup.input = { ...setup.input, task: { ...setup.input.task, worktreePath: worktree } };
  setup.session = {
    ...setup.session,
    codexSessionId: null,
    rolloutPath: undefined,
    live: { name: "lead", paneId: "pane", status: "working" },
  };
  setup.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET codex_session_id = NULL, rollout_path = NULL WHERE id = 'session'").run());
  return { ...setup, candidates: [] };
}

async function freshRollout(
  setup: Awaited<ReturnType<typeof freshIdentityFixture>>,
  sessionId: string,
): Promise<string> {
  const path = join(setup.root, `${sessionId}.jsonl`);
  await writeFile(path, `${JSON.stringify({ timestamp: "2026-08-24T00:00:00.000Z", type: "session_meta", payload: { session_id: sessionId, cwd: setup.input.task.worktreePath, originator: "codex-tui", cli_version: "0.149.1" } })}\n`);
  setup.candidates.push(path);
  return path;
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommand({ taskId: null, stepId: null, command: "git", args, cwd });
  if (result.exitCode !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

async function developerTurnFixture(dirty = false) {
  const setup = await fixture();
  const worktreePath = join(setup.root, "developer-worktree");
  await mkdir(worktreePath);
  await git(worktreePath, "init", "-b", "forge/issue/task");
  await git(worktreePath, "config", "user.email", "test@example.com");
  await git(worktreePath, "config", "user.name", "Test");
  await writeFile(join(worktreePath, "delivery.txt"), "base\n");
  await git(worktreePath, "add", "delivery.txt");
  await git(worktreePath, "commit", "-m", "base");
  const base = await git(worktreePath, "rev-parse", "HEAD");
  await writeFile(join(worktreePath, "delivery.txt"), "delivered\n");
  if (dirty) await writeFile(join(worktreePath, "dirty.txt"), "dirty\n");
  else { await git(worktreePath, "add", "delivery.txt"); await git(worktreePath, "commit", "-m", "delivery"); }
  const now = new Date().toISOString();
  setup.database.authQuery((db) => {
    db.prepare("UPDATE forge_agent_executions SET status = 'completed' WHERE id = 'execution'").run();
    db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at) VALUES ('developer', 'task', 'company', 'workflow', 1, 1, 'running', 'forge/issue/task', ?, ?, ?)").run(worktreePath, base, now);
    db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES ('worktree', 'task', 'company', 'project', 'workflow', ?, ?, ?, 'forge/issue/task', ?, 'lease', 'active', ?)").run(worktreePath, setup.root, worktreePath, base, now);
  });
  const input = { ...setup.input, executionId: "developer", executionRole: "builder" as const, ledger: "developer" as const, promptKind: "developer-delivery", resultSchema: DeveloperDeliverySchema };
  setup.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET session_role = 'builder' WHERE id = 'session'").run());
  return { ...setup, input };
}

test("converts non-retryable Herdr session failures at the turn boundary", async () => {
  const setup = await fixture();
  const runner = makeRunner(setup.database, {} as never, {
    ensureRoleSession: async () => { throw new HerdrFailure("guard_invalid", false, "Guard is invalid"); },
  } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toEqual(expect.objectContaining<Partial<AgentFailure>>({ code: "guard_invalid", nonRetryable: true }));
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});
test("uses the integrator execution role for the persistent session", async () => {
  const setup = await fixture();
  let ensuredRole: string | undefined;
  const herdr = {
    prompt: async (_name: string, prompt: string) => { await complete(setup.session, prompt, { status: "ok" }); return setup.session.live; },
    getAgent: async () => setup.session.live,
  };
  const sessions = { ensureRoleSession: async (_task: unknown, role: string) => { ensuredRole = role; return setup.session; } };
  const runner = makeRunner(setup.database, herdr as never, sessions as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run({ ...setup.input, executionRole: "integrator" })).resolves.toMatchObject({ result: { status: "ok" } });
    expect(ensuredRole).toBe("integrator");
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});
test("rechecks a turn completed while agent startup waits", async () => {
  const setup = await fixture();
  const turnId = `turn_${createHash("sha256").update(["execution", "plan", "0"].join("\0")).digest("hex").slice(0, 32)}`;
  const result = JSON.stringify({ status: "ok" });
  const path = join(setup.root, "herdr-results", "task", "planner", `result-${turnId}.json`);
  let prompts = 0;
  const herdr = {
    prompt: async () => {
      prompts += 1;
      return setup.session.live;
    },
  };
  const sessions = {
    ensureRoleSession: async () => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, result);
      const now = new Date().toISOString();
      setup.database.authQuery((db) => db.prepare(
        "INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_path, correction_index, status, result_sha256, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)",
      ).run(
        turnId,
        "task",
        "session",
        "planner",
        "agent",
        "execution",
        "plan",
        createHash("sha256").update("concurrent prompt").digest("hex"),
        `herdr-results/task/planner/result-${turnId}.json`,
        null,
        0,
        createHash("sha256").update(result).digest("hex"),
        now,
        now,
      ));
      return setup.session;
    },
  };
  const runner = makeRunner(setup.database, herdr as never, sessions as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toBe(0);
  } finally {
    setup.database.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("accepts an OMP argv result written while Herdr waits for readiness", async () => {
  const setup = await fixture();
  const ompHome = join(setup.root, "omp");
  const previousOmpHome = process.env.OMP_HOME;
  const turnId = `turn_${createHash("sha256").update(["execution", "plan", "0"].join("\0")).digest("hex").slice(0, 32)}`;
  const path = join(setup.root, "herdr-results", "task", "planner", `result-${turnId}.json`);
  const dispatchAt = new Date("2026-08-30T00:00:00.000Z");
  setup.session = {
    ...setup.session,
    provider: "openrouter",
    codexSessionId: null,
    rolloutPath: undefined,
    launched: true,
    live: { name: "lead", paneId: "pane", status: "idle" },
  };
  setup.input = {
    ...setup.input,
    profile: { ...setup.input.profile, provider: "openrouter", model: "anthropic/claude-sonnet-4.5" },
  };
  setup.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET provider_kind = 'openrouter', codex_session_id = NULL, rollout_path = NULL WHERE id = 'session'").run());
  process.env.OMP_HOME = ompHome;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ status: "blocked" }));
  let initialPrompt: { path: string; content: string } | undefined;
  let getCalls = 0;
  const herdr = {
    prompt: async () => { throw new Error("fresh argv prompts must not be resent"); },
    getAgent: async () => {
      getCalls += 1;
      const transcriptPath = join(ompHome, "agent", "sessions", "project", "session.jsonl");
      if (getCalls === 1) {
        await mkdir(dirname(transcriptPath), { recursive: true });
        await writeFile(transcriptPath, `${JSON.stringify({ type: "session", id: "omp-session", cwd: setup.input.task.worktreePath })}\n${JSON.stringify({ type: "message", id: "omp-turn", timestamp: "2026-08-30T00:00:00.000Z", role: "user", message: { content: [{ type: "text", text: marker(initialPrompt!.content) }] } })}\n${JSON.stringify({ type: "message", timestamp: "2026-08-30T00:00:00.000Z", role: "assistant", stopReason: "stop", message: { content: [{ type: "text", text: "done" }] } })}\n`);
      }
      return { ...setup.session.live, agentSession: transcriptPath, screenDetectionSkipped: true };
    },
  };
  const sessions = {
    ensureRoleSession: async (_task: unknown, _role: unknown, _settings: unknown, options?: { initialPrompt?: { path: string; content: string } }) => {
      initialPrompt = options?.initialPrompt;
      await writeFile(path, JSON.stringify({ status: "ok" }));
      await utimes(path, dispatchAt, dispatchAt);
      return setup.session;
    },
  };
  let nowCalls = 0;
  const runner = makeRunner(
    setup.database,
    herdr as never,
    sessions as never,
    new IssueTimelineEvents(setup.database),
    undefined,
    undefined,
    async (ms) => {
      if (ms !== 250) throw new Error("stale argv result waited instead of being accepted");
    },
    () => new Date(dispatchAt.getTime() + Math.min(nowCalls++, 1) * 2_000),
  );
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ sessionId: "omp-session", result: { status: "ok" } });
    expect((await readdir(dirname(path))).some((name) => name.includes(".quarantine-"))).toBe(true);
    expect(setup.database.authQuery((db) => db.prepare("SELECT prompt_sent_at FROM forge_herdr_turns").get())).toEqual({ prompt_sent_at: dispatchAt.toISOString() });
  } finally {
    if (previousOmpHome === undefined) delete process.env.OMP_HOME;
    else process.env.OMP_HOME = previousOmpHome;
    setup.database.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});
test("accepts a fresh argv prompt from a title-prefixed OMP transcript reported by path", async () => {
  const setup = await fixture();
  const ompHome = join(setup.root, "omp");
  const previousOmpHome = process.env.OMP_HOME;
  setup.session = {
    ...setup.session,
    provider: "openrouter",
    codexSessionId: null,
    rolloutPath: undefined,
    launched: true,
    live: { name: "lead", paneId: "pane", status: "idle" },
  };
  setup.input = { ...setup.input, profile: { ...setup.input.profile, provider: "openrouter", model: "anthropic/claude-sonnet-4.5" } };
  setup.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET provider_kind = 'openrouter', codex_session_id = NULL, rollout_path = NULL WHERE id = 'session'").run());
  process.env.OMP_HOME = ompHome;
  let initialPrompt: { path: string; content: string } | undefined;
  let getCalls = 0;
  const herdr = {
    prompt: async () => { throw new Error("fresh argv prompts must not be resent"); },
    getAgent: async () => {
      getCalls += 1;
      const prompt = initialPrompt!;
      const transcriptPath = join(ompHome, "agent", "sessions", "project", "session.jsonl");
      if (getCalls === 1) {
        await mkdir(dirname(transcriptPath), { recursive: true });
        await writeFile(transcriptPath, `${JSON.stringify({ type: "title", v: 1, title: "" })}\n${JSON.stringify({ type: "session", id: "omp-session", cwd: setup.input.task.worktreePath })}\n${JSON.stringify({ type: "message", id: "omp-turn", timestamp: "2026-08-28T12:00:00.000Z", role: "user", message: { content: [{ type: "text", text: marker(prompt.content) }] } })}\n${JSON.stringify({ type: "message", timestamp: "2026-08-28T12:00:01.000Z", role: "assistant", stopReason: "stop", message: { content: [{ type: "text", text: "done" }] } })}\n`);
      } else if (getCalls === 3) {
        await writeFile(resultPath(prompt.content), JSON.stringify({ status: "ok" }));
        // Linux stamps files from a coarse clock that can trail promptSentAt by a tick; make that deterministic here.
        await utimes(resultPath(prompt.content), new Date(Date.now() - 5), new Date(Date.now() - 5));
      }
      return { ...setup.session.live, agentSession: transcriptPath, screenDetectionSkipped: true };
    },
  };
  const sessions = {
    ensureRoleSession: async (_task: unknown, _role: unknown, _settings: unknown, options?: { initialPrompt?: { path: string; content: string } }) => {
      initialPrompt = options?.initialPrompt;
      return setup.session;
    },
  };
  const runner = makeRunner(setup.database, herdr as never, sessions as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ sessionId: "omp-session", result: { status: "ok" } });
    expect(initialPrompt).toMatchObject({ path: expect.stringMatching(/\.forge$/), content: expect.stringMatching(/^\[forge-turn:/) });
  } finally {
    if (previousOmpHome === undefined) delete process.env.OMP_HOME;
    else process.env.OMP_HOME = previousOmpHome;
    setup.database.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});



test("follows a preassigned Claude transcript after its cwd changes", async () => {
  const setup = await fixture();
  const configDir = join(setup.root, "claude");
  const worktree = join(setup.root, "tmp", "x");
  const sessionId = "f9fbc9cf-5bbf-46dd-81d1-740ba276db64";
  const transcriptTurnId = "f1d7a8e8-9915-4bf5-ae24-5b2836797c4c";
  const transcriptPath = join(configDir, "projects", "-tmp-x", `${sessionId}.jsonl`);
  const relocatedPath = join(configDir, "projects", "-other-cwd", `${sessionId}.jsonl`);
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR;
  let expectedTurnId = "";
  const previous = `${JSON.stringify({ type: "assistant", sessionId, timestamp: "2026-08-26T00:00:00.000Z", message: { content: [{ type: "text", text: "Earlier turn." }] } })}\n`;
  try {
    await Promise.all([mkdir(dirname(transcriptPath), { recursive: true }), mkdir(dirname(relocatedPath), { recursive: true }), mkdir(worktree, { recursive: true })]);
    await writeFile(transcriptPath, previous);
    await utimes(transcriptPath, new Date("2026-08-27T00:00:00.000Z"), new Date("2026-08-27T00:00:00.000Z"));
    process.env.CLAUDE_CONFIG_DIR = configDir;
    setup.input = {
      ...setup.input,
      task: { ...setup.input.task, worktreePath: worktree },
      profile: { provider: "claude", model: "claude-fable-5", reasoningLevel: "high", servicePriority: "standard" },
    };
    setup.session = {
      ...setup.session,
      provider: "claude",
      codexSessionId: sessionId,
      rolloutPath: transcriptPath,
      live: { ...setup.session.live, agentSession: sessionId },
    };
    setup.database.authQuery((db) =>
      db.prepare("UPDATE forge_herdr_role_sessions SET provider_kind = 'claude', codex_session_id = ?, rollout_path = ? WHERE id = 'session'").run(sessionId, transcriptPath),
    );
    const herdr = {
      prompt: async (_name: string, prompt: string) => {
        expectedTurnId = marker(prompt).slice("[forge-turn:".length, -1);
        await writeFile(relocatedPath, [
          previous,
          JSON.stringify({
            type: "user",
            uuid: transcriptTurnId,
            sessionId,
            timestamp: "2026-08-27T00:00:00.000Z",
            cwd: worktree,
            message: { role: "user", content: marker(prompt) },
          }),
          JSON.stringify({
            type: "assistant",
            sessionId,
            timestamp: "2026-08-27T00:00:01.000Z",
            message: {
              content: [{ type: "text", text: "Done." }],
              usage: { input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 },
            },
          }),
          JSON.stringify({
            type: "system",
            subtype: "turn_duration",
            sessionId,
            timestamp: "2026-08-27T00:00:02.000Z",
            durationMs: 1,
          }),
          "",
        ].join("\n"));
        await utimes(relocatedPath, new Date("2026-08-27T00:01:00.000Z"), new Date("2026-08-27T00:01:00.000Z"));
        await writeFile(resultPath(prompt), JSON.stringify({ status: "ok" }));
        return setup.session.live;
      },
      getAgent: async () => setup.session.live,
    };
    const runner = makeRunner(
      setup.database,
      herdr as never,
      { ensureRoleSession: async () => setup.session } as never,
      new IssueTimelineEvents(setup.database),
    );

    await expect(runner.run(setup.input)).resolves.toMatchObject({ sessionId, result: { status: "ok" } });
    expect(setup.database.authQuery((db) =>
      db.prepare("SELECT codex_session_id, rollout_path FROM forge_herdr_role_sessions WHERE id = 'session'").get(),
    )).toEqual({ codex_session_id: sessionId, rollout_path: relocatedPath });
    expect(setup.database.authQuery((db) =>
      db.prepare("SELECT rollout_start_offset, rollout_cursor_offset FROM forge_herdr_turns WHERE task_id = 'task'").get(),
    )).toEqual({ rollout_start_offset: Buffer.byteLength(`${previous}\n`), rollout_cursor_offset: expect.any(Number) });
    expect(setup.database.authQuery((db) =>
      db.prepare("SELECT forge_turn_id FROM forge_issue_timeline WHERE session_id = ?").all(sessionId),
    )).toEqual(Array.from({ length: 5 }, () => ({ forge_turn_id: expectedTurnId })));
  } finally {
    if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousConfigDir;
    setup.database.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test("keeps retryable Herdr client failures retryable at the turn boundary", async () => {
  const setup = await fixture();
  const runner = makeRunner(setup.database, {
    prompt: async () => { throw new HerdrFailure("timeout", true, "Herdr timed out"); },
  } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toEqual(expect.objectContaining<Partial<AgentFailure>>({ code: "timeout", nonRetryable: false }));
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("settles a turn when the Herdr prompt fails before dispatch", async () => {
  const setup = await fixture();
  const runner = makeRunner(setup.database, {
    prompt: async () => { throw new HerdrFailure("timeout", true, "Herdr timed out"); },
  } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toEqual(expect.objectContaining<Partial<AgentFailure>>({ code: "timeout", nonRetryable: false }));
    expect(setup.database.authQuery((db) => db.prepare("SELECT status, prompt_sent_at AS promptSentAt FROM forge_herdr_turns").get())).toEqual({ status: "failed", promptSentAt: null });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("binds and persists a fresh session after the first prompt reports agentSession", async () => {
  const setup = await freshIdentityFixture();
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      const path = await freshRollout(setup, "fresh-session");
      setup.session = { ...setup.session, rolloutPath: path, live: { ...setup.session.live, agentSession: "fresh-session" } };
      await complete(setup.session, prompt, { status: "ok" });
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ sessionId: "fresh-session", result: { status: "ok" } });
    expect(setup.database.authQuery((db) => db.prepare("SELECT codex_session_id, rollout_path, status FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ codex_session_id: "fresh-session", rollout_path: setup.candidates[0], status: "ready" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("falls back to exactly one new cwd-matching rollout when Herdr omits agentSession", async () => {
  const setup = await freshIdentityFixture();
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      const path = await freshRollout(setup, "fallback-session");
      setup.session = { ...setup.session, rolloutPath: path };
      await complete(setup.session, prompt, { status: "ok" });
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ sessionId: "fallback-session" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("keeps polling through ambiguity until Herdr reports the session", async () => {
  const setup = await freshIdentityFixture();
  let reported = false;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      await freshRollout(setup, "first-session");
      const path = await freshRollout(setup, "reported-session");
      setup.session = { ...setup.session, rolloutPath: path };
      await complete(setup.session, prompt, { status: "ok" });
      return setup.session.live;
    },
    getAgent: async () => reported ? { ...setup.session.live, agentSession: "reported-session" } : setup.session.live,
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates, async () => { reported = true; });
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ sessionId: "reported-session" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("resolves ambiguous candidates through one matching Forge marker", async () => {
  const setup = await freshIdentityFixture();
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      await freshRollout(setup, "unmarked-session");
      const path = await freshRollout(setup, "marked-session");
      setup.session = { ...setup.session, rolloutPath: path };
      await complete(setup.session, prompt, { status: "ok" });
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ sessionId: "marked-session" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("multiple marker candidates prefer Herdr's report, otherwise the newest", async () => {
  const setup = await freshIdentityFixture();
  let reported = false;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      const older = await freshRollout(setup, "reported-session");
      const newer = await freshRollout(setup, "newest-session");
      setup.session = { ...setup.session, rolloutPath: newer };
      await appendFile(newer, line({ type: "user_message", message: marker(prompt) }));
      await complete({ ...setup.session, rolloutPath: older }, prompt, { status: "ok" });
      await utimes(older, new Date(0), new Date(1_000));
      await utimes(newer, new Date(0), new Date(2_000));
      return setup.session.live;
    },
    getAgent: async () => reported ? { ...setup.session.live, agentSession: "reported-session" } : setup.session.live,
  };
  const sessions = { ensureRoleSession: async () => setup.session };
  const reportedRunner = makeRunner(setup.database, herdr as never, sessions as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
  try {
    const running = reportedRunner.run(setup.input);
    reported = true;
    await expect(running).resolves.toMatchObject({ sessionId: "reported-session" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});


test("binds the Forge marker to its following Codex task_started turn", async () => {
  const outcome = await runScenario(async (prompt, session) => complete(session, prompt, { status: "ok" }));
  try {
    expect(outcome.value).toEqual({ status: "ok" });
    expect(outcome.database.authQuery((db) => db.prepare("SELECT codex_turn_id FROM forge_herdr_turns").get())).toMatchObject({ codex_turn_id: expect.stringMatching(/^codex-/) });
  } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("styles the effective dispatched prompt and records its identity", async () => {
  let sent = "";
  const outcome = await runScenario(async (prompt, session) => {
    sent = prompt;
    await complete(session, prompt, { status: "ok" });
  });
  try {
    expect(sent).toContain("Plan this");
    expect(sent.match(/Forge response style/g)).toHaveLength(1);
    expect(sent).toContain("ASD-STE100 Simplified Technical English");
    expect(sent).toContain("Do not alter required JSON keys, enum values, identifiers, paths, commands, code, quoted text, or schema-required formats.");
    expect(outcome.database.authQuery((db) => db.prepare("SELECT prompt_sha256 FROM forge_herdr_turns").get())).toEqual({ prompt_sha256: createHash("sha256").update(sent).digest("hex") });
  } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});


test("binds a marker to the active Codex turn when task_started arrives first", async () => {
  const outcome = await runScenario(async (prompt, session) => {
    await appendFile(session.rolloutPath!, `${line({ type: "task_started", turn_id: "active" })}${line({ type: "user_message", message: "AGENTS.md instructions injected by Codex" })}${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_complete", turn_id: "active", duration_ms: 1 })}`);
    setTimeout(() => void writeFile(resultPath(prompt), JSON.stringify({ status: "ok" })), 10);
  });
  try {
    expect(outcome.value).toEqual({ status: "ok" });
    expect(outcome.database.authQuery((db) => db.prepare("SELECT codex_turn_id FROM forge_herdr_turns").get())).toEqual({ codex_turn_id: "active" });
  } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("does not bind a second marker to a finished turn", async () => {
  const outcome = await runScenario(async (prompt, session) => {
    await appendFile(session.rolloutPath!, `${line({ type: "task_started", turn_id: "first" })}${line({ type: "task_complete", turn_id: "first", duration_ms: 1 })}${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "second" })}${line({ type: "task_complete", turn_id: "second", duration_ms: 1 })}`);
    await writeFile(resultPath(prompt), JSON.stringify({ status: "ok" }));
  });
  try {
    expect(outcome.value).toEqual({ status: "ok" });
    expect(outcome.database.authQuery((db) => db.prepare("SELECT codex_turn_id FROM forge_herdr_turns").get())).toEqual({ codex_turn_id: "second" });
  } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("claims the completion-bound result version once without quarantining it", async () => {
  const setup = await fixture();
  let prompts = 0;
  let path = "";
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts += 1;
      path = resultPath(prompt);
      const turn = "bound";
      await appendFile(
        setup.session.rolloutPath!,
        `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: turn })}`,
      );
      await writeFile(path, JSON.stringify({ status: "ok" }));
      await appendFile(setup.session.rolloutPath!, line({ type: "task_complete", turn_id: turn, duration_ms: 1 }));
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toBe(1);
    expect(await readFile(path, "utf8")).toBe(JSON.stringify({ status: "ok" }));
    expect((await readdir(dirname(path))).filter((name) => name.includes(".quarantine-"))).toEqual([]);
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("accepts a result written after the prompt and before the bound completion", async () => {
  const outcome = await runScenario(async (prompt, session) => {
    await appendFile(session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "bound" })}`);
    await writeFile(resultPath(prompt), JSON.stringify({ status: "blocked" }));
    await appendFile(session.rolloutPath!, line({ type: "task_complete", turn_id: "bound", duration_ms: 1 }));
  });
  try { expect(outcome.value).toEqual({ status: "blocked" }); } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("does not claim a result version rewritten after completion", async () => {
  const outcome = await runScenario(async (prompt, session) => {
    const path = resultPath(prompt);
    await appendFile(session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "first" })}`);
    await writeFile(path, JSON.stringify({ status: "blocked" }));
    await appendFile(session.rolloutPath!, line({ type: "task_complete", turn_id: "first", duration_ms: 1 }));
    setTimeout(() => void writeFile(path, JSON.stringify({ status: "blocked", rewritten: true })), 10);
    setTimeout(() => {
      void appendFile(session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "redirected" })}`).then(async () => {
        await writeFile(path, JSON.stringify({ status: "ok" }));
        await appendFile(session.rolloutPath!, line({ type: "task_complete", turn_id: "redirected", duration_ms: 1 }));
      });
    }, 1_100);
  });
  try { expect(outcome.value).toEqual({ status: "ok" }); } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("a human steering turn after completion invalidates the claim", async () => {
  const outcome = await runScenario(async (prompt, session) => {
    const turn = "first";
    await appendFile(session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: turn })}${line({ type: "task_complete", turn_id: turn, duration_ms: 1 })}${line({ type: "user_message", message: "Please redirect the work" })}`);
    setTimeout(() => {
      void appendFile(session.rolloutPath!, `${line({ type: "task_started", turn_id: "redirected" })}${line({ type: "task_complete", turn_id: "redirected", duration_ms: 1 })}`);
      setTimeout(() => void writeFile(resultPath(prompt), JSON.stringify({ status: "ok" })), 1_100);
    }, 1_025);
  });
  try { expect(outcome.value).toEqual({ status: "ok" }); } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("does not claim a result written during a marker-bound replacement turn", async () => {
  const setup = await fixture();
  let finishReplacement = true;
  const runner = makeRunner(setup.database, {
    prompt: async (_name: string, prompt: string) => {
      const path = resultPath(prompt);
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "first" })}${line({ type: "task_complete", turn_id: "first", duration_ms: 1 })}${line({ type: "user_message", message: "Please redirect the work" })}${line({ type: "task_started", turn_id: "replacement" })}`);
      await writeFile(path, JSON.stringify({ status: "ok" }));
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
  } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, undefined, async () => {
    if (finishReplacement) {
      finishReplacement = false;
      await appendFile(setup.session.rolloutPath!, line({ type: "task_complete", turn_id: "replacement", duration_ms: 1 }));
    }
  });
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ result: { status: "ok" } });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("stops promptly when its AbortSignal is aborted", async () => {
  const setup = await fixture();
  const controller = new AbortController();
  controller.abort();
  const runner = makeRunner(setup.database, { prompt: async () => setup.session.live } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run({ ...setup.input, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled", nonRetryable: true });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("stops cancelled executions without relaunching a missing agent", async () => {
  const setup = await fixture();
  let prompts = 0;
  setup.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'cancelled' WHERE id = 'execution'").run());
  const runner = makeRunner(setup.database, {
    prompt: async () => { prompts += 1; return setup.session.live; },
    getAgent: async () => undefined,
  } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toMatchObject({ code: "cancelled", nonRetryable: true });
    expect(prompts).toBe(1);
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("heartbeats a waiting execution", async () => {
  const setup = await fixture();
  const before = setup.database.authQuery((db) => db.prepare("SELECT heartbeat_at FROM forge_agent_executions WHERE id = 'execution'").get() as { heartbeat_at: string }).heartbeat_at;
  const controller = new AbortController();
  const runner = makeRunner(setup.database, {
    prompt: async (_name: string, prompt: string) => {
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "waiting" })}`);
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
  } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, undefined, async () => controller.abort());
  try {
    await expect(runner.run({ ...setup.input, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled", nonRetryable: true });
    expect(setup.database.authQuery((db) => db.prepare("SELECT heartbeat_at FROM forge_agent_executions WHERE id = 'execution'").get())).not.toEqual({ heartbeat_at: before });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("claims a stable post-prompt result that appears after completion", async () => {
  let sent = "";
  const outcome = await runScenario(async (prompt, session) => {
    sent = prompt;
    await complete(session, prompt);
    setTimeout(() => void writeFile(resultPath(prompt), JSON.stringify({ status: "ok" })), 100);
  });
  try { expect(sent).toContain("Forge completion contract"); expect(outcome.value).toEqual({ status: "ok" }); } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("sends one format correction to a fresh result path", async () => {
  let paths: string[] = [];
  const prompts: string[] = [];
  const outcome = await runScenario(async (prompt, session) => {
    prompts.push(prompt);
    paths = [...paths, resultPath(prompt)];
    await complete(session, prompt, paths.length === 1 ? { wrong: true } : { status: "ok" });
  });
  try {
    expect(paths).toHaveLength(2);
    expect(paths[0]).not.toBe(paths[1]);
    expect(prompts[1]).toContain("previous result file failed schema validation");
    expect(prompts[1]).toContain("status");
    for (const prompt of prompts) expect(prompt.match(/Forge response style/g)).toHaveLength(1);
    expect(outcome.value).toEqual({ status: "ok" });
  } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("skips malformed rollout rows while accepting the bound completion", async () => {
  const malformed = await readFile(join(process.cwd(), "tests/fixtures/codex-rollout/malformed-line.jsonl"), "utf8");
  const outcome = await runScenario(async (prompt, session) => complete(session, prompt, { status: "ok" }, malformed));
  try { expect(outcome.value).toEqual({ status: "ok" }); } finally { outcome.database.close(); await rm(outcome.root, { recursive: true, force: true }); }
});

test("surfaces an error completion", async () => {
  const setup = await fixture();
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "error" })}${line({ type: "task_complete", turn_id: "error", duration_ms: 1, error: "interrupted" })}`);
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toMatchObject({ code: "turn-failed" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("keeps a reviewer pane persistent when its turn fails", async () => {
  const setup = await fixture();
  setup.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET session_role = 'reviewer' WHERE id = 'session'").run());
  let closed = false;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "error" })}${line({ type: "task_complete", turn_id: "error", duration_ms: 1, error: "interrupted" })}`);
      return setup.session.live;
    },
    getAgent: async () => setup.session.live,
    closePane: async () => { closed = true; },
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run({ ...setup.input, executionRole: "reviewer" })).rejects.toMatchObject({ code: "turn-failed" });
    expect(closed).toBe(false);
    expect(setup.database.authQuery((db) => db.prepare("SELECT pane_id, status, is_current FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ pane_id: "pane", status: "ready", is_current: 1 });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("records blocked agent attention while the turn stays alive", async () => {
  let prompted = false;
  const setup = await fixture();
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompted = true;
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "blocked" })}`);
      return setup.session.live;
    },
    getAgent: async () => {
      if (prompted) {
        prompted = false;
        await appendFile(setup.session.rolloutPath!, line({ type: "task_complete", turn_id: "blocked", duration_ms: 1 }));
        return { ...setup.session.live, status: "blocked" };
      }
      return setup.session.live;
    },
    readAgent: async () => "Select the deployment target:\nOptions:\n- staging\n- production",
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, undefined, realSleep); // samples the DB between two real 1s polls
  try {
    const running = runner.run(setup.input);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(setup.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ status: "blocked" });
    expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns").get())).toEqual({ status: "blocked", attention_excerpt: "Select the deployment target: Options: - staging - production" });
    const row = setup.database.authQuery((db) => db.prepare("SELECT result_relative_path FROM forge_herdr_turns").get() as { result_relative_path: string });
    setTimeout(() => void writeFile(join(setup.root, row.result_relative_path!), JSON.stringify({ status: "ok" })), 1_100);
    await expect(running).resolves.toMatchObject({ result: { status: "ok" } });
    expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_activated_at FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ status: "ready", attention_activated_at: null });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("does not reset attention activation for an unchanged waiting turn", async () => {
  const setup = await fixture();
  const runner = makeRunner(setup.database, {} as never, {} as never, new IssueTimelineEvents(setup.database));
  // Exercise durable state transitions without a live Herdr client.
  const runnerInternals = runner as unknown as {
    create: (turnId: string, input: HerdrTurnInput<z.infer<typeof ResultSchema>>, session: FakeSession, path: string, correction: number, prompt: string) => void;
    updateAttention: (session: FakeSession, turnId: string, status: "awaiting_human", excerpt: string) => Promise<void>;
  };
  try {
    runnerInternals.create("turn", setup.input, setup.session, join(setup.root, "turn.json"), 0, setup.input.prompt);
    await runnerInternals.updateAttention(setup.session, "turn", "awaiting_human", "Which target?");
    const first = setup.database.authQuery((db) => db.prepare("SELECT attention_activated_at FROM forge_herdr_role_sessions WHERE id = 'session'").get()) as { attention_activated_at: string };
    await runnerInternals.updateAttention(setup.session, "turn", "awaiting_human", "Which target?");
    expect(setup.database.authQuery((db) => db.prepare("SELECT attention_activated_at FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual(first);
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("marks a settled question as awaiting human and clears it when work resumes", async () => {
  const setup = await fixture();
  let state = "idle";
  let prompts = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts += 1;
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "question" })}${line({ type: "agent_message", message: "Which deployment target should I use?" })}`);
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, status: state }),
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    const running = runner.run(setup.input);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns").get())).toEqual({ status: "awaiting_human", attention_excerpt: "Which deployment target should I use?" });
    expect(prompts).toBe(1);
    state = "working";
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns").get())).toEqual({ status: "waiting", attention_excerpt: null });
    await appendFile(setup.session.rolloutPath!, line({ type: "task_complete", turn_id: "question", duration_ms: 1 }));
    const row = setup.database.authQuery((db) =>
      db.prepare("SELECT result_relative_path FROM forge_herdr_turns").get(),
    ) as { result_relative_path: string };
    setTimeout(
      () => void writeFile(join(setup.root, row.result_relative_path), JSON.stringify({ status: "ok" })),
      1_050,
    );
    await expect(running).resolves.toMatchObject({ result: { status: "ok" } });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("recognizes explicit options blocks without a trailing question mark", async () => {
  const setup = await fixture();
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "options" })}${line({ type: "agent_message", message: "Question: choose a target\nOptions:\n- staging\n- production" })}`);
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, status: "done" }),
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    const running = runner.run(setup.input);
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns").get())).toEqual({ status: "awaiting_human", attention_excerpt: "Question: choose a target Options: - staging - production" });
    await appendFile(setup.session.rolloutPath!, line({ type: "task_complete", turn_id: "options", duration_ms: 1 }));
    const row = setup.database.authQuery((db) => db.prepare("SELECT result_relative_path FROM forge_herdr_turns").get() as { result_relative_path: string });
    setTimeout(() => void writeFile(join(setup.root, row.result_relative_path), JSON.stringify({ status: "ok" })), 1_050);
    await expect(running).resolves.toMatchObject({ result: { status: "ok" } });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});



test("does not surface a momentarily idle unbound turn that resumes work", async () => {
  const setup = await fixture();
  let state = "idle";
  let sent = "";
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      sent = prompt;
      await appendFile(setup.session.rolloutPath!, `${line({ type: "task_started", turn_id: "idle" })}${line({ type: "agent_message", message: "I am reviewing the repository." })}`);
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, status: state }),
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    const running = runner.run(setup.input);
    await new Promise((resolve) => setTimeout(resolve, 75));
    state = "working";
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns").get())).toEqual({ status: "waiting", attention_excerpt: null });
    const row = setup.database.authQuery((db) => db.prepare("SELECT result_relative_path FROM forge_herdr_turns").get() as { result_relative_path: string });
    await writeFile(join(setup.root, row.result_relative_path), JSON.stringify({ status: "ok" }));
    await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(sent) })}${line({ type: "task_complete", turn_id: "idle", duration_ms: 1 })}`);
    await expect(running).resolves.toMatchObject({ result: { status: "ok" } });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("idle with no result sends one nudge, awaits human, and adopts the late result", async () => {
  const setup = await fixture();
  let prompts = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts += 1;
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "silent" })}${line({ type: "task_complete", turn_id: "silent", duration_ms: 1 })}`);
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, status: "idle", screenDetectionSkipped: true }),
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    const running = runner.run(setup.input);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const row = setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt, result_relative_path FROM forge_herdr_turns").get() as { status: string; attention_excerpt: string; result_relative_path: string });
    expect(row).toMatchObject({ status: "awaiting_human", attention_excerpt: expect.stringContaining(`Agent remained idle without writing ${join(setup.root, row.result_relative_path)}`) });
    expect(prompts).toBe(2);
    setTimeout(() => void writeFile(join(setup.root, row.result_relative_path), JSON.stringify({ status: "ok" })), 1_050);
    await expect(running).resolves.toMatchObject({ result: { status: "ok" } });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("synthesizes one Developer delivery from a clean Git handoff", async () => {
  const setup = await developerTurnFixture();
  let prompts = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts += 1;
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "developer" })}${line({ type: "task_complete", turn_id: "developer", duration_ms: 1 })}`);
      return { ...setup.session.live, status: "idle" };
    },
    getAgent: async () => ({ ...setup.session.live, status: "idle" }),
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    const first = await runner.run(setup.input);
    const second = await runner.run(setup.input);
    expect(first.result.summary).toMatch(/^Delivery taken from Git commit/);
    expect(second.resultHash).toBe(first.resultHash);
    expect(prompts).toBe(1);
    const event = setup.database.authQuery((db) => db.prepare("SELECT idempotency_key FROM forge_developer_execution_events WHERE execution_id = 'developer'").all());
    expect(event).toEqual([{ idempotency_key: `git-handoff:${first.result.resultCommit}` }]);
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});




test("adopts a persisted waiting turn after marker-start-completion without prompting again", async () => {
  const setup = await fixture();
  const turnId = "turn_01b63006007efef685185032a0737895";
  const path = join(setup.root, "herdr-results", "task", "planner", `result-${turnId}.json`);
  const promptSentAt = new Date(Date.now() - 1_000).toISOString();
  const rollout = `${line({ type: "user_message", message: `[forge-turn:${turnId}]` })}${line({ type: "task_started", turn_id: "codex-turn" })}${line({ type: "task_complete", turn_id: "codex-turn", duration_ms: 1 })}`;
  let prompts = 0;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ status: "ok" }));
    await appendFile(setup.session.rolloutPath!, rollout);
    setup.database.authQuery((db) => db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_path, rollout_start_offset, rollout_cursor_offset, prompt_sent_at, status, created_at, updated_at) VALUES (?, 'task', 'session', 'planner', 'agent', 'execution', 'plan', ?, ?, ?, 0, ?, ?, 'waiting', ?, ?)").run(turnId, "c".repeat(64), join("herdr-results", "task", "planner", `result-${turnId}.json`), setup.session.rolloutPath, Buffer.byteLength(rollout), promptSentAt, promptSentAt, promptSentAt));
    const runner = makeRunner(setup.database, { prompt: async () => { prompts += 1; return setup.session.live; }, getAgent: async () => setup.session.live } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
    await expect(runner.run(setup.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toBe(0);
    expect((await readdir(dirname(path))).filter((name) => name.includes(".quarantine-"))).toEqual([]);
    expect(setup.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns WHERE turn_id = ?").get(turnId))).toEqual({ status: "completed" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});


test("stores sanitized content-addressed rollout manifests and reuses chunks", async () => {
  const setup = await fixture();
  const artifacts = new ArtifactStore(join(setup.root, "artifacts"), setup.database);
  const herdr = { prompt: async (_name: string, prompt: string) => { await appendFile(setup.session.rolloutPath!, `${line({ type: "agent_message", message: "secret token /Users/agent/private" })}`); await complete(setup.session, prompt, { status: "ok" }); return setup.session.live; }, getAgent: async () => setup.session.live };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), artifacts);
  try {
    await runner.run(setup.input);
    const second = { ...setup.input, executionId: "execution-two" };
    setup.database.authQuery((db) => {
      db.prepare("UPDATE forge_agent_executions SET status = 'completed' WHERE id = 'execution'").run();
      db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, heartbeat_at) VALUES ('execution-two', 'task', 'company', 'workflow', 'planner', 'running', 1, ?, ?)").run(new Date().toISOString(), new Date().toISOString());
    });
    await runner.run(second);
    const manifest = setup.database.authQuery((db) => db.prepare("SELECT id, storage_path FROM forge_artifacts WHERE kind = 'herdr-rollout-manifest' ORDER BY created_at LIMIT 1").get() as { id: string; storage_path: string });
    const chunks = setup.database.authQuery((db) => db.prepare("SELECT count(*) AS count FROM forge_artifacts WHERE kind = 'herdr-rollout-chunk'").get() as { count: number });
    expect(manifest.id).toMatch(/^artifact_herdr-rollout-manifest_/);
    const chunk = setup.database.authQuery((db) => db.prepare("SELECT storage_path FROM forge_artifacts WHERE kind = 'herdr-rollout-chunk'").get() as { storage_path: string });
    expect(chunks.count).toBe(1);
    expect((await artifacts.getArtifact({ companyId: "company", storagePath: manifest.storage_path })).toString("utf8")).not.toContain("secret token");
    const snapshot = gunzipSync(await artifacts.getArtifact({ companyId: "company", storagePath: chunk.storage_path })).toString("utf8");
    expect(snapshot).not.toContain("secret token");
    expect(snapshot).toContain('"type":"event_msg"');
    expect(snapshot).toContain('"payload":{"type":"agent_message"}');
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("keeps a supplemental reviewer pane after its rollout snapshot", async () => {
  const setup = await fixture();
  setup.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET session_role = 'reviewer' WHERE id = 'session'").run());
  const artifacts = new ArtifactStore(join(setup.root, "artifacts"), setup.database);
  let snapshotPresent = false;
  const herdr = {
    prompt: async (_name: string, prompt: string) => { await complete(setup.session, prompt, { status: "ok" }); return setup.session.live; },
    getAgent: async () => setup.session.live,
    closePane: async () => { snapshotPresent = Boolean(setup.database.authQuery((db) => db.prepare("SELECT id FROM forge_artifacts WHERE kind = 'herdr-rollout-manifest'").get())); },
  };
  const runner = makeRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), artifacts);
  try {
    await expect(runner.run({ ...setup.input, executionRole: "reviewer" })).resolves.toMatchObject({ result: { status: "ok" } });
    expect(snapshotPresent).toBe(false);
    expect(setup.database.authQuery((db) => db.prepare("SELECT id FROM forge_artifacts WHERE kind = 'herdr-rollout-manifest'").get())).toBeDefined();
    expect(setup.database.authQuery((db) => db.prepare("SELECT pane_id, status, is_current FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ pane_id: "pane", status: "ready", is_current: 1 });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});
