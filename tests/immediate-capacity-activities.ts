import type { CapacityActivities } from "../src/engine/contracts/activities/capacity.js";

export function createImmediateCapacityActivities() {
  return { activities: {} as CapacityActivities, owns: (_requestId: string): boolean => false };
}
