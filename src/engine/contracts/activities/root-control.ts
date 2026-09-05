import type { RootIdentity } from "../../../root-contracts.js";

export interface RootControlActivities {
  recoverRootTask(taskId: string): Promise<void>;
  wakeRootTask(root: RootIdentity, prompt: string): Promise<void>;
}
