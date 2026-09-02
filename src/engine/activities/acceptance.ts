import type { AcceptanceActivities, AcceptDeliveryActivityInput, ReconcileAcceptanceActivityInput } from "../contracts/activities/acceptance.js";
import type { AttentionCategory } from "../contracts/primitives.js";
import type { ActivityContext } from "./context.js";
import { HerdrCodexProvider } from "../../agent-providers/herdr-codex.js";
import { CliHerdrClient } from "../../herdr-client.js";

export function createAcceptanceActivities(ctx: ActivityContext): AcceptanceActivities {
  const { database, AcceptanceFailure, acceptance, attentionFailure } = ctx;
  return {
    async acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }) {
      const note = input.note;
      let result;
      try { result = await acceptance.accept({ taskId: input.taskId, companyId: input.companyId, workflowId: input.workflowId, actorUserId: input.actorUserId, decision: input.decision ?? "accept", expectedHeadSha: input.expectedHeadSha, ...(note !== undefined ? { note } : {}) }); if (input.autoMerge && result.status === "accepted" && result.pullRequest) await acceptance.enableAutoMerge({ repository: result.pullRequest.repository, pullRequestNumber: result.pullRequest.number, baseBranch: result.pullRequest.baseBranch, baseSha: result.pullRequest.baseSha, headSha: input.expectedHeadSha }); }
      catch (error) { const category: AttentionCategory = error instanceof AcceptanceFailure && error.code === "stale" ? "target_drift" : error instanceof AcceptanceFailure && error.code === "provider" ? "provider_connectivity_exhausted" : "verification_unrecoverable"; return attentionFailure(input, category, "acceptance_failed", error instanceof Error ? error.message : "Delivery acceptance failed."); }
      if (input.decision === "request_changes" && note?.trim()) {
        try { await new HerdrCodexProvider(database, new CliHerdrClient()).forward(input.taskId, "lead", `[forge-note:delivery-${result.acceptanceId}]\n${note}`); } catch { /* the structured decision remains authoritative */ }
      }
      return { acceptanceId: result.acceptanceId, status: result.status, ...(result.outcome ? { outcome: result.outcome } : {}), ...(result.retryAt !== undefined ? { retryAt: result.retryAt } : {}), ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}), pullRequestNumber: result.pullRequest?.number ?? 0, pullRequestUrl: result.pullRequest?.url ?? "", ...(result.readyAt !== undefined ? { readyAt: result.readyAt } : {}), ...(result.acceptedAt !== undefined ? { acceptedAt: result.acceptedAt } : {}), ...(result.reasonArtifactId !== undefined ? { reasonArtifactId: result.reasonArtifactId } : {}) };
    },
    async reconcileAcceptance(input: ReconcileAcceptanceActivityInput) {
      const result = await acceptance.reconcileReady({ acceptanceId: input.acceptanceId, taskId: input.taskId, companyId: input.companyId });
      return { acceptanceId: result.acceptanceId, status: result.status, outcome: result.outcome, retryAt: result.retryAt, readyAt: result.readyAt, acceptedAt: result.acceptedAt, ...(result.blocker ? { blockerCode: result.blocker.code, blockerSummary: result.blocker.summary, evidenceArtifactId: result.blocker.evidenceArtifactId } : {}), pullRequestNumber: result.pullRequest?.number ?? 0, pullRequestUrl: result.pullRequest?.url ?? "" };
    },
  };
}
