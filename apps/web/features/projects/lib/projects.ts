import { skipToken, useQuery, type UseQueryResult } from "@tanstack/react-query";
import type { ProjectResponse } from "../../../contracts/projects.js";
import { useOptionalCompanyContext } from "../../../shell/company-context.js";
import { syncedPolling, useSyncLive } from "../../../shell/sync.js";
import { listProjects } from "./project-api.js";

export const projectsKey = (userId: string | undefined, companyId: string | undefined) => ["projects", userId, companyId] as const;

/** The company's projects. The sync socket pushes them when one changes. Without the socket, they poll. */
export function useProjects(companyId: string | undefined): UseQueryResult<ProjectResponse[]> {
  const user = useOptionalCompanyContext()?.user;
  return useQuery({
    queryKey: projectsKey(user?.id, companyId),
    queryFn: companyId ? () => listProjects(companyId) : skipToken,
    ...syncedPolling(useSyncLive()),
  });
}
