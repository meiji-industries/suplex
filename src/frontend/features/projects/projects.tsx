import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Spinner } from "../../components/ui/spinner.js";
import { NewButton } from "../../components/ui/new-button.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJson } from "../../lib/api.js";
import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { Ellipsis } from "lucide-react";
import { reconcileScopedNotFound, type ApiProfile, type ApiProject } from "../../shell/view-shared.js";
import { CreateProjectDialog } from "./create-project-dialog.js";
import { ProjectSettingsDialog } from "./project-settings-dialog.js";

const projectRoles = ["root", "worker"] as const;

function ProjectDefaultAgents({ project, agents }: { project: ApiProject; agents: ApiProfile[] }): ReactElement {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5" aria-label="Default agents">
      {projectRoles.map((role) => {
        const agent = agents.find((candidate) => candidate.id === project[`${role}ProfileId`]);
        const label = role === "root" ? "Coordinator" : "Worker";
        return (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" key={role} title={`${label}: ${agent?.name ?? "Unassigned"}`}>
            {agent ? <EntityAvatar kind="agent" id={agent.id} name={agent.name} seed={agent.avatarSeed} size="xs" /> : null}
            <span>{label}</span>
            <span className="text-foreground">{agent?.name ?? "Unassigned"}</span>
          </span>
        );
      })}
    </div>
  );
}

function ProjectIcon({ project }: { project: ApiProject }): ReactElement {
  return (
    <EntityAvatar kind="project" id={project.id} name={project.name} size="sm" />
  );
}

export function ProjectsView(): ReactElement {
  const { currentCompany, loading, user, error: companyError, reloadCompanies } = useCompanyContext();
  const [agents, setAgents] = useState<ApiProfile[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [loadedCompanyId, setLoadedCompanyId] = useState("");
  const [loadError, setLoadError] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [settingsProject, setSettingsProject] = useState<ApiProject>();
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
              {visibleProjects.map((project) => (
                <article key={project.id}>
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle><span className="flex items-center gap-2"><ProjectIcon project={project} /><span className="text-[13px]">{project.name}</span></span></CardTitle>
                      <CardAction>
                        <div className="flex items-center gap-1">
                          <Button variant="ghost" size="sm" onClick={() => setSettingsProject(project)}>Configure</Button>
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${project.name} actions`} title={`${project.name} actions`} />}><Ellipsis /></DropdownMenuTrigger>
                            <DropdownMenuContent align="end">
                              <DropdownMenuItem render={<a href={`/api/projects/${project.id}`} />}>Inspect</DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        </div>
                      </CardAction>
                    </CardHeader>
                    <CardContent>
                      <div className="grid gap-3 text-xs">
                        <div className="min-w-0">
                          <div className="truncate font-medium" title={project.repository}>{project.repository ?? "Repository unavailable"}</div>
                          <div className="truncate text-[11px] text-muted-foreground" title={project.repositoryPath}>{project.repositoryPath}</div>
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                          <span>Base <span className="font-mono text-foreground">{project.baseBranch}</span></span>
                        </div>
                        <ProjectDefaultAgents project={project} agents={agents} />
                      </div>
                    </CardContent>
                  </Card>
                </article>
              ))}
              {!loading && loadedCompanyId === companyId && visibleProjects.length === 0 ? <div className="py-8 text-center text-xs text-muted-foreground">No projects configured.</div> : null}
            </div>
          ) : loading ? <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Loading companies…</span></p> : <p className="text-xs text-muted-foreground">{companyError ? "Unable to load companies" : user?.role === "admin" ? "Add a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert></div> : null}
        </section>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} onCreated={reload} reloadCompanies={reloadCompanies} />
        <ProjectSettingsDialog project={settingsProject} agents={agents} onOpenChange={() => setSettingsProject(undefined)} onSaved={reload} />
      </div>
    </ApplicationFrame>
  );
}
