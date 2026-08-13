import type {
  CapacityAdmissionResult, CapacityReconciliationResult, CapacityRequestInput, CapacityRequestSnapshot,
  CapacityTerminalReason,
} from "../../../capacity-contracts.js";

export interface CapacityActivities {
  cancelCapacityExecution(input: { requestId: string }): Promise<{ status: "cancelled" | "ownership_ambiguous"; executionId?: string | undefined; reason?: string | undefined }>;
  requestCapacity(input: CapacityRequestInput): Promise<CapacityRequestSnapshot>;
  tryAcquireCapacity(input: { requestId: string; expectedWorkflowRevision: number }): Promise<CapacityAdmissionResult>;
  inspectCapacity(input: { requestId: string }): Promise<CapacityRequestSnapshot>;
  requeueCapacity(input: { requestId: string; now?: string }): Promise<CapacityRequestSnapshot>;
  cancelCapacity(input: { requestId: string; reason?: string }): Promise<CapacityRequestSnapshot>;
  finalizeCapacity(input: { requestId: string; expectedExecutionId: string; terminalReason: CapacityTerminalReason }): Promise<CapacityRequestSnapshot>;
  rateLimitCapacity(input: { requestId: string; executionId: string; retryAt?: string }): Promise<CapacityRequestSnapshot>;
  reconcileCapacityOwnership(input?: { now?: string }): Promise<CapacityReconciliationResult[]>;
}
