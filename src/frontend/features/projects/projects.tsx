import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Spinner } from "../../components/ui/spinner.js";
import { NewButton } from "../../components/ui/new-button.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJson } from "../../lib/api.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { reconcileScopedNotFound, type ApiProfile, type ApiProject } from "../../shell/view-shared.js";
import { CreateProjectDialog } from "./create-project-dialog.js";

import { ProjectCards } from "./project-cards.js";

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
        readJson<{ profiles: ApiProfile[] }>("/api/profiles"),
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      ]);
      if (token !== requestToken.current) return;
      loadedCompanyIdRef.current = companyId;
      setAgents(agentResult.profiles); setProjects(projectResult.projects); setLoadedCompanyId(companyId);
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
    <ApplicationFrame title="Projects" headerRight={currentCompany?.status === "active" ? <NewButton onClick={() => setCreateOpen(true)} disabled={!companyId}>New project</NewButton> : undefined}>
      <div className="bg-background text-foreground">
        <section className="p-4">
          {currentCompany && currentCompany.status !== "active" ? <p className="mb-3 text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p> : null}
          {currentCompany ? (
            <div className="grid gap-3">
              {!loadError && loadedCompanyId !== companyId ? <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading projects…</span></div> : null}
              <ProjectCards projects={visibleProjects} agents={agents} onSaved={reload} />
              {!loading && loadedCompanyId === companyId && visibleProjects.length === 0 ? <div className="py-8 text-center text-xs text-muted-foreground">No projects configured.</div> : null}
            </div>
          ) : loading ? <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading companies…</span></p> : <p className="text-xs text-muted-foreground">{companyError ? "Unable to load companies" : user?.role === "admin" ? "Add a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert></div> : null}
        </section>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} onCreated={reload} reloadCompanies={reloadCompanies} />
      </div>
    </ApplicationFrame>
  );
}
