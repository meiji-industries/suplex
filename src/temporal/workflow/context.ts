import type { CancellationScope } from "@temporalio/workflow";

import type { CapacityOperation, CapacityRole } from "../../capacity-contracts.js";
import type {
  IssueBlocker,
  IssueCommand,
  IssueWorkflowInput,
  IssueWorkflowState,
  LeadPlanningResult,
  ReconcileTargetBaseActivityResult,
  TargetBaseCheckpoint,
} from "../issue-contracts.js";

export type Failure = { code: string; summary: string; category?: IssueBlocker["category"]; evidenceArtifactId?: string; evidenceSha256?: string };
export type StateRef = { get(): IssueWorkflowState; set(next: IssueWorkflowState): void };
export type ExternalTurnSpec = { operation: CapacityOperation; role: CapacityRole; profileId?: string | undefined; sessionRef?: string | null | undefined; worktreePath?: string | null | undefined };
export type CapacityCancellation = { status: "cancelled" | "ownership_ambiguous"; executionId?: string | undefined };
export type RecoveryStatus = "starting" | "active" | "reconnecting" | "result_pending_claim" | "cancellation_requested" | "cancelling" | "interrupted" | "cancelled" | "ownership_ambiguous" | "failed";

export interface IssueWorkflowContext {
  readonly input: IssueWorkflowInput;
  readonly repairCycleLimit: number;
  state: IssueWorkflowState;
  readonly project: () => Promise<IssueWorkflowState>;
  readonly projectState: (state: IssueWorkflowState) => Promise<IssueWorkflowState>;
  readonly projectInitialPlanningState: (next: IssueWorkflowState, distinctPlanningStates: boolean) => Promise<void>;
  readonly planningProjectionFlags: () => { distinctPlanningStates: boolean; shouldProject: boolean };
  readonly leadPlanningEnabled: () => boolean;
  readonly durablePlanningCapacityEnabled: () => boolean;
  readonly leadResultRoutingEnabled: () => boolean;
  readonly planGovernanceEnabled: () => boolean;
  readonly decisionResolutionProjectionEnabled: () => boolean;
  readonly continueAfter: number;
  readonly reviseContinueEnabled: boolean;
  readonly exactPlanAuthorityEnabled: boolean;
  readonly isolatedDeveloperExecutionEnabled: boolean;
  readonly initialProjectionBarrierEnabled: boolean;
  readonly planApprovalBlockerEnabled: boolean;
  readonly patched: (patchId: string) => boolean;
  readonly captureInitialProjectionState: boolean;
  readonly initialProjectionState: IssueWorkflowState;
  readonly initialProjection: Promise<IssueWorkflowState>;
  stateMutationLocked: boolean;
  continuationRequested: boolean;
  initialProjectionComplete: boolean;
  decisionInFlight: boolean;
  planningScope: CancellationScope | undefined;
  planningPromise: Promise<LeadPlanningResult> | undefined;
  readonly supervisedDeveloperTurns: boolean;
  readonly shouldContinueAsNew: (revision: number) => boolean;
  readonly currentState: () => IssueWorkflowState;
  readonly addRevisionCommand: (commands: IssueCommand[]) => IssueCommand[];
  readonly approvalCommands: (exactSubject: boolean, supplementalReview: boolean) => IssueCommand[];
  readonly approvalBlocker: (result: LeadPlanningResult, exactSubject: boolean, supplementalReview: boolean) => IssueBlocker | null;
  readonly withStateMutation: <T>(operation: () => T) => Promise<T>;
  readonly commandAlreadyProcessed: (commandId: string) => boolean;
  readonly markCommandProcessed: (commandId: string) => void;
  readonly applyTargetBaseBlocked: (result: Extract<ReconcileTargetBaseActivityResult, { outcome: "blocked" }>) => void;
  readonly runTargetBaseCheckpoint: (checkpoint: TargetBaseCheckpoint, verificationOnly?: boolean) => Promise<boolean>;
  readonly recoveryFields: (status: RecoveryStatus | null, reasonCode: string | null, summary: string | null, heartbeatAt: string | null) => Record<string, unknown>;
  readonly applyCompletedDeveloperResult: (rawResult: unknown, summary: string) => boolean;
  readonly projectCapacityState: (capacity: IssueWorkflowState["capacity"], pendingAction?: string) => Promise<number>;
  readonly acquireExternalTurn: <T>(spec: ExternalTurnSpec, run: (capacityRequestId?: string) => Promise<T>, executionId: (result: T) => string | undefined, durableCapacityEnabled?: boolean) => Promise<T>;
  cancelCurrentCapacity: () => Promise<CapacityCancellation>;
  preserveAmbiguousCapacity: () => Promise<void>;
  settleCancelledCapacity: (executionId: string) => Promise<"settled" | "ambiguous" | "none">;
  readonly permanentActivityFailure: (error: unknown, recoverExhausted?: boolean) => Failure | undefined;
  readonly failureBlockCategory: (code: string) => "authentication" | "configuration" | "capacity" | "execution_ownership" | undefined;
  readonly leadResultKind: (result: LeadPlanningResult) => "plan" | "decision_blocker";
  readonly applyLeadResult: (state: IssueWorkflowState, result: LeadPlanningResult) => IssueWorkflowState;
  readonly applyLegacyLeadResult: (state: IssueWorkflowState, result: LeadPlanningResult) => IssueWorkflowState;
  readonly leadPlanningPatch: string;
  readonly leadResultRoutingPatch: string;
  readonly planningProjectionIntegrityPatch: string;
  readonly distinctPlanningStatesPatch: string;
  readonly durableCapacityPatch: string;
  readonly planGovernancePatch: string;
  readonly decisionResolutionProjectionPatch: string;
  readonly exhaustedActivityRecoveryPatch: string;
  readonly developerFailureRecoveryPatch: string;
  readonly developerReconciliationRecoveryPatch: string;
  readonly developerBlockedRecoveryStatePatch: string;
  readonly cancelBlockedDeveloperResultPatch: string;
  readonly artifactBackedReviewPatch: string;
  readonly exactDeliveryReviewPatch: string;
  readonly typedReleaseResultPatch: string;
  readonly targetBaseReconciliationPatch: string;
  readonly exactAcceptanceReceiptPatch: string;
  readonly artifactBackedConflictPatch: string;
  readonly rateLimitFailure: (error: unknown) => { retryAt?: string } | undefined;
  readonly maxReconciliationAttempts: number;
  runPublishTurn: () => Promise<IssueWorkflowState>;
  reconcileCiTurn: () => Promise<IssueWorkflowState>;
  reconcileMergeTurn: () => Promise<IssueWorkflowState>;
  reconcileAcceptanceTurn: () => Promise<IssueWorkflowState>;
  resumeCapacityOperation: (operation: CapacityOperation) => Promise<IssueWorkflowState>;
  runFinalReviewTurn: () => Promise<IssueWorkflowState>;
}

type ContextOptions = Omit<IssueWorkflowContext, "input" | "state" | "repairCycleLimit">;

export function createIssueWorkflowContext(input: IssueWorkflowInput, initial: IssueWorkflowState, options: ContextOptions, stateRef?: StateRef): IssueWorkflowContext {
  let localState = initial;
  const ref = stateRef ?? { get: () => localState, set: (next: IssueWorkflowState) => { localState = next; } };
  const context = Object.create(options) as IssueWorkflowContext;
  Object.defineProperties(context, {
    input: { value: input, enumerable: true },
    repairCycleLimit: { value: input.repairCycleLimit ?? 2, enumerable: true },
    state: { enumerable: true, get: () => ref.get(), set: (next: IssueWorkflowState) => ref.set(next) },
  });
  return context;
}
