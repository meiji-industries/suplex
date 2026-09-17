import { createHash, randomUUID } from "node:crypto";
import { TaskConfigurationSchema } from "../tasks/contracts.js";
import { assertProfileAllowed } from "../projects/provider-policy.js";
import type { WorkerReplacementRequest } from "./worker-replacement-contracts.js";
import type { ForgeDatabase } from "../platform/database.js";
import { TaskProfileSchema, type TaskSession } from "../tasks/control.js";
import { createOpenCodeMessageID } from "../runtimes/opencode/session.js";
import { session, turn } from "./persistence/session-operations.js";
import type { Row } from "./persistence/row-values.js";
import { turnOutcome } from "./workflows.js";

export function replaceWorker(database: ForgeDatabase, taskId: string, request: WorkerReplacementRequest): TaskSession {
  return database.authImmediateTransaction(db => {
    const task = db.prepare("SELECT c.*, t.archived_at, t.configuration_json FROM forge_task_controls c JOIN forge_tasks t ON t.id = c.task_id WHERE c.task_id = ?").get(taskId) as Row | undefined;
    if (!task || task.archived_at !== null || !["active", "waiting_human"].includes(String(task.status))) throw new Error("Only active or paused tasks can replace a Worker.");
    const previous = db.prepare("SELECT * FROM forge_task_sessions WHERE task_id = ? AND id = ? AND kind = 'worker' AND advisor_role IS NULL").get(taskId, request.sessionId) as Row | undefined;
    if (!previous) throw new Error("The Worker does not belong to this task.");
    const existing = db.prepare("SELECT * FROM forge_task_sessions WHERE replaces_session_id = ?").get(request.sessionId) as Row | undefined;
    if (existing) return session(existing);
    if (previous.is_current !== 1) throw new Error("The Worker changed. Read the current Worker before replacing it.");
    const assignments = (db.prepare("SELECT * FROM forge_task_turns WHERE session_id = ? ORDER BY created_at, id").all(request.sessionId) as Row[]).map(turn);
    const assignment = assignments.at(-1);
    if (!assignment) throw new Error("The Worker has no saved assignment.");
    const previousProfile = TaskProfileSchema.parse(JSON.parse(String(previous.profile_json ?? task.worker_profile_json)));
    const selected = request.workerProfileId ? db.prepare("SELECT p.id AS profileId, p.provider, p.model, p.reasoning_level AS reasoningLevel, p.service_tier AS serviceTier, p.provider_instance_id AS providerInstanceId, i.home_directory AS instanceHomeDirectory FROM forge_profiles p LEFT JOIN forge_provider_instances i ON i.id = p.provider_instance_id WHERE p.id = ? AND p.role = 'worker' AND p.archived_at IS NULL").get(request.workerProfileId) : previousProfile;
    if (!selected) throw new Error("The selected Worker profile does not exist.");
    const profile = TaskProfileSchema.parse(selected);
    assertProfileAllowed(TaskConfigurationSchema.pick({ providerPolicy: true }).strip().parse(JSON.parse(String(task.configuration_json))).providerPolicy, profile);
    const latestResult = [...assignments].reverse().find(value => value.terminalObservation !== null);
    const result = latestResult ? turnOutcome(latestResult.terminalObservation).text ?? "" : "No completed Worker result exists.";
    const handoff = [`Reason for replacement: ${request.reason}`, request.handoff ? `Additional direction:\n${request.handoff}` : "", `Latest Worker result (verify its claims against source and command evidence):\n${result.slice(-12000)}`, "Inspect the preserved worktree, branch, and current Git status. Preserve existing commits and uncommitted work. Finish the remaining assignment and its checks. Report exact verification and the resulting commit. Use a different approach if the previous attempts did not advance the assignment."].filter(Boolean).join("\n\n");
    const oldHandoff = previous.replacement_handoff ? `\n\nFresh Worker handoff:\n${previous.replacement_handoff}` : "";
    const savedAssignment = oldHandoff && assignment.promptText.endsWith(oldHandoff) ? assignment.promptText.slice(0, -oldHandoff.length) : assignment.promptText;
    const prompt = `${savedAssignment}\n\nFresh Worker handoff:\n${handoff}`;
    const timestamp = new Date().toISOString();
    const id = randomUUID();
    const generation = Number((db.prepare("SELECT MAX(generation) AS generation FROM forge_task_sessions WHERE task_id = ? AND kind = 'worker'").get(taskId) as Row).generation) + 1;
    db.prepare("UPDATE forge_task_sessions SET profile_json = ? WHERE task_id = ? AND kind = 'worker' AND advisor_role IS NULL AND profile_json IS NULL").run(JSON.stringify(previousProfile), taskId);
    db.prepare("UPDATE forge_task_sessions SET is_current = 0, lifecycle = 'cancelled', stopped_at = NULL, stop_requested_at = ?, profile_json = COALESCE(profile_json, ?), updated_at = ? WHERE id = ?").run(timestamp, JSON.stringify(previousProfile), timestamp, request.sessionId);
    db.prepare("UPDATE forge_task_turns SET status = 'cancelled', updated_at = ? WHERE session_id = ? AND status IN ('pending_prompt', 'prompted', 'unknown')").run(timestamp, request.sessionId);
    const hash = createHash("sha256").update(prompt).digest("hex");
    db.prepare("INSERT INTO forge_task_sessions (id, task_id, kind, generation, is_current, lifecycle, assignment_hash, delegate_slot, workflow_input_json, profile_json, replaces_session_id, replacement_reason, replacement_handoff, created_at, updated_at) VALUES (?, ?, 'worker', ?, 1, 'reserved', ?, 'delegate', ?, ?, ?, ?, ?, ?, ?)").run(id, taskId, generation, hash, assignment.workflowInput ? JSON.stringify(assignment.workflowInput) : null, JSON.stringify(profile), request.sessionId, request.reason, handoff, timestamp, timestamp);
    db.prepare("INSERT INTO forge_task_turns (id, task_id, session_id, generation, assignment_hash, prompt_hash, prompt_text, status, workflow_input_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending_prompt', ?, ?, ?)").run(createOpenCodeMessageID(), taskId, id, generation, hash, hash, prompt, assignment.workflowInput ? JSON.stringify(assignment.workflowInput) : null, timestamp, timestamp);
    db.prepare("UPDATE forge_task_controls SET worker_session_id = ?, worker_profile_json = ?, wake_at = NULL, updated_at = ? WHERE task_id = ?").run(id, JSON.stringify(profile), timestamp, taskId);
    return session(db.prepare("SELECT * FROM forge_task_sessions WHERE id = ?").get(id) as Row);
  });
}

export function workerReplacementReady(database: ForgeDatabase, sessionId: string): boolean {
  return !database.authQuery(db => db.prepare(`WITH RECURSIVE ancestors(id) AS (
    SELECT replaces_session_id FROM forge_task_sessions WHERE id = ?
    UNION ALL SELECT s.replaces_session_id FROM forge_task_sessions s JOIN ancestors a ON s.id = a.id
  ) SELECT 1 FROM forge_task_sessions s JOIN ancestors a ON s.id = a.id WHERE s.stop_requested_at IS NOT NULL AND s.stopped_at IS NULL LIMIT 1`).get(sessionId));
}
