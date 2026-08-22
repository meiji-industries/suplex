import type { CapacityActivities } from "../src/temporal/contracts/activities/capacity.js";

export function createImmediateCapacityActivities() {
  return { activities: {} as CapacityActivities, owns: (_requestId: string): boolean => false };
}
