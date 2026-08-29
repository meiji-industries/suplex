import type { DeliveryTarget } from "../../../tasks.js";

export const taskDeliveryTargetOptions: Array<{ value: DeliveryTarget; label: string }> = [
  { value: "local_worktree", label: "Keep in worktree" },
  { value: "remote_branch", label: "Push branch" },
  { value: "pull_request_draft", label: "Draft pull request" },
  { value: "pull_request_ready", label: "Ready for review" },
  { value: "merged", label: "Merge to base" },
];
