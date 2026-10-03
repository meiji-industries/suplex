import { ProjectsContent } from "./projects-content.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { reconcileScopedNotFound, type ApiProfile, type ApiProject } from "../../shell/view-shared.js";
import { SettingsLayout } from "../settings/settings-layout.js";

import { listProjects } from "./lib/project-api.js";

export function ProjectsView(): ReactElement {
  const { currentCompany, loading, user, error: companyError, reloadCompanies } = useCompanyContext();
  const [agents, setAgents] = useState<ApiProfile[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [loadError, setLoadError] = useState("");
  const requestToken = useRef(0);
  const loadedCompanyIdRef = useRef("");
  const companyId = currentCompany?.id ?? "";

  const reload = useCallback(async (): Promise<void> => {
    const token = ++requestToken.current;
    setLoadError("");
    if (companyId !== loadedCompanyIdRef.current) {
      loadedCompanyIdRef.current = "";
      setLoadedCompanyId("");
      setProjects([]);
      setAgents([]);
    }
    if (!companyId || loading) return;
    try {
      const [agentResult, projectResult] = await Promise.all([
        readJsonUnchecked<{ profiles: ApiProfile[] }>("/api/profiles"),
        listProjects(companyId),
      ]);
      if (token !== requestToken.current) return;
      loadedCompanyIdRef.current = companyId;
      setAgents(agentResult.profiles); setProjects(projectResult); setLoadedCompanyId(companyId);
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      else setLoadError("Unable to load projects");
    }
  }, [companyId, loading, reloadCompanies]);
  useEffect(() => { void reload(); }, [reload]);

  const visibleProjects = loadedCompanyId === companyId ? projects : [];


  return (
    <SettingsLayout title="Projects" companyId={companyId} backHref={withCompany("/tasks", companyId)} activeHref={withCompany("/projects", companyId)}>
      <ProjectsContent currentCompany={currentCompany} projects={visibleProjects} agents={agents} loading={loading} projectsLoading={loadedCompanyId !== companyId} loadError={loadError} companyError={companyError} canSignInToGitHub={user?.role === "admin"} reload={reload} reloadCompanies={reloadCompanies} />
    </SettingsLayout>
  );
}
