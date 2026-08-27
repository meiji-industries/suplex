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

const ResultSchema = z.object({ status: z.enum(["ok", "blocked"]) }).strict();
const task = { taskId: "task", projectId: "project", projectSlug: "project", worktreePath: "/worktree", runtimeRoot: "" };
const line = (payload: Record<string, unknown>) => `${JSON.stringify({ timestamp: "2026-08-24T00:00:00.000Z", type: "event_msg", payload })}\n`;

interface FakeSession { id: string; provider: "codex" | "claude"; agentName: string; paneId: string; codexSessionId: string | null; generation: number; rolloutPath: string | undefined; live: { name: string; paneId: string; agentSession?: string; status: string }; }

async function fixture(): Promise<{ root: string; database: ForgeDatabase; input: HerdrTurnInput<z.infer<typeof ResultSchema>>; session: FakeSession }> {
  const root = await mkdtemp(join(tmpdir(), "forge-herdr-turn-"));
  const database = new ForgeDatabase(join(root, "forge.sqlite"));
  const now = new Date().toISOString();
  database.authQuery((db) => {
    db.prepare("INSERT INTO forge_companies (id, name, status, created_at) VALUES ('company', 'Company', 'active', ?)").run(now);
    db.prepare("INSERT INTO forge_projects (id, company_id, name, repository_path, worktree_root, repository_identity, base_branch, target_branch, setup_command, verification_command, required_checks_json, role_defaults_json, status, created_at, updated_at) VALUES ('project', 'company', 'Project', '/repo', '/worktrees', 'owner/repo', 'main', 'main', '', '', '[]', '{}', 'active', ?, ?)").run(now, now);
    db.prepare("INSERT INTO forge_artifacts (id, company_id, kind, filename, mime_type, byte_size, sha256, storage_path, created_at) VALUES ('brief', 'company', 'task-brief', 'brief.md', 'text/markdown', 1, ?, 'brief.md', ?)").run("a".repeat(64), now);
    db.prepare("INSERT INTO forge_tasks (id, company_id, project_id, title, brief_artifact_id, image_artifact_ids_json, role_agents_json, supplemental_review, workflow_id, project_revision_id, idempotency_key, request_hash, created_at, updated_at) VALUES ('task', 'company', 'project', 'Task', 'brief', '[]', '{}', 0, 'workflow', 'revision', 'key', ?, ?, ?)").run("b".repeat(64), now, now);
    db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, codex_session_id, agent_name, pane_id, rollout_path, status, created_at, updated_at) VALUES ('session', 'task', 'lead', 1, 1, 'codex', 'codex-session', 'lead', 'pane', ?, 'ready', ?, ?)").run(join(root, "rollout.jsonl"), now, now);
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, heartbeat_at) VALUES ('execution', 'task', 'company', 'workflow', 'planner', 'running', 1, ?, ?)").run(now, now);
  });
  const rolloutPath = join(root, "rollout.jsonl");
  await writeFile(rolloutPath, "");
  return {
    root,
    database,
    session: { id: "session", provider: "codex", agentName: "lead", paneId: "pane", codexSessionId: "codex-session", generation: 1, rolloutPath, live: { name: "lead", paneId: "pane", agentSession: "codex-session", status: "working" } },
    input: { task: { ...task, runtimeRoot: root }, sessionRole: "lead", executionRole: "planner", ledger: "agent", executionId: "execution", promptKind: "plan", prompt: "Plan this", profile: { model: "gpt", reasoningLevel: "high", servicePriority: "priority" }, resultSchema: ResultSchema, schemaPath: "schema.json", companyId: "company", workflowId: "workflow", revision: 1 },
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, sessions as never, new IssueTimelineEvents(setup.database), artifacts);
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

test("converts non-retryable Herdr session failures at the turn boundary", async () => {
  const setup = await fixture();
  const runner = new HerdrTurnRunner(setup.database, {} as never, {
    ensureRoleSession: async () => { throw new HerdrFailure("guard_invalid", false, "Guard is invalid"); },
  } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toEqual(expect.objectContaining<Partial<AgentFailure>>({ code: "guard_invalid", nonRetryable: true }));
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
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
    const runner = new HerdrTurnRunner(
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
  const runner = new HerdrTurnRunner(setup.database, {
    prompt: async () => { throw new HerdrFailure("timeout", true, "Herdr timed out"); },
  } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toEqual(expect.objectContaining<Partial<AgentFailure>>({ code: "timeout", nonRetryable: false }));
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates, async () => { reported = true; });
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
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
  const reportedRunner = new HerdrTurnRunner(setup.database, herdr as never, sessions as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
  try {
    const running = reportedRunner.run(setup.input);
    reported = true;
    await expect(running).resolves.toMatchObject({ sessionId: "reported-session" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("identity deadline failures are retryable and Herdr's reported session wins stale markers", async () => {
  const setup = await freshIdentityFixture();
  const missing = new HerdrTurnRunner(setup.database, { prompt: async () => setup.session.live, getAgent: async () => setup.session.live } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates, async () => {});
  const ambiguous = new HerdrTurnRunner(setup.database, { prompt: async () => { await freshRollout(setup, "first-session"); await freshRollout(setup, "second-session"); return setup.session.live; }, getAgent: async () => setup.session.live } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates, async () => {});
  const reported = new HerdrTurnRunner(setup.database, {
    prompt: async (_name: string, prompt: string) => {
      const path = await freshRollout(setup, "different-session");
      await appendFile(path, line({ type: "user_message", message: marker(prompt) }));
      await freshRollout(setup, "reported-session");
      setup.session = { ...setup.session, rolloutPath: path };
      await complete({ ...setup.session, rolloutPath: join(setup.root, "reported-session.jsonl") }, prompt, { status: "ok" });
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, agentSession: "reported-session" }),
  } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), undefined, async () => setup.candidates);
  try {
    await expect(missing.run(setup.input)).rejects.toMatchObject({ code: "session-identity-missing", nonRetryable: false });
    await expect(ambiguous.run({ ...setup.input, executionId: "ambiguous" })).rejects.toMatchObject({ code: "session-identity-ambiguous", nonRetryable: false });
    await expect(reported.run(setup.input)).resolves.toMatchObject({ sessionId: "reported-session" });
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

test("re-sends an unobserved prompt before recording awaiting-human attention", async () => {
  const setup = await fixture();
  let now = new Date();
  const prompts: string[] = [];
  let sleeps = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 2) {
        const turn = "re-sent";
        await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: turn })}`);
        await writeFile(resultPath(prompt), JSON.stringify({ status: "ok" }));
        await appendFile(setup.session.rolloutPath!, line({ type: "task_complete", turn_id: turn, duration_ms: 1 }));
      }
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, status: "idle" }),
  };
  const runner = new HerdrTurnRunner(
    setup.database,
    herdr as never,
    { ensureRoleSession: async () => setup.session } as never,
    new IssueTimelineEvents(setup.database),
    undefined,
    undefined,
    async () => {
      sleeps += 1;
      if (sleeps === 1) {
        expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns").get())).toEqual({ status: "waiting", attention_excerpt: null });
        now = new Date(now.getTime() + 15_000);
      }
    },
    () => now,
  );
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toBe(prompts[0]);
    for (const prompt of prompts) expect(prompt.match(/Forge response style/g)).toHaveLength(1);
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
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
  const runner = new HerdrTurnRunner(setup.database, {
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
  const runner = new HerdrTurnRunner(setup.database, { prompt: async () => setup.session.live } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run({ ...setup.input, signal: controller.signal })).rejects.toMatchObject({ code: "cancelled", nonRetryable: true });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("stops cancelled executions without relaunching a missing agent", async () => {
  const setup = await fixture();
  let prompts = 0;
  setup.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'cancelled' WHERE id = 'execution'").run());
  const runner = new HerdrTurnRunner(setup.database, {
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
  const runner = new HerdrTurnRunner(setup.database, {
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).rejects.toMatchObject({ code: "turn-failed" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("closes a reviewer pane when its turn fails", async () => {
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run({ ...setup.input, sessionRole: "reviewer", executionRole: "reviewer" })).rejects.toMatchObject({ code: "turn-failed" });
    expect(closed).toBe(true);
    expect(setup.database.authQuery((db) => db.prepare("SELECT pane_id, status, is_current FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ pane_id: null, status: "closed", is_current: 0 });
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
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
  const runner = new HerdrTurnRunner(setup.database, {} as never, {} as never, new IssueTimelineEvents(setup.database));
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
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

test("surfaces an unbound turn only after all prompt delivery attempts go unobserved", async () => {
  const setup = await fixture();
  let now = new Date();
  let sent = "";
  let sleeps = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      sent = prompt;
      await appendFile(setup.session.rolloutPath!, `${line({ type: "task_started", turn_id: "idle" })}${line({ type: "agent_message", message: "I am reviewing the repository." })}`);
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, status: "idle" }),
  };
  const runner = new HerdrTurnRunner(
    setup.database,
    herdr as never,
    { ensureRoleSession: async () => setup.session } as never,
    new IssueTimelineEvents(setup.database),
    undefined,
    undefined,
    async () => {
      sleeps += 1;
      if (sleeps <= 3) now = new Date(now.getTime() + [15_000, 30_000, 60_000][sleeps - 1]!);
      if (sleeps === 5) {
        expect(setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns").get())).toEqual({ status: "awaiting_human", attention_excerpt: "Prompt was not accepted by the agent after 4 attempts" });
        const row = setup.database.authQuery((db) => db.prepare("SELECT result_relative_path FROM forge_herdr_turns").get()) as { result_relative_path: string };
        await writeFile(join(setup.root, row.result_relative_path), JSON.stringify({ status: "ok" }));
        await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(sent) })}${line({ type: "task_complete", turn_id: "idle", duration_ms: 1 })}`);
      }
    },
    () => now,
  );
  try {
    const running = runner.run(setup.input);
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
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
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

test("surfaces a completed idle turn that did not write its result file", async () => {
  const setup = await fixture();
  let prompts = 0;
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts += 1;
      await appendFile(setup.session.rolloutPath!, `${line({ type: "user_message", message: marker(prompt) })}${line({ type: "task_started", turn_id: "silent" })}${line({ type: "task_complete", turn_id: "silent", duration_ms: 1 })}`);
      return setup.session.live;
    },
    getAgent: async () => ({ ...setup.session.live, status: "idle" }),
  };
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
  try {
    const running = runner.run(setup.input);
    await new Promise((resolve) => setTimeout(resolve, 75));
    const row = setup.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt, result_relative_path FROM forge_herdr_turns").get() as { status: string; attention_excerpt: string; result_relative_path: string });
    expect(row).toMatchObject({ status: "awaiting_human", attention_excerpt: expect.stringContaining(`Finished without writing ${join(setup.root, row.result_relative_path)}`) });
    expect(prompts).toBe(2);
    setTimeout(() => void writeFile(join(setup.root, row.result_relative_path), JSON.stringify({ status: "ok" })), 1_050);
    await expect(running).resolves.toMatchObject({ result: { status: "ok" } });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("adopts a persisted waiting turn after marker-start-completion without prompting again", async () => {
  const setup = await fixture();
  const turnId = "turn_01b63006007efef685185032a0737895";
  const path = join(setup.root, "herdr-results", "task", "lead", `result-${turnId}.json`);
  const promptSentAt = new Date(Date.now() - 1_000).toISOString();
  const rollout = `${line({ type: "user_message", message: `[forge-turn:${turnId}]` })}${line({ type: "task_started", turn_id: "codex-turn" })}${line({ type: "task_complete", turn_id: "codex-turn", duration_ms: 1 })}`;
  let prompts = 0;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({ status: "ok" }));
    await appendFile(setup.session.rolloutPath!, rollout);
    setup.database.authQuery((db) => db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, rollout_path, rollout_start_offset, rollout_cursor_offset, prompt_sent_at, status, created_at, updated_at) VALUES (?, 'task', 'session', 'planner', 'agent', 'execution', 'plan', ?, ?, ?, 0, ?, ?, 'waiting', ?, ?)").run(turnId, "c".repeat(64), join("herdr-results", "task", "lead", `result-${turnId}.json`), setup.session.rolloutPath, Buffer.byteLength(rollout), promptSentAt, promptSentAt, promptSentAt));
    const runner = new HerdrTurnRunner(setup.database, { prompt: async () => { prompts += 1; return setup.session.live; }, getAgent: async () => setup.session.live } as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database));
    await expect(runner.run(setup.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toBe(0);
    expect((await readdir(dirname(path))).filter((name) => name.includes(".quarantine-"))).toEqual([]);
    expect(setup.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns WHERE turn_id = ?").get(turnId))).toEqual({ status: "completed" });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("re-prompts once for each newly interrupted session generation", async () => {
  const setup = await fixture();
  let generation = 1;
  let agentChecks = 0;
  const prompts: string[] = [];
  const session = () => ({ ...setup.session, generation, live: { ...setup.session.live, status: "working" } });
  const herdr = {
    prompt: async (_name: string, prompt: string) => {
      prompts.push(prompt);
      if (prompts.length === 3 && generation === 3) await complete(session(), prompts[0]!, { status: "ok" });
      return session().live;
    },
    getAgent: async () => {
      agentChecks += 1;
      if (agentChecks === 1 || agentChecks === 3) { generation += 1; return null; }
      if (agentChecks === 2) return null;
      return session().live;
    },
  };
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => session() } as never, new IssueTimelineEvents(setup.database));
  try {
    await expect(runner.run(setup.input)).resolves.toMatchObject({ result: { status: "ok" } });
    expect(prompts).toHaveLength(3);
    for (const prompt of prompts) {
      expect(prompt).toContain("Plan this");
      expect(prompt.match(/Forge response style/g)).toHaveLength(1);
    }
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});

test("stores sanitized content-addressed rollout manifests and reuses chunks", async () => {
  const setup = await fixture();
  const artifacts = new ArtifactStore(join(setup.root, "artifacts"), setup.database);
  const herdr = { prompt: async (_name: string, prompt: string) => { await appendFile(setup.session.rolloutPath!, `${line({ type: "agent_message", message: "secret token /Users/agent/private" })}`); await complete(setup.session, prompt, { status: "ok" }); return setup.session.live; }, getAgent: async () => setup.session.live };
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), artifacts);
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

test("closes a supplemental reviewer pane only after its rollout snapshot", async () => {
  const setup = await fixture();
  setup.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET session_role = 'reviewer' WHERE id = 'session'").run());
  const artifacts = new ArtifactStore(join(setup.root, "artifacts"), setup.database);
  let snapshotPresent = false;
  const herdr = {
    prompt: async (_name: string, prompt: string) => { await complete(setup.session, prompt, { status: "ok" }); return setup.session.live; },
    getAgent: async () => setup.session.live,
    closePane: async () => { snapshotPresent = Boolean(setup.database.authQuery((db) => db.prepare("SELECT id FROM forge_artifacts WHERE kind = 'herdr-rollout-manifest'").get())); },
  };
  const runner = new HerdrTurnRunner(setup.database, herdr as never, { ensureRoleSession: async () => setup.session } as never, new IssueTimelineEvents(setup.database), artifacts);
  try {
    await expect(runner.run({ ...setup.input, sessionRole: "reviewer", executionRole: "reviewer" })).resolves.toMatchObject({ result: { status: "ok" } });
    expect(snapshotPresent).toBe(true);
    expect(setup.database.authQuery((db) => db.prepare("SELECT pane_id, status, is_current FROM forge_herdr_role_sessions WHERE id = 'session'").get())).toEqual({ pane_id: null, status: "closed", is_current: 0 });
  } finally { setup.database.close(); await rm(setup.root, { recursive: true, force: true }); }
});
