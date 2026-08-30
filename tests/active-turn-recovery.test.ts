import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, expect, test } from "vitest";

import { reconcileActiveTurns } from "../src/active-turn-recovery.js";
import { DeveloperDeliveryReportSchema } from "../src/codex-developer.js";
import { createTestConfig } from "../src/config.js";
import { ForgeDatabase } from "../src/database.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((remove) => remove())); });

const stamp = "2026-08-27T00:00:00.000Z";
const validLeadPlan = {
  kind: "plan",
  summary: "Recover the existing Lead result.",
  gitPresentation: { branchSlug: "recover-lead-result", pullRequestTitle: "Recover Lead result", pullRequestDescription: "Persist the existing Lead turn result." },
  reproduction: null,
  rootCauseAnalysis: "The completed turn did not persist its result.",
  steps: [{ number: 1, instruction: "Persist the result", entryPoint: "src/active-turn-recovery.ts", completionCriterion: "The result exists", verification: "Run the focused test" }],
  compatibilityAnalysis: "No compatibility change.",
  operationalAnalysis: "Recovery is one-shot.",
  verificationStrategy: "Run the focused test.",
  unresolvedTechnicalQuestions: [],
  materialCategories: [],
  affectedPaths: ["src/active-turn-recovery.ts"],
  materiality: [],
};
const validDeveloperDelivery = {
  kind: "delivery",
  summary: "Recovered delivery.",
  steps: [{ number: 1, status: "completed", filesChanged: ["src/active-turn-recovery.ts"], commandsRun: [], testResults: [], notes: "Done." }],
  authorizedStepsNotCompleted: [],
  resultCommit: "a".repeat(40),
  resultTree: "b".repeat(40),
  dirtyState: "clean",
  blocker: null,
};

type Role = "planner" | "builder" | "reviewer" | "integrator";
type Ledger = "agent" | "developer";
type AddedTurn = { taskId: string; turnId: string; sessionId: string; paneId: string; agentName: string; resultRelativePath: string };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "forge-active-turn-"));
  const config = createTestConfig(root);
  const database = new ForgeDatabase(config.databasePath);
  cleanup.push(async () => { database.close(); await rm(root, { recursive: true, force: true }); });
  database.authQuery((db) => db.pragma("foreign_keys = OFF"));
  const turns: AddedTurn[] = [];
  const addTurn = (suffix: string, options: { role?: Role; ledger?: Ledger; promptKind?: string; status?: string; executionStatus?: string; promptSentAt?: string | null } = {}): AddedTurn => {
    const role = options.role ?? "planner";
    const ledger = options.ledger ?? "agent";
    const taskId = `task-${suffix}`;
    const turnId = `turn-${suffix}`;
    const sessionId = `session-${suffix}`;
    const executionId = `execution-${suffix}`;
    const paneId = `pane-${suffix}`;
    const agentName = `recorded-${role}-${suffix}`;
    const resultRelativePath = `herdr-results/${taskId}/${role}/result-${turnId}.json`;
    const promptSentAt = options.promptSentAt === undefined ? stamp : options.promptSentAt;
    database.authTransaction((db) => {
      db.prepare("INSERT INTO forge_issue_projections (task_id, company_id, project_id, workflow_id, revision, phase, owner, allowed_commands_json, pending_action, updated_at, last_event_id) VALUES (?, 'company', 'project', ?, 1, 'planning', 'lead', '[]', NULL, ?, 'event')").run(taskId, `workflow-${suffix}`, stamp);
      db.prepare("INSERT INTO forge_herdr_role_sessions (id, task_id, session_role, generation, is_current, provider_kind, agent_name, pane_id, status, created_at, updated_at) VALUES (?, ?, ?, 1, 1, 'codex', ?, ?, 'ready', ?, ?)").run(sessionId, taskId, role, agentName, paneId, stamp, stamp);
      if (ledger === "agent") {
        db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, heartbeat_at) VALUES (?, ?, 'company', ?, ?, ?, 1, ?, ?)").run(executionId, taskId, `workflow-${suffix}`, role, options.executionStatus ?? "running", stamp, stamp);
      } else {
        db.prepare("INSERT INTO forge_developer_executions (id, task_id, company_id, workflow_id, plan_revision, attempt, status, branch_name, worktree_path, target_base_sha, started_at, heartbeat_at, finished_at, failure_code) VALUES (?, ?, 'company', ?, 1, 1, ?, ?, '/missing', ?, ?, ?, ?, ?)").run(executionId, taskId, `workflow-${suffix}`, options.executionStatus ?? "running", `work/${suffix}`, "d".repeat(40), stamp, stamp, options.executionStatus === "failed" ? stamp : null, options.executionStatus === "failed" ? "prompt-not-accepted" : null);
      }
      db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, prompt_sent_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)").run(turnId, taskId, sessionId, role, ledger, executionId, options.promptKind ?? (ledger === "agent" ? "lead-plan" : "implementation"), "c".repeat(64), resultRelativePath, options.status ?? "waiting", promptSentAt, stamp, stamp);
    });
    const turn = { taskId, turnId, sessionId, paneId, agentName, resultRelativePath };
    turns.push(turn);
    return turn;
  };
  const snapshot = () => ({
    agents: turns.map((turn) => ({ name: `live-${turn.agentName}`, paneId: turn.paneId, status: "done" })),
    panes: turns.map((turn) => ({ paneId: turn.paneId, agent: `live-${turn.agentName}`, agentStatus: "done", tokens: { forge_binding_id: turn.sessionId } })),
  });
  const writeResult = async (turn: AddedTurn, value: unknown, raw = false) => {
    const path = join(config.runtimeRoot, turn.resultRelativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, raw ? String(value) : JSON.stringify(value));
    return path;
  };
  return { database, config, addTurn, snapshot, writeResult };
}

test("terminal current planner and reviewer turns prompt their renamed live agents once", async () => {
  const value = await fixture();
  const planner = value.addTurn("planner");
  const reviewer = value.addTurn("reviewer", { role: "reviewer", promptKind: "delivery-review" });
  const prompts: Array<{ agent: string; prompt: string }> = [];
  const herdr = { runtimeSnapshot: async () => value.snapshot(), prompt: async (agent: string, prompt: string) => { prompts.push({ agent, prompt }); } };

  const first = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });
  const second = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });

  expect(first).toMatchObject([{ turnId: planner.turnId, action: "resume" }, { turnId: reviewer.turnId, action: "resume" }]);
  expect(second.every((outcome) => outcome.action !== "resume")).toBe(true);
  expect(prompts.map(({ agent }) => agent)).toEqual([`live-${planner.agentName}`, `live-${reviewer.agentName}`]);
  expect(prompts).toHaveLength(2);
  for (const [turn, sent] of [[planner, prompts[0]!], [reviewer, prompts[1]!]] as const) {
    expect(sent.prompt).toContain(`turn_id ${turn.turnId}`);
    expect(sent.prompt).toContain(join(value.config.runtimeRoot, turn.resultRelativePath));
    expect(sent.prompt).toContain(`[forge-turn:${turn.turnId}]`);
  }
  expect(value.database.authQuery((db) => db.prepare("SELECT turn_id, status, attention_excerpt FROM forge_herdr_turns ORDER BY turn_id").all())).toEqual([
    { turn_id: planner.turnId, status: "awaiting_human", attention_excerpt: expect.stringContaining(planner.turnId) },
    { turn_id: reviewer.turnId, status: "awaiting_human", attention_excerpt: expect.stringContaining(reviewer.turnId) },
  ]);
});

test("no initial prompt receipt and unknown live lifecycle never trigger recovery prompts", async () => {
  const value = await fixture();
  const noReceipt = value.addTurn("no-receipt", { status: "dispatching", promptSentAt: null });
  const unknownLifecycle = value.addTurn("unknown-lifecycle");
  const prompts: string[] = [];
  const herdr = {
    runtimeSnapshot: async () => ({
      agents: [
        { name: `live-${noReceipt.agentName}`, paneId: noReceipt.paneId, status: "done" },
        { name: `live-${unknownLifecycle.agentName}`, paneId: unknownLifecycle.paneId, status: "mystery" },
      ],
      panes: [
        { paneId: noReceipt.paneId, agent: `live-${noReceipt.agentName}`, agentStatus: "done", tokens: { forge_binding_id: noReceipt.sessionId } },
        { paneId: unknownLifecycle.paneId, agent: `live-${unknownLifecycle.agentName}`, agentStatus: "mystery", tokens: { forge_binding_id: unknownLifecycle.sessionId } },
      ],
    }),
    prompt: async (agent: string) => { prompts.push(agent); },
  };

  const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });

  expect(outcomes.find(({ turnId }) => turnId === noReceipt.turnId)).toMatchObject({ action: "no_change", evidence: expect.arrayContaining(["resume:initial prompt receipt absent"]) });
  expect(outcomes.find(({ turnId }) => turnId === unknownLifecycle.turnId)).toMatchObject({ action: "no_change" });
  expect(prompts).toEqual([]);
  expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns WHERE turn_id = ?").get(noReceipt.turnId))).toEqual({ status: "dispatching" });
});

test("only the latest turn for the exact active execution in a current session is nudged", async () => {
  const value = await fixture();
  const historical = value.addTurn("history-old", { executionStatus: "completed" });
  const activeTurnId = "turn-history-active";
  value.database.authTransaction((db) => {
    db.prepare("INSERT INTO forge_agent_executions (id, task_id, company_id, workflow_id, role, status, attempt, started_at, heartbeat_at) VALUES ('execution-history-active', ?, 'company', 'workflow-history-old', 'planner', 'running', 1, ?, ?)").run(historical.taskId, stamp, stamp);
    db.prepare("INSERT INTO forge_herdr_turns (turn_id, task_id, role_session_id, execution_role, ledger, execution_id, prompt_kind, prompt_sha256, result_relative_path, correction_index, status, prompt_sent_at, created_at, updated_at) VALUES (?, ?, ?, 'planner', 'agent', 'execution-history-active', 'lead-plan', ?, 'herdr-results/task-history-old/planner/result-turn-history-active.json', 0, 'completed', ?, '2026-08-27T00:00:01.000Z', '2026-08-27T00:00:01.000Z')").run(activeTurnId, historical.taskId, historical.sessionId, "d".repeat(64), stamp);
  });
  const prompts: string[] = [];
  const herdr = { runtimeSnapshot: async () => value.snapshot(), prompt: async (agent: string) => { prompts.push(agent); } };

  const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });

  expect(outcomes.find(({ turnId }) => turnId === historical.turnId)).toMatchObject({ action: "no_change", evidence: expect.arrayContaining(["resume:not latest active execution"]) });
  expect(outcomes.find(({ turnId }) => turnId === activeTurnId)).toMatchObject({ action: "resume", evidence: expect.arrayContaining(["resume:receipt persisted before prompt"]) });
  expect(prompts).toEqual([`live-${historical.agentName}`]);
  expect(value.database.authQuery((db) => db.prepare("SELECT turn_id, status FROM forge_herdr_turns WHERE role_session_id = ? ORDER BY turn_id").all(historical.sessionId))).toEqual([
    { turn_id: activeTurnId, status: "awaiting_human" },
    { turn_id: historical.turnId, status: "waiting" },
  ]);
});

test("unsafe targets stay unprompted while malformed known-schema output remains correctable", async () => {
  const value = await fixture();
  const traversal = value.addTurn("traversal");
  const unknown = value.addTurn("unknown-schema", { promptKind: "unknown" });
  const malformed = value.addTurn("malformed-known");
  await value.writeResult(malformed, "{\"kind\":", true);
  value.database.authQuery((db) => db.prepare("UPDATE forge_herdr_turns SET result_relative_path = '../outside.json' WHERE turn_id = ?").run(traversal.turnId));
  const prompts: string[] = [];
  const herdr = { runtimeSnapshot: async () => value.snapshot(), prompt: async (agent: string) => { prompts.push(agent); } };

  const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });

  expect(outcomes.find(({ turnId }) => turnId === traversal.turnId)).toMatchObject({ action: "no_change", evidence: expect.arrayContaining(["result:path outside runtime root", "resume:result target not promptable"]) });
  expect(outcomes.find(({ turnId }) => turnId === unknown.turnId)).toMatchObject({ action: "no_change", evidence: expect.arrayContaining(["result:unknown schema agent/unknown", "resume:result target not promptable"]) });
  expect(outcomes.find(({ turnId }) => turnId === malformed.turnId)).toMatchObject({ action: "resume", evidence: expect.arrayContaining(["result:malformed JSON", "resume:receipt persisted before prompt"]) });
  expect(prompts).toEqual([`live-${malformed.agentName}`]);
});

test("a prompt failure after the CAS leaves attention and is never retried", async () => {
  const value = await fixture();
  const turn = value.addTurn("crash");
  let prompts = 0;
  let panePresent = true;
  const herdr = { runtimeSnapshot: async () => panePresent ? value.snapshot() : { agents: [], panes: [] }, prompt: async () => { prompts += 1; throw new Error("simulated dispatch crash"); } };

  const first = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });
  panePresent = false;
  const second = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });

  expect(first).toMatchObject([{ taskId: turn.taskId, turnId: turn.turnId, action: "error", evidence: [expect.stringContaining("simulated dispatch crash")] }]);
  expect(second[0]?.action).not.toBe("resume");
  expect(prompts).toBe(1);
  expect(value.database.authQuery((db) => db.prepare("SELECT status, attention_excerpt FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId))).toEqual({ status: "awaiting_human", attention_excerpt: expect.stringContaining(turn.turnId) });
  expect(value.database.authQuery((db) => db.prepare("SELECT attention_activated_at FROM forge_herdr_role_sessions WHERE id = ?").get(turn.sessionId))).toEqual({ attention_activated_at: stamp });
});

test("a later exact-schema result is adopted once and clears attention", async () => {
  const value = await fixture();
  const turn = value.addTurn("late");
  const prompts: string[] = [];
  const herdr = { runtimeSnapshot: async () => value.snapshot(), prompt: async (_agent: string, prompt: string) => { prompts.push(prompt); } };
  await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });
  const path = await value.writeResult(turn, validLeadPlan);
  const bytes = await readFile(path);

  const adopted = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });
  const stable = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });

  expect(adopted).toMatchObject([{ turnId: turn.turnId, action: "advance", evidence: expect.arrayContaining(["result:valid agent/lead-plan"]) }]);
  expect(stable).toEqual(adopted);
  expect(prompts).toHaveLength(1);
  expect(value.database.authQuery((db) => db.prepare("SELECT status, result_sha256, attention_excerpt FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId))).toEqual({ status: "completed", result_sha256: createHash("sha256").update(bytes).digest("hex"), attention_excerpt: null });
  expect(value.database.authQuery((db) => db.prepare("SELECT status, attention_activated_at FROM forge_herdr_role_sessions WHERE id = ?").get(turn.sessionId))).toEqual({ status: "ready", attention_activated_at: null });
});

test("generic, wrong-kind, partial, array, unknown-kind, and malformed results never complete", async () => {
  const cases: Array<{ name: string; promptKind?: string; value: unknown; raw?: boolean }> = [
    { name: "generic", value: { status: "ok" } },
    { name: "wrong-kind", value: { summary: "Repair", blocker: null } },
    { name: "partial", value: { kind: "plan", summary: "Partial" } },
    { name: "array", value: [validLeadPlan] },
    { name: "unknown-kind", promptKind: "unknown", value: validLeadPlan },
    { name: "malformed", value: "{\"kind\":", raw: true },
  ];
  for (const item of cases) {
    const value = await fixture();
    const turn = value.addTurn(item.name, item.promptKind ? { promptKind: item.promptKind } : {});
    await value.writeResult(turn, item.value, item.raw);
    const herdr = { runtimeSnapshot: async () => ({ agents: [], panes: [] }) };
    const outcome = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never });
    expect(outcome[0]?.action, item.name).not.toBe("advance");
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId)), item.name).not.toEqual({ status: "completed" });
  }
});

test("one failed candidate retains identity evidence while the next candidate reconciles", async () => {
  const value = await fixture();
  const first = value.addTurn("a");
  const second = value.addTurn("b");
  const prompted: string[] = [];
  const errors: Array<{ message: string; context: object; details: object }> = [];
  const herdr = {
    runtimeSnapshot: async () => value.snapshot(),
    prompt: async (agent: string) => {
      prompted.push(agent);
      if (agent === `live-${first.agentName}`) throw new Error("candidate one failed");
    },
  };
  const logger = { error: (message: string, context: object, details: object) => { errors.push({ message, context, details }); } };

  const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, logger: logger as never, now: () => stamp });

  expect(outcomes).toMatchObject([
    { taskId: first.taskId, turnId: first.turnId, action: "error" },
    { taskId: second.taskId, turnId: second.turnId, action: "resume" },
  ]);
  expect(prompted).toEqual([`live-${first.agentName}`, `live-${second.agentName}`]);
  expect(errors).toEqual([{ message: "Active turn recovery candidate failed", context: { taskId: first.taskId, turnId: first.turnId }, details: { error: "candidate one failed" } }]);
});

test("cancellation and terminal projection state suppress prompts and completion", async () => {
  const value = await fixture();
  const cancelling = value.addTurn("cancelling", { executionStatus: "cancelling" });
  const cancelledAgent = value.addTurn("cancelled-agent");
  const terminalProjection = value.addTurn("terminal-projection");
  await value.writeResult(cancelling, validLeadPlan);
  await value.writeResult(terminalProjection, validLeadPlan);
  value.database.authQuery((db) => db.prepare("UPDATE forge_issue_projections SET phase = 'cancelled', updated_at = ? WHERE task_id = ?").run(new Date().toISOString(), terminalProjection.taskId));
  const prompts: string[] = [];
  const status = (turn: AddedTurn, lifecycle: string) => ({
    agent: { name: `live-${turn.agentName}`, paneId: turn.paneId, status: lifecycle },
    pane: { paneId: turn.paneId, agent: `live-${turn.agentName}`, agentStatus: lifecycle, tokens: { forge_binding_id: turn.sessionId } },
  });
  const live = [status(cancelling, "done"), status(cancelledAgent, "cancelled"), status(terminalProjection, "done")];
  const herdr = { runtimeSnapshot: async () => ({ agents: live.map(({ agent }) => agent), panes: live.map(({ pane }) => pane) }), prompt: async (agent: string) => { prompts.push(agent); } };

  const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now: () => stamp });

  expect(outcomes.find(({ turnId }) => turnId === cancelling.turnId)).toMatchObject({ action: "no_change", evidence: expect.arrayContaining(["advance:not latest active execution"]) });
  expect(outcomes.find(({ turnId }) => turnId === cancelledAgent.turnId)).toMatchObject({ action: "no_change", evidence: expect.arrayContaining(["resume:not exact current live binding"]) });
  expect(outcomes.find(({ turnId }) => turnId === terminalProjection.turnId)).toMatchObject({ action: "no_change", evidence: expect.arrayContaining(["task:terminal"]) });
  expect(prompts).toEqual([]);
  expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_herdr_turns WHERE status = 'completed' AND task_id IN (?, ?, ?)").get(cancelling.taskId, cancelledAgent.taskId, terminalProjection.taskId))).toEqual({ count: 0 });
});

test("prompt CAS loses an execution cancellation race without dispatch", async () => {
  const value = await fixture();
  const turn = value.addTurn("prompt-race");
  let prompts = 0;
  const herdr = { runtimeSnapshot: async () => value.snapshot(), prompt: async () => { prompts += 1; } };
  let raced = false;
  const now = () => {
    if (!raced) {
      raced = true;
      value.database.authQuery((db) => db.prepare("UPDATE forge_agent_executions SET status = 'cancelled' WHERE id = 'execution-prompt-race'").run());
    }
    return stamp;
  };

  const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, now });

  expect(outcomes).toMatchObject([{ turnId: turn.turnId, action: "no_change", evidence: expect.arrayContaining(["resume:receipt not claimed"]) }]);
  expect(prompts).toBe(0);
  expect(value.database.authQuery((db) => db.prepare("SELECT status, recovery_prompt_sent_at FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId))).toEqual({ status: "waiting", recovery_prompt_sent_at: null });
});

test("compatible clean Git handoff writes and validates exact delivery bytes before completion", async () => {
  for (const valid of [true, false]) {
    const value = await fixture();
    const turn = value.addTurn(`handoff-${valid ? "valid" : "invalid"}`, { role: "builder", ledger: "developer" });
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES (?, ?, 'company', 'project', ?, '/repo', '/worktrees', '/missing', ?, ?, 'lease', 'active', ?)").run(`worktree-handoff-${valid}`, turn.taskId, `workflow-handoff-${valid ? "valid" : "invalid"}`, `work/handoff-${valid ? "valid" : "invalid"}`, "d".repeat(40), stamp));
    const headSha = valid ? "e".repeat(40) : "invalid";
    const detectHandoff = async () => ({ kind: "clean_commit" as const, headSha, treeSha: "f".repeat(40) });
    const herdr = { runtimeSnapshot: async () => ({ agents: [], panes: [] }) };

    const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, detectHandoff: detectHandoff as never, now: () => stamp });
    const path = join(value.config.runtimeRoot, turn.resultRelativePath);

    if (valid) {
      const bytes = await readFile(path);
      expect(DeveloperDeliveryReportSchema.safeParse(JSON.parse(bytes.toString("utf8"))).success).toBe(true);
      expect(outcomes).toMatchObject([{ turnId: turn.turnId, action: "advance" }]);
      expect(value.database.authQuery((db) => db.prepare("SELECT status, result_sha256 FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId))).toEqual({ status: "completed", result_sha256: createHash("sha256").update(bytes).digest("hex") });
      expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_execution_events WHERE execution_id = ? AND kind = 'git_handoff'").get(`execution-handoff-valid`))).toEqual({ count: 1 });
    } else {
      expect(outcomes).toMatchObject([{ turnId: turn.turnId, action: "no_change", evidence: expect.arrayContaining(["advance:Git handoff result invalid"]) }]);
      await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
      expect(value.database.authQuery((db) => db.prepare("SELECT status, result_sha256 FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId))).toEqual({ status: "waiting", result_sha256: null });
    }
  }
});

test("Git handoff is disabled for incompatible ledgers and prompt kinds", async () => {
  const cases: Array<{ name: string; ledger: Ledger; role: Role; promptKind: string }> = [
    { name: "agent", ledger: "agent", role: "builder", promptKind: "implementation" },
    { name: "repair", ledger: "developer", role: "builder", promptKind: "delivery-repair" },
    { name: "ci", ledger: "developer", role: "integrator", promptKind: "ci-repair" },
    { name: "merge", ledger: "developer", role: "integrator", promptKind: "merge-conflict-resolution" },
  ];
  for (const item of cases) {
    const value = await fixture();
    const turn = value.addTurn(`incompatible-${item.name}`, item);
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES (?, ?, 'company', 'project', ?, '/repo', '/worktrees', '/missing', ?, ?, 'lease', 'active', ?)").run(`worktree-incompatible-${item.name}`, turn.taskId, `workflow-incompatible-${item.name}`, `work/incompatible-${item.name}`, "d".repeat(40), stamp));
    let detections = 0;
    const detectHandoff = async () => { detections += 1; return { kind: "clean_commit" as const, headSha: "e".repeat(40), treeSha: "f".repeat(40) }; };
    const herdr = { runtimeSnapshot: async () => ({ agents: [], panes: [] }) };

    await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, detectHandoff: detectHandoff as never });

    expect(detections, item.name).toBe(0);
    expect(value.database.authQuery((db) => db.prepare("SELECT status FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId)), item.name).not.toEqual({ status: "completed" });
  }
});

test("result and clean-handoff completion lose their exact CAS after session supersession", async () => {
  for (const kind of ["result", "handoff"] as const) {
    const value = await fixture();
    const turn = value.addTurn(`race-${kind}`, { role: "builder", ledger: "developer" });
    value.database.authQuery((db) => db.prepare("INSERT INTO forge_issue_worktrees (id, task_id, company_id, project_id, workflow_id, repository_path, worktree_root, worktree_path, branch_name, starting_sha, lease_token_hash, status, reserved_at) VALUES (?, ?, 'company', 'project', ?, '/repo', '/worktrees', '/missing', ?, ?, 'lease', 'active', ?)").run(`worktree-${kind}`, turn.taskId, `workflow-race-${kind}`, `work/race-${kind}`, "d".repeat(40), stamp));
    if (kind === "result") await value.writeResult(turn, validDeveloperDelivery);
    const detectHandoff = async () => kind === "result"
      ? { kind: "no_new_commit" as const, headSha: null }
      : { kind: "clean_commit" as const, headSha: "e".repeat(40), treeSha: "f".repeat(40) };
    const herdr = { runtimeSnapshot: async () => value.snapshot() };
    let superseded = false;
    const now = () => {
      if (!superseded) {
        superseded = true;
        value.database.authQuery((db) => db.prepare("UPDATE forge_herdr_role_sessions SET is_current = 0 WHERE id = ?").run(turn.sessionId));
      }
      return stamp;
    };

    const outcomes = await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, detectHandoff: detectHandoff as never, now });

    expect(outcomes).toMatchObject([{ turnId: turn.turnId, action: "no_change", evidence: expect.arrayContaining(["advance:completion CAS lost"]) }]);
    expect(value.database.authQuery((db) => db.prepare("SELECT status, result_sha256 FROM forge_herdr_turns WHERE turn_id = ?").get(turn.turnId))).toEqual({ status: "waiting", result_sha256: null });
    expect(value.database.authQuery((db) => db.prepare("SELECT COUNT(*) AS count FROM forge_developer_execution_events WHERE execution_id = ?").get(`execution-race-${kind}`))).toEqual({ count: 0 });
  }
});

test("a late exact-schema Developer result triggers one reconcile-only retry", async () => {
  const value = await fixture();
  const turn = value.addTurn("developer", { role: "builder", ledger: "developer", promptKind: "implementation", status: "completed", executionStatus: "failed" });
  await value.writeResult(turn, validDeveloperDelivery);
  const calls: unknown[] = [];
  const reconcileDeveloper = async (_config: unknown, workflowId: string, input: unknown) => {
    calls.push({ workflowId, input });
    value.database.authQuery((db) => db.prepare("UPDATE forge_developer_executions SET status = 'running', failure_code = NULL WHERE id = 'execution-developer'").run());
    return {} as never;
  };
  const herdr = { runtimeSnapshot: async () => ({ agents: [], panes: [] }) };
  await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, reconcileDeveloper: reconcileDeveloper as never });
  await reconcileActiveTurns(value.database, value.config, { herdr: herdr as never, reconcileDeveloper: reconcileDeveloper as never });
  expect(calls).toEqual([{ workflowId: "workflow-developer", input: { expectedRevision: 1, actorUserId: "system", commandId: `late-result-${turn.turnId}-${stamp}`, reconcileOnly: true } }]);
});
