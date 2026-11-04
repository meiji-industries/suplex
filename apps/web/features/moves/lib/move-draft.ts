import type { MoveDraft } from "../../../contracts/generated/MoveDraft.js";
import type { MoveBody } from "../../../contracts/moves.js";

export const taskDefaults = { workflow: "standard", deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "off" } as const;

/**
 * A script keeps no agent.
 * A task uses the project's agents, starts without a confirmation, and keeps task settings that other runners clear.
 */
export function withRunner(draft: MoveBody, runner: MoveBody["runner"]): MoveBody {
  if (runner === "task") return { ...draft, runner, profileId: null, confirm: false };
  return { ...draft, ...taskDefaults, runner, profileId: runner === "script" ? null : draft.profileId ?? null };
}

/** The editor fields after an agent draft. The project stays, and a runner outside your options becomes a task. */
export function applyMoveDraft(current: MoveBody, proposed: MoveDraft, admin: boolean): MoveBody {
  const allowed = admin || proposed.runner === "pull_request_tasks" || proposed.runner === "task";
  const next = withRunner(current, allowed ? proposed.runner : "task");
  return { ...next, name: proposed.name, prompt: proposed.prompt, confirm: next.runner !== "task" && proposed.confirm };
}
