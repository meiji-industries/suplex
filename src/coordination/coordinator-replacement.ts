import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ForgeDatabase } from "../platform/database.js";
import { assertProfileAllowed } from "../projects/provider-policy.js";
import { createOpenCodeMessageID } from "../runtimes/opencode/session.js";
import { TaskConfigurationSchema } from "../tasks/contracts.js";
import { TaskProfileSchema, type TaskSession } from "../tasks/control.js";
import type { CoordinatorReplacementRequest } from "./coordinator-replacement-contracts.js";
import { session } from "./persistence/session-operations.js";
import type { Row } from "./persistence/row-values.js";
import { turnOutcome } from "./workflows.js";
import { withCurrentDependencyStatus } from "./workflow-prompts.js";

const humanReply = z.object({ question: z.string(), answer: z.string() }).passthrough();
const limitReply = z.object({ question: z.string(), decision: z.unknown() }).passthrough();
const replacementIntent = z.object({ rootProfileId: z.string(), handoff: z.string(), resume: z.boolean(), questionId: z.string().nullable(), pendingQuestion: z.object({ id: z.string(), text: z.string(), options: z.unknown() }).nullable() }).passthrough();

function acceptedQuestions(turns: Row[]): Array<{ question: string; generation: number }> {
  const accepted: Array<{ question: string; generation: number }> = [];
  for (const turn of turns) {
    let parsed: unknown;
    try { parsed = JSON.parse(withCurrentDependencyStatus(String(turn.prompt_text), [])); } catch { continue; }
    const answer = humanReply.safeParse(parsed);
    if (answer.success) accepted.push({ question: answer.data.question, generation: Number(turn.session_generation) });
  }
  return accepted;
}

function humanMessages(turns: Row[]): string[] {
  const messages: string[] = [];
  for (const turn of turns) {
    const prompt = withCurrentDependencyStatus(String(turn.prompt_text), []);
    if (prompt.startsWith("Human note:\n")) messages.push(`Human note (${turn.created_at}):\n${prompt.slice("Human note:\n".length)}`);
    else {
      let parsed: unknown;
      try { parsed = JSON.parse(prompt); } catch { continue; }
      const answer = humanReply.safeParse(parsed);
      if (answer.success) messages.push(`Accepted human answer (${turn.created_at}):\n${answer.data.question}\nAnswer: ${answer.data.answer}`);
      else {
        const decision = limitReply.safeParse(parsed);
        if (decision.success) messages.push(`Accepted human task limit decision (${turn.created_at}):\n${decision.data.question}\nDecision: ${JSON.stringify(decision.data.decision)}`);
      }
    }
  }
  return messages;
}

export function replaceCoordinator(database: ForgeDatabase, taskId: string, request: CoordinatorReplacementRequest, initialPrompt: string): TaskSession {
  return database.authImmediateTransaction(db => {
    const task = db.prepare("SELECT c.*, t.archived_at, t.configuration_json FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id WHERE c.task_id = ?").get(taskId) as Row | undefined;
    if (!task || task.archived_at !== null || !["active", "waiting_human"].includes(String(task.status))) throw new Error("Only active or paused tasks can select a Coordinator.");
    const previous = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND id = ? AND kind = 'root' AND advisor_role IS NULL").get(taskId, request.sessionId) as Row | undefined;
    if (!previous) throw new Error("The Coordinator does not belong to this task.");
    const intent = { rootProfileId: request.rootProfileId, handoff: request.handoff ?? "", resume: request.resume, questionId: request.resume ? request.questionId : null };
    const existing = db.prepare("SELECT * FROM forge_task_sessions WHERE replaces_session_id = ? AND kind = 'root'").get(request.sessionId) as Row | undefined;
    if (existing) {
      const saved = replacementIntent.safeParse(JSON.parse(String(existing.replacement_reason)));
      if (!saved.success || saved.data.rootProfileId !== intent.rootProfileId || saved.data.handoff !== intent.handoff || saved.data.resume !== intent.resume || saved.data.questionId !== intent.questionId || task.root_session_id !== existing.id) throw new Error("The Coordinator changed. Read the current Coordinator before selecting another.");
      return session(existing);
    }
    if (previous.is_current !== 1 || task.root_session_id !== request.sessionId) throw new Error("The Coordinator changed. Read the current Coordinator before selecting another.");
    if (request.resume) {
      if (task.status !== "waiting_human" || task.human_question_id !== request.questionId) throw new Error("The current question changed. Read it before resuming.");
      if (task.limit_pause_json !== null || task.recovery_turn_id !== null) throw new Error("Answer the current task decision before resuming.");
    }
    const selected = db.prepare("SELECT p.id AS profileId, p.provider, p.model, p.reasoning_level AS reasoningLevel, p.service_tier AS serviceTier, p.provider_instance_id AS providerInstanceId, i.home_directory AS instanceHomeDirectory FROM forge_profiles p LEFT JOIN forge_provider_instances i ON i.id = p.provider_instance_id WHERE p.id = ? AND p.role = 'root' AND p.archived_at IS NULL").get(request.rootProfileId);
    if (!selected) throw new Error("The selected Coordinator profile does not exist.");
    const profile = TaskProfileSchema.parse(selected);
    const policy = TaskConfigurationSchema.pick({ providerPolicy: true }).strip().parse(JSON.parse(String(task.configuration_json))).providerPolicy;
    assertProfileAllowed(policy, profile);
    const oldProfile = TaskProfileSchema.parse(JSON.parse(String(previous.profile_json ?? task.root_profile_json)));
    const rootTurns = db.prepare("SELECT t.*, s.generation AS session_generation FROM forge_task_turns t JOIN forge_task_sessions s ON s.id = t.session_id WHERE t.task_id = ? AND s.kind = 'root' ORDER BY t.rowid").all(taskId) as Row[];
    const priorIntents = (db.prepare("SELECT replacement_reason, generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'root' AND replaces_session_id IS NOT NULL ORDER BY generation").all(taskId) as Row[]).flatMap(row => {
      let parsed: unknown;
      try { parsed = JSON.parse(String(row.replacement_reason)); } catch { return []; }
      const prior = replacementIntent.safeParse(parsed);
      return prior.success ? [{ ...prior.data, generation: Number(row.generation) }] : [];
    });
    const earlierDirections = priorIntents.flatMap(prior => prior.handoff ? [prior.handoff] : []);
    const answered = acceptedQuestions(rootTurns);
    const carriedQuestions = priorIntents.flatMap(prior => prior.pendingQuestion && !answered.some(answer => answer.question === prior.pendingQuestion?.text && answer.generation >= prior.generation) ? [prior.pendingQuestion] : []);
    const currentQuestion = task.human_question ? { id: String(task.human_question_id), text: String(task.human_question), options: JSON.parse(String(task.human_question_options_json ?? "[]")) } : null;
    const reason = JSON.stringify({ ...intent, pendingQuestion: currentQuestion });
    const outcomes = rootTurns.filter(turn => turn.terminal_observation !== null).slice(-4).map(turn => `Coordinator turn ${turn.id}: ${(turnOutcome(String(turn.terminal_observation)).text ?? String(turn.terminal_observation)).slice(-3000)}`);
    const delegates = (db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker' AND is_current = 1 ORDER BY created_at, id").all(taskId) as Row[]).map(row => {
      const latest = db.prepare("SELECT * FROM forge_task_turns WHERE session_id = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(row.id) as Row | undefined;
      return `Session ${row.id}, ${row.advisor_role ?? 'Worker'}, ${row.lifecycle}. Latest assignment/turn ${latest?.id ?? 'none'} (${latest?.status ?? 'none'}):\n${String(latest?.prompt_text ?? '').slice(-5000)}\nLatest result: ${latest?.terminal_observation ? (turnOutcome(String(latest.terminal_observation)).text ?? String(latest.terminal_observation)).slice(-4000) : 'pending'}`;
    });
    const unanswered = [...carriedQuestions, ...(currentQuestion ? [currentQuestion] : [])].filter((question, index, all) => all.findIndex(other => other.id === question.id) === index);
    const pendingQuestion = unanswered.length ? `Questions without an accepted answer:\n${unanswered.map(question => `Question ${question.id}:\n${question.text}\nOptions: ${JSON.stringify(question.options)}`).join("\n\n")}\nThese questions have NOT been answered. ${request.resume ? 'The user authorized resuming with a new Coordinator. Resolve a provider failure if possible; ask the user if a real decision is still necessary.' : task.status === 'waiting_human' ? 'The task stays paused until the user answers its current decision.' : 'The task is active. Reassess these questions and ask the user if a decision is still necessary.'}` : "";
    const handoff = [
      "Fresh Coordinator handoff. Continue this task from current authoritative Git, GitHub, native session, and task state. Do not replay an admitted old turn. Continue existing delegates and do not repeat completed assignments.",
      `Current task state: ${task.status}. Worktree: ${task.worktree_json ?? 'none'}. Pull request: ${task.pull_request_json ?? 'none'}. Workflow state: ${task.workflow_state_json ?? '{}'}.`,
      pendingQuestion,
      `Previously accepted human answers and notes, in order:\n${humanMessages(rootTurns).join("\n\n") || 'None recorded.'}`,
      `Earlier additional directions from the user, in order:\n${earlierDirections.join("\n\n") || 'None recorded.'}`,
      `Current delegate assignments and results:\n${delegates.join("\n\n") || 'No current delegates.'}`,
      `Recent Coordinator outcomes:\n${outcomes.join("\n\n") || 'None recorded.'}`,
      request.handoff ? `Additional direction from the user:\n${request.handoff}` : "",
    ].filter(Boolean).join("\n\n");
    const prompt = `${initialPrompt}\n\n${handoff}`;
    const time = new Date().toISOString();
    const id = randomUUID();
    const generation = Number((db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'root'").get(taskId) as Row).generation) + 1;
    db.prepare("UPDATE forge_task_sessions SET profile_json = ? WHERE task_id = ? AND kind = 'root' AND advisor_role IS NULL AND profile_json IS NULL").run(JSON.stringify(oldProfile), taskId);
    db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = ?, stopped_at = NULL, updated_at = ? WHERE id = ?").run(time, time, request.sessionId);
    db.prepare("UPDATE forge_task_turns SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(time, request.sessionId);
    db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, lifecycle, profile_json, replaces_session_id, replacement_reason, replacement_handoff, created_at, updated_at) VALUES (?, ?, 'root', ?, 1, 'reserved', ?, ?, ?, ?, ?, ?)").run(id, taskId, generation, JSON.stringify(profile), request.sessionId, reason, handoff, time, time);
    const promptHash = createHash("sha256").update(prompt).digest("hex");
    db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, id, generation, promptHash, prompt, time, time);
    db.prepare("UPDATE forge_task_controls SET root_session_id = ?, root_profile_json = ?, status = CASE WHEN ? THEN 'active' ELSE status END, status_changed_at = CASE WHEN ? THEN ? ELSE status_changed_at END, human_question = CASE WHEN ? THEN NULL ELSE human_question END, human_question_id = CASE WHEN ? THEN NULL ELSE human_question_id END, human_question_options_json = CASE WHEN ? THEN '[]' ELSE human_question_options_json END, wake_at = CASE WHEN status = 'active' OR ? THEN ? ELSE wake_at END, updated_at = ? WHERE task_id = ?").run(id, JSON.stringify(profile), Number(request.resume), Number(request.resume), time, Number(request.resume), Number(request.resume), Number(request.resume), Number(request.resume), time, time, taskId);
    return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
  });
}
