import type { ReconcileTargetBaseActivityInput, ReconcileTargetBaseActivityResult } from "../primitives.js";

export interface TargetBaseActivities {
  reconcileTargetBase(input: ReconcileTargetBaseActivityInput): Promise<ReconcileTargetBaseActivityResult>;
}
