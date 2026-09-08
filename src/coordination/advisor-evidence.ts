import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactStore } from "../platform/artifacts.js";
import type { TaskControl, TaskSession, TaskTurn } from "../tasks/control.js";
import { writeTaskEvidence } from "./workflow-evidence.js";
import type { ReviewRange } from "./workflows.js";
import { parseObservation, turnWorkflowInput } from "./controller-reports.js";
import type { TaskControlStore } from "./root-session-store.js";

export async function prepareAdvisorEvidence(input: { store: TaskControlStore; delivery: { checksObservation?(taskId: string): Promise<unknown> }; artifacts: ArtifactStore | undefined; evidenceRoot: string | undefined; control: TaskControl; range: ReviewRange; sessions: TaskSession[]; turns: TaskTurn[] }) {
  const { control, store } = input;
  if (!control.worktree) throw new Error("The task has no worktree");
  if (!input.evidenceRoot) throw new Error("Task evidence storage is not configured");
  const context = store.context(control.taskId);
  const images = context.images as Array<{ artifactId: string; filename: string }>;
  const workerTurns = input.sessions.filter(session => session.kind === "worker" && session.advisorRole === null).flatMap(session => input.turns.filter(turn => turn.sessionId === session.id && turn.status === "completed").map(turn => ({ session, turn, input: turnWorkflowInput(session, turn), parsed: parseObservation(turn.terminalObservation) })));
  const verification = { configuration: { verificationCommand: context.configuration.verificationCommand, runProjectTests: context.configuration.runProjectTests, visualEvidence: context.configuration.visualEvidence }, pullRequest: control.pullRequest, pullRequestChecks: input.delivery.checksObservation ? await input.delivery.checksObservation(control.taskId) : null, workerTurns: workerTurns.map(({ session, turn, input: workflowInput, parsed }) => ({ turnId: turn.id, sessionId: session.id, mode: workflowInput?.kind === "worker" ? workflowInput.mode : "planned", purpose: workflowInput?.kind === "worker" ? workflowInput.purpose : "implementation", range: workflowInput?.kind === "worker" ? workflowInput.range : null, state: parsed.state, text: parsed.text, tools: parsed.tools, limit: parsed.toolsLimit ?? (parsed.tools === null ? "Native tool evidence was not captured for this turn" : null), verificationRange: parsed.verificationRange, sourceRangeProof: parsed.verificationRange ? (parsed.verificationRange.valid ? "valid" : "invalid") : "none" })) };
  const evidence = await writeTaskEvidence({ root: input.evidenceRoot, taskId: control.taskId, worktree: control.worktree.path, range: input.range, verification, attachments: images.map(image => ({ artifactId: image.artifactId, mimeType: store.image(control.taskId, image.artifactId).mimeType, read: async () => {
    if (!input.artifacts) throw new Error("Task image storage is not configured");
    const artifact = store.image(control.taskId, image.artifactId);
    const bytes = await input.artifacts.getArtifact(artifact);
    if (createHash("sha256").update(bytes).digest("hex") !== artifact.sha256) throw new Error("The task image changed in storage");
    return bytes;
  } })) });
  const manifest = JSON.parse(await readFile(join(evidence.directory, "manifest.json"), "utf8")) as { attachments: Array<{ artifactId: string; path: string | null; error: string | null }> };
  return { context, images, workerTurns, evidence, attachments: manifest.attachments };
}
