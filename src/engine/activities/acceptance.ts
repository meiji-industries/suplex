import type { AcceptanceActivities, AcceptDeliveryActivityInput, ReconcileAcceptanceActivityInput } from "../contracts/activities/acceptance.js";
import type { AttentionCategory } from "../contracts/primitives.js";
import type { ActivityContext } from "./context.js";
import { loadTaskConfiguration } from "../../task-project-configuration.js";
import { HerdrCodexProvider } from "../../agent-providers/herdr-codex.js";
import { CliHerdrClient } from "../../herdr-client.js";

export function createAcceptanceActivities(ctx: ActivityContext): AcceptanceActivities {
  const { database, config, ArtifactStore, redact, AcceptanceFailure, artifacts, acceptance, attentionFailure, pinnedProjectRevision } = ctx;
  return {
    async acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }) {
      let configuration;
      try { configuration = database.authQuery((db) => loadTaskConfiguration(db, artifacts, input)); }
      catch { return attentionFailure(input, "provider_ambiguity", "acceptance_context_unavailable", "Acceptance context is unavailable for delivery acceptance."); }
      let pinned: ReturnType<typeof pinnedProjectRevision>;
      try { pinned = configuration; } catch { return attentionFailure(input, "provider_ambiguity", "acceptance_context_unavailable", "Acceptance context is unavailable for delivery acceptance."); }
      void pinned;
      let note = input.note;
      let stagedNote: { companyId: string; storagePath: string } | undefined;
      if (input.noteId) {
        stagedNote = { companyId: input.companyId, storagePath: `${input.companyId}/staging/${input.noteId}.bin` };
        try {
          const bytes = await new ArtifactStore(config.artifactRoot).readStaged(input.companyId, input.noteId);
          note = (redact(bytes.toString("utf8").trim()) as string).trim();
          if (!note) throw new Error("Delivery feedback is unavailable");
        } catch {
          return attentionFailure(input, "verification_unrecoverable", "delivery_note_unavailable", "Delivery feedback is unavailable.");
        }
      }
      let result;
      try { result = await acceptance.accept({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, projectRevisionId: configuration.artifactId, releaseId: input.releaseId, deliveryReviewId: input.deliveryReviewId, finalReviewId: input.finalReviewId, ciRunId: input.ciRunId, pullRequestNumber: input.pullRequestNumber, repository: input.repository, baseBranch: input.baseBranch, baseSha: input.baseSha, headSha: input.expectedHeadSha, headTree: input.expectedHeadTree, leadSessionRef: input.leadSessionRef, actorUserId: input.actorUserId, ...(input.decision ? { decision: input.decision } : {}), ...(note !== undefined ? { reason: note } : {}) }); if (input.autoMerge && result.status === "accepted") await acceptance.enableAutoMerge({ repository: input.repository, pullRequestNumber: input.pullRequestNumber, baseBranch: input.baseBranch, baseSha: input.baseSha, headSha: input.expectedHeadSha }); }
      catch (error) { const category: AttentionCategory = error instanceof AcceptanceFailure && error.code === "stale" ? "target_drift" : error instanceof AcceptanceFailure && error.code === "provider" ? "provider_connectivity_exhausted" : "verification_unrecoverable"; return attentionFailure(input, category, "acceptance_failed", error instanceof Error ? error.message : "Delivery acceptance failed."); }
      if (input.decision === "request_changes" && note?.trim()) {
        try { await new HerdrCodexProvider(database, new CliHerdrClient()).forward(input.taskId, "lead", `[forge-note:delivery-${result.acceptanceId}]\n${note}`); } catch { /* the structured decision remains authoritative */ }
      }
      if (stagedNote) await new ArtifactStore(config.artifactRoot).discardStaged(stagedNote);
      return { acceptanceId: result.acceptanceId, status: result.status, ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}), ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}), pullRequestNumber: result.pullRequest?.number ?? input.pullRequestNumber, pullRequestUrl: result.pullRequest?.url ?? "", ...(result.readyAt !== undefined ? { readyAt: result.readyAt } : {}), ...(result.acceptedAt !== undefined ? { acceptedAt: result.acceptedAt } : {}), ...(result.reasonArtifactId !== undefined ? { reasonArtifactId: result.reasonArtifactId } : {}) };
    },
    async reconcileAcceptance(input: ReconcileAcceptanceActivityInput) {
      const result = await acceptance.reconcileReady({ acceptanceId: input.acceptanceId, taskId: input.taskId, companyId: input.companyId });
      return { acceptanceId: result.acceptanceId, status: result.status, outcome: result.outcome, retryAt: result.retryAt, readyAt: result.readyAt, acceptedAt: result.acceptedAt, ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}), pullRequestNumber: result.pullRequest?.number ?? 0, pullRequestUrl: result.pullRequest?.url ?? "" };
    },
  };
}
