import { Plus } from "lucide-react";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { NewButton } from "../../components/ui/new-button.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { reconcileScopedNotFound, type ApiProfile, type ApiProject } from "../../shell/view-shared.js";
import { CreateProjectDialog } from "./create-project-dialog.js";
import { SettingRow, SettingsContent, SettingsLayout, SettingsSection } from "../settings/settings-layout.js";

import { ProjectCards } from "./project-cards.js";
import { RecentRepositories } from "./recent-repositories.js";
import { LoadingState } from "../../components/app/loading-state.js";
import { listProjects } from "./lib/project-api.js";

export function ProjectsView(): ReactElement {
  const { currentCompany, loading, user, error: companyError, reloadCompanies } = useCompanyContext();
  const [agents, setAgents] = useState<ApiProfile[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
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
        <SettingsContent width="wide" title="Projects" description="A project connects a repository to Suplex. Suplex runs each task in a worktree of the project repository." actions={currentCompany?.status === "active" && visibleProjects.length > 0 ? <NewButton onClick={() => setCreateOpen(true)} disabled={!companyId}>New project</NewButton> : null}>
          {currentCompany && currentCompany.status !== "active" ? <p className="mb-3 text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New projects are not available." : "Company archived. New projects are not available."}</p> : null}
          {currentCompany ? (
            <div className="grid gap-3">
              {!loadError && loadedCompanyId !== companyId ? <LoadingState /> : null}
              <ProjectCards projects={visibleProjects} agents={agents} />
              {!loading && loadedCompanyId === companyId && visibleProjects.length === 0 ? <SettingsSection><SettingRow label="No projects" description="Add a repository to create your first project."><Button variant="ghost" size="sm" disabled={currentCompany.status !== "active"} onClick={() => setCreateOpen(true)}><Plus />New project</Button></SettingRow></SettingsSection> : null}
              <RecentRepositories companyId={companyId} projects={visibleProjects} canSignInToGitHub={user?.role === "admin"} onAdded={() => setCreateOpen(false)} onCreated={reload} />
            </div>
          ) : loading ? <LoadingState /> : <p className="text-xs text-muted-foreground">{companyError ? "Unable to load companies" : user?.role === "admin" ? "Add a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert></div> : null}
        </SettingsContent>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} canSignInToGitHub={user?.role === "admin"} onCreated={reload} reloadCompanies={reloadCompanies} />
    </SettingsLayout>
  );
}
