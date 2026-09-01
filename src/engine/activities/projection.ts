import type { DeliveryBlockerActivities, DeliveryBlockerActivityInput, DeliveryBlockerActivityResult, ProjectionActivities } from "../contracts/activities/projection.js";
import type { IssueProjectionEvent, IssueWorkflowState } from "../issue-contracts.js";
import type { ActivityContext } from "./context.js";
import { reconcileHerdrSessions } from "../../herdr-recovery.js";

export function createProjectionActivities(ctx: ActivityContext): ProjectionActivities & DeliveryBlockerActivities {
  const { database, activityLogContext, logger, artifacts } = ctx;
  return {
    async projectIssueState(input: IssueProjectionEvent): Promise<IssueWorkflowState> {
      database.projectIssueEvent(input);
      if (input.state.phase === "done" || input.state.phase === "cancelled") {
        try { await reconcileHerdrSessions(database, undefined, input.state.issueId); } catch { logger.child(activityLogContext()).warn("Herdr session reconciliation failed", { taskId: input.state.issueId }); }
      }
      return input.state;
    },
    async recordDeliveryBlocker(input: DeliveryBlockerActivityInput): Promise<DeliveryBlockerActivityResult> {
      const summary = input.operation === "review" ? "The delivery review infrastructure did not complete; retry the review." : "The delivery repair infrastructure did not complete; retry the repair.";
      const artifact = await artifacts.putArtifact(input.companyId, "delivery-blocker", { filename: `${input.workflowId}-${input.operation}-blocker.json`, mimeType: "application/json", bytes: Buffer.from(JSON.stringify({ type: "forge.delivery-blocker", operation: input.operation, summary }), "utf8") });
      return { artifactId: artifact.id };
    },
  };
}
