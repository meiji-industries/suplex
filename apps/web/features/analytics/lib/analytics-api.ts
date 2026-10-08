import type { TaskCostsResponse } from "../../../contracts/generated/TaskCostsResponse.js";
import { TaskCostsResponseSchema } from "../../../contracts/analytics.js";
import { readJsonUnchecked } from "../../../lib/api.js";

export async function readTaskCosts(companyId: string, signal: AbortSignal): Promise<TaskCostsResponse> {
  const result = await readJsonUnchecked<TaskCostsResponse>(`/api/companies/${encodeURIComponent(companyId)}/task-costs`, { signal });
  TaskCostsResponseSchema.parse(result);
  return result;
}
