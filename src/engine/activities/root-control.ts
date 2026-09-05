import type { RootController } from "../../root-controller.js";
import type { RootIdentity } from "../../root-contracts.js";

export interface RootControlActivities {
  recoverRootTask(taskId: string): Promise<void>;
  wakeRootTask(root: RootIdentity, prompt: string): Promise<void>;
}

export function createRootControlActivities(controller: RootController): RootControlActivities {
  return { recoverRootTask: (taskId) => controller.recover(taskId), wakeRootTask: (root, prompt) => controller.wakeRoot(root, prompt) };
}
