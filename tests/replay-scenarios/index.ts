import type { ReplayScenarioDefinition } from "../replay-scenario-driver.js";
import { scenario as normalSuccess } from "./normal-success.js";
import { scenario as implementationRepair } from "./implementation-repair.js";
import { scenario as activeCancellation } from "./active-cancellation.js";
import { scenario as blockedAuthenticationResume } from "./blocked-authentication-resume.js";
import { scenario as continueAsNew } from "./continue-as-new.js";
import { scenario as releaseBaseDriftMerged } from "./release-base-drift-merged.js";
import { scenario as releaseBaseDriftConflict } from "./release-base-drift-conflict.js";
import { scenario as ciWaitRetry } from "./ci-wait-retry.js";
import { scenario as acceptanceReadyTimeout } from "./acceptance-ready-timeout.js";
import { scenario as acceptanceRequestedChanges } from "./acceptance-requested-changes.js";
import { scenario as acceptanceProviderOutage } from "./acceptance-provider-outage.js";
import { scenario as manualMergeOpen } from "./manual-merge-open.js";
import { scenario as manualMergeClosed } from "./manual-merge-closed.js";
import { scenario as manualMergeChanged } from "./manual-merge-changed.js";
import { scenario as finalReviewFailure } from "./final-review-failure.js";
import { scenario as planRevision } from "./plan-revision.js";
import { scenario as successorCreation } from "./successor-creation.js";
import { scenario as developerActiveWorkerLoss } from "./developer-active-worker-loss.js";
import { scenario as developerCancellation } from "./developer-cancellation.js";
import { scenario as developerLinkedRetry } from "./developer-linked-retry.js";
import { scenario as developerResultClaim } from "./developer-result-claim.js";
import { scenario as developerBlockedCancellation } from "./developer-blocked-cancellation.js";
import { scenario as developerReconciliationRecovery } from "./developer-reconciliation-recovery.js";
import { scenario as sourcePullRequestMerged } from "./source-pull-request-merged.js";
import { scenario as sourcePullRequestAdopted } from "./source-pull-request-adopted.js";

export const replayScenarios = [
  normalSuccess,
  implementationRepair,
  activeCancellation,
  blockedAuthenticationResume,
  continueAsNew,
  releaseBaseDriftMerged,
  releaseBaseDriftConflict,
  ciWaitRetry,
  acceptanceReadyTimeout,
  acceptanceRequestedChanges,
  acceptanceProviderOutage,
  manualMergeOpen,
  manualMergeClosed,
  manualMergeChanged,
  finalReviewFailure,
  planRevision,
  successorCreation,
  developerActiveWorkerLoss,
  developerCancellation,
  developerLinkedRetry,
  developerResultClaim,
  developerReconciliationRecovery,
  developerBlockedCancellation,
  sourcePullRequestMerged,
  sourcePullRequestAdopted,
] as const satisfies readonly ReplayScenarioDefinition[];
