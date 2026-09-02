export interface AcceptDeliveryActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  actorUserId: string;
  expectedHeadSha: string;
  note?: string;
  autoMerge?: boolean;
}

export interface AcceptDeliveryActivityResult {
  acceptanceId: string | null;
  status: "pending_ready" | "accepted" | "requested_changes" | "cancelled" | "blocked";
  outcome?: "pending_ready" | "ready" | "changed" | "closed" | "merged_early" | "provider_unavailable";
  retryAt?: string | null;
  readyAt?: string | null;
  acceptedAt?: string | null;
  blockerCode?: string;
  blockerSummary?: string;
  evidenceArtifactId?: string | null;
  pullRequestNumber: number;
  pullRequestUrl: string;
  reasonArtifactId?: string | null;
}

export interface ReconcileAcceptanceActivityInput {
  taskId: string;
  companyId: string;
  workflowId: string;
  acceptanceId: string;
}

export interface ReconcileAcceptanceActivityResult {
  acceptanceId: string;
  status: "pending_ready" | "accepted" | "blocked";
  outcome: "pending_ready" | "ready" | "changed" | "closed" | "merged_early" | "provider_unavailable";
  retryAt: string | null;
  readyAt: string | null;
  acceptedAt: string;
  blockerCode?: string;
  blockerSummary?: string;
  evidenceArtifactId?: string | null;
  pullRequestNumber: number;
  pullRequestUrl: string;
}

export interface AcceptanceActivities {
  acceptDelivery(input: AcceptDeliveryActivityInput & { decision?: "accept" | "request_changes" | "cancel" }): Promise<AcceptDeliveryActivityResult>;
  reconcileAcceptance(input: ReconcileAcceptanceActivityInput): Promise<ReconcileAcceptanceActivityResult>;
}
