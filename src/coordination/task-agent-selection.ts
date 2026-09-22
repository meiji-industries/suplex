import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { SuplexDatabase } from "../platform/database.js";
import { assertProfileAllowed } from "../projects/provider-policy.js";
import { createOpenCodeMessageID } from "../runtimes/opencode/session.js";
import { TaskConfigurationSchema } from "../tasks/contracts.js";
import { TaskProfileSchema, type TaskSession } from "../tasks/control.js";
import { session, turn } from "./persistence/session-operations.js";
import type { Row } from "./persistence/row-values.js";
import { ADVISOR_LABELS, AgentSelectionIntentSchema, WorkflowIdSchema, WorkflowStateSchema, turnOutcome, workflowDefinition } from "./workflows.js";
import type { TaskAgentSelectionRequest } from "./task-agent-selection-contracts.js";

const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const changed = () => new Error("The agent changed. Read the current agent before selecting another.");

export function selectDelegate(database: SuplexDatabase, taskId: string, request: TaskAgentSelectionRequest, initialPrompt: string): TaskSession | null {
  if (request.role === "root") throw new Error("Select the Coordinator through its replacement command.");
  const role = request.role;
  return database.authImmediateTransaction(db => {
    const task = db.prepare("SELECT c.*, t.archived_at, t.configuration_json FROM suplex_task_controls c JOIN suplex_tasks t ON t.id = c.task_id WHERE c.task_id = ?").get(taskId) as Row | undefined;
    if (!task || task.archived_at !== null || !["active", "waiting_human"].includes(String(task.status))) throw new Error("Only active or paused tasks can select an agent.");
    if (role !== "worker" && !workflowDefinition(WorkflowIdSchema.parse(task.workflow)).advisorRoles.includes(role)) throw new Error("The selected role is not in this workflow.");
    const advisors = z.record(z.string(), TaskProfileSchema).parse(JSON.parse(String(task.advisor_profiles_json)));
    const previousProfile = request.role === "worker" ? TaskProfileSchema.parse(JSON.parse(String(task.worker_profile_json))) : advisors[request.role] ?? TaskProfileSchema.parse(JSON.parse(String(task.root_profile_json)));
    const current = db.prepare("SELECT * FROM suplex_task_sessions WHERE task_id = ? AND kind = 'worker' AND advisor_role IS ? AND is_current = 1 ORDER BY generation DESC LIMIT 1").get(taskId, request.role === "worker" ? null : request.role) as Row | undefined;
    const state = WorkflowStateSchema.parse(JSON.parse(String(task.workflow_state_json)));
    const intent = AgentSelectionIntentSchema.parse({ role: request.role, expectedProfileId: request.expectedProfileId, expectedSessionId: request.expectedSessionId, profileId: request.profileId, direction: request.direction, resume: request.resume, questionId: request.resume ? request.questionId : null });
    if (state.agentSelections?.[role] && JSON.stringify(state.agentSelections[role]) === JSON.stringify(intent) && previousProfile.profileId === request.profileId) return current ? session(current) : null;
    if (previousProfile.profileId !== request.expectedProfileId || (current?.id ?? null) !== request.expectedSessionId) throw changed();
    if (request.resume && (task.status !== "waiting_human" || task.human_question_id !== request.questionId || task.limit_pause_json !== null || task.recovery_turn_id !== null)) throw new Error("Answer the current task decision before resuming.");
    const selected = db.prepare("SELECT p.id AS profileId, p.provider, p.model, p.reasoning_level AS reasoningLevel, p.service_tier AS serviceTier, p.provider_instance_id AS providerInstanceId, i.home_directory AS instanceHomeDirectory FROM suplex_profiles p LEFT JOIN suplex_provider_instances i ON i.id = p.provider_instance_id WHERE p.id = ? AND p.role = ? AND p.archived_at IS NULL").get(request.profileId, request.role === "worker" ? "worker" : "root");
    if (!selected) throw new Error("The selected agent profile does not exist.");
    const profile = TaskProfileSchema.parse(selected);
    const policy = TaskConfigurationSchema.pick({ providerPolicy: true }).strip().parse(JSON.parse(String(task.configuration_json))).providerPolicy;
    assertProfileAllowed(policy, profile);
    const time = new Date().toISOString();
    const latest = current ? db.prepare("SELECT * FROM suplex_task_turns WHERE session_id = ? AND generation = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(current.id, current.generation) as Row | undefined : undefined;
    const outcome = latest ? turnOutcome(latest.terminal_observation === null ? null : String(latest.terminal_observation)) : null;
    const successful = latest?.status === "completed" && outcome?.state === "completed" && (request.role === "worker" || outcome.advisor?.role === request.role && outcome.advisor.result !== null);
    const unfinished = !!latest && !successful;
    db.prepare("UPDATE suplex_task_sessions SET profile_json = ? WHERE task_id = ? AND kind = 'worker' AND advisor_role IS ? AND profile_json IS NULL").run(JSON.stringify(previousProfile), taskId, role === "worker" ? null : role);
    let replacement: TaskSession | null = null;
    if (current && unfinished && latest) {
      const assignment = turn(latest);
      const inherited = String(current.replacement_handoff ?? "");
      const suffix = inherited && assignment.promptText.endsWith(`\n\nFresh Worker handoff:\n${inherited}`) ? `\n\nFresh Worker handoff:\n${inherited}` : "";
      const base = suffix ? assignment.promptText.slice(0, -suffix.length) : assignment.promptText;
      const handoff = [inherited, request.direction ? `Additional direction from the user:\n${request.direction}` : "", "Continue the preserved assignment. Inspect current work and evidence before changing it."].filter(Boolean).join("\n\n");
      const prompt = `${base}\n\nFresh Worker handoff:\n${handoff}`;
      const id = randomUUID();
      const generation = Number((db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM suplex_task_sessions WHERE task_id = ? AND kind = 'worker'").get(taskId) as Row).generation) + 1;
      db.prepare("UPDATE suplex_task_sessions SET is_current = 0, lifecycle = 'cancelled', stop_requested_at = ?, stopped_at = NULL, updated_at = ? WHERE id = ?").run(time, time, current.id);
      db.prepare("UPDATE suplex_task_turns SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(time, current.id);
      const input = assignment.workflowInput ?? session(current).workflowInput;
      db.prepare("INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, assignment_hash, advisor_role, delegate_slot, workflow_input_json, profile_json, replaces_session_id, replacement_reason, replacement_handoff, created_at, updated_at) VALUES (?, ?, 'worker', ?, 1, 'reserved', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, taskId, generation, digest(prompt), request.role === "worker" ? null : request.role, current.delegate_slot ?? "delegate", input ? JSON.stringify(input) : null, JSON.stringify(profile), current.id, "User selected a new agent", handoff, time, time);
      db.prepare("INSERT INTO suplex_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, workflow_input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?, ?)").run(createOpenCodeMessageID(), taskId, id, generation, digest(prompt), digest(prompt), prompt, input ? JSON.stringify(input) : null, time, time);
      if (request.role === "worker" || task.worker_session_id === current.id) db.prepare("UPDATE suplex_task_controls SET worker_session_id = ? WHERE task_id = ?").run(id, taskId);
      replacement = session(db.prepare("SELECT * FROM suplex_task_sessions WHERE id = ?").get(id) as Row);
    }
    if (request.role === "worker") db.prepare("UPDATE suplex_task_controls SET worker_profile_json = ? WHERE task_id = ?").run(JSON.stringify(profile), taskId);
    else db.prepare("UPDATE suplex_task_controls SET advisor_profiles_json = ? WHERE task_id = ?").run(JSON.stringify({ ...advisors, [request.role]: profile }), taskId);
    let root = db.prepare("SELECT * FROM suplex_task_sessions WHERE id = ? AND task_id = ? AND kind = 'root' AND is_current = 1").get(task.root_session_id, taskId) as Row | undefined;
    if (!root) {
      const id = randomUUID();
      const generation = Number((db.prepare("SELECT COALESCE(MAX(generation), 0) AS generation FROM suplex_task_sessions WHERE task_id = ? AND kind = 'root'").get(taskId) as Row).generation) + 1;
      db.prepare("INSERT INTO suplex_task_sessions (id, task_id, kind, generation, is_current, lifecycle, profile_json, created_at, updated_at) VALUES (?, ?, 'root', ?, 1, 'reserved', ?, ?, ?)").run(id, taskId, generation, task.root_profile_json, time, time);
      db.prepare("UPDATE suplex_task_controls SET root_session_id = ? WHERE task_id = ?").run(id, taskId);
      db.prepare("INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, id, generation, digest(initialPrompt), initialPrompt, time, time);
      root = db.prepare("SELECT * FROM suplex_task_sessions WHERE id = ?").get(id) as Row;
    }
    const question = task.human_question ? `Question ${task.human_question_id} remains unanswered: ${task.human_question}\nOptions: ${task.human_question_options_json ?? '[]'}` : "";
    const label = role === "worker" ? "Worker" : ADVISOR_LABELS[role];
    const note = `Human note:\n${[`The user selected ${label} profile ${profile.profileId}.`, request.direction ? `Additional direction from the user:\n${request.direction}` : "", question, replacement ? `Continue with replacement session ${replacement.id} and the preserved assignment.` : "Use this selection for future assignments. Do not repeat completed work."].filter(Boolean).join("\n\n")}`;
    db.prepare("INSERT INTO suplex_task_turns (id, task_id, session_id, generation, prompt_hash, prompt_text, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?)").run(createOpenCodeMessageID(), taskId, root.id, root.generation, digest(note), note, time, time);
    const next = { ...state, agentSelections: { ...state.agentSelections, [request.role]: intent } };
    db.prepare("UPDATE suplex_task_controls SET workflow_state_json = ?, status = CASE WHEN ? THEN 'active' ELSE status END, status_changed_at = CASE WHEN ? THEN ? ELSE status_changed_at END, human_question = CASE WHEN ? THEN NULL ELSE human_question END, human_question_id = CASE WHEN ? THEN NULL ELSE human_question_id END, human_question_options_json = CASE WHEN ? THEN '[]' ELSE human_question_options_json END, wake_at = CASE WHEN ? OR status = 'active' THEN ? ELSE wake_at END, updated_at = ? WHERE task_id = ?").run(JSON.stringify(next), request.resume ? 1 : 0, request.resume ? 1 : 0, time, request.resume ? 1 : 0, request.resume ? 1 : 0, request.resume ? 1 : 0, request.resume ? 1 : 0, time, time, taskId);
    return replacement ?? (current ? session(db.prepare("SELECT * FROM suplex_task_sessions WHERE id = ?").get(current.id) as Row) : null);
  });
}
