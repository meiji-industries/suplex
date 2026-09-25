import type { HumanQuestionOptions } from "../coordination/human-question.js";
import type { TaskLimitPause } from "./limits/contracts.js";
import type { AdvisorRole, WorkflowId, WorkflowInput, WorkflowState } from "../coordination/workflows.js";
import type { TaskControlStatus, TaskSessionKind, TaskSessionLifecycle, TaskTurnStatus, TaskProfile, WorktreeReference, PullRequestReference, DeliveryIntent, PromptDispatchAttempt } from "./control-contracts.js";
export * from "./control-contracts.js";

export interface TaskControl {
  taskId: string;
  objective: string;
  deliveryTarget: string;
  deliveryIntent: DeliveryIntent;
  status: TaskControlStatus;
  wakeAt: string | null;
  humanQuestion: string | null;
  humanQuestionOptions?: HumanQuestionOptions;
  humanQuestionId: string | null;
  recoveryTurnId: string | null;
  limitPause: TaskLimitPause | null;
  worktree: WorktreeReference | null;
  pullRequest: PullRequestReference | null;
  rootSessionId: string | null;
  workerSessionId: string | null;
  shellPaneId: string | null;
  rootProfile: TaskProfile;
  workerProfile: TaskProfile;
  workflow: WorkflowId;
  advisorProfiles: Partial<Record<AdvisorRole, TaskProfile>>;
  workflowState: WorkflowState;
}

export interface TaskSession {
  profile?: TaskProfile | null;
  replacement?: { sessionId: string; reason: string; handoff: string } | null;
  id: string;
  taskId: string;
  kind: TaskSessionKind;
  generation: number;
  current: boolean;
  paneId: string | null;
  nativeSessionId: string | null;
  lifecycle: TaskSessionLifecycle;
  assignmentHash: string | null;
  launchOwner: string | null;
  launchOwnerPid: number | null;
  launchOwnerStartTime: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  advisorRole: AdvisorRole | null;
  delegateSlot?: string | null;
  workflowInput: WorkflowInput | null;
}

export interface TaskTurn {
  id: string;
  taskId: string;
  sessionId: string;
  generation: number;
  assignmentHash: string | null;
  promptHash: string;
  promptText: string;
  status: TaskTurnStatus;
  promptedAt: string | null;
  completedAt: string | null;
  resultReceiptId: string | null;
  terminalObservation: string | null;
  nativeTurnId: string | null;
  dispatchAttempt: PromptDispatchAttempt | null;
  workflowInput: WorkflowInput | null;
}
