import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Avatar, AvatarFallback, AvatarImage } from ".././components/ui/avatar.js";
import { Button } from ".././components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from ".././components/ui/card.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from ".././components/ui/dropdown-menu.js";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from ".././components/ui/field.js";
import { Input } from ".././components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from ".././components/ui/select.js";
import { Spinner } from ".././components/ui/spinner.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { NewButton } from ".././components/ui/new-button.js";
import { ApplicationFrame } from ".././components/app/application-frame.js";
import { ProfileAvatar } from ".././components/app/profile-avatar.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { readJson, withCompany, type CompanyStatus } from ".././lib/api.js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { Ellipsis } from "lucide-react";
import { reconcileScopedNotFound, type ApiProfile, type ApiProject } from "../lib/view-shared.js";

function CreateProjectDialog({
  open,
  onOpenChange,
  companyId,
  companyStatus,
  onCreated,
  reloadCompanies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyStatus: CompanyStatus | undefined;
  onCreated: () => Promise<void>;
  reloadCompanies: () => Promise<void>;
}): ReactElement {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setRepositoryUrl("");
      setFindings([]);
      setError("");
      setBusy(false);
    }
  }, [open]);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!companyId || companyStatus !== "active" || !repositoryUrl.trim()) return;
    setBusy(true);
    setError("");
    setFindings([]);
    try {
      await readJson<ApiProject>(`/api/companies/${companyId}/projects`, {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: repositoryUrl.trim() }),
      });
      await onCreated();
      onOpenChange(false);
    } catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      setError(reason instanceof Error ? reason.message : "Project configuration failed");
      if (reason instanceof Error && "findings" in reason) setFindings((reason as Error & { findings?: Array<{ field: string; message: string }> }).findings ?? []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton>
        <DialogHeader><DialogTitle>New project</DialogTitle></DialogHeader>
          {companyStatus !== "active" ? (
            <p className="text-xs text-muted-foreground">{companyStatus === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p>
          ) : (
            <form className="grid gap-3" onSubmit={(event: FormEvent) => void submit(event)}>
              <Field>
                <FieldLabel htmlFor="project-repository-url">GitHub repository URL</FieldLabel>
                <Input id="project-repository-url" name="repositoryUrl" autoFocus autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repository" aria-describedby="project-repository-hint" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} />
                <FieldDescription id="project-repository-hint">HTTPS and SSH URLs are supported. Forge clones into <span className="font-mono">~/forge/repos</span> and creates worktrees in <span className="font-mono">~/forge/worktrees</span>.</FieldDescription>
              </Field>
              <DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><NewButton type="submit" disabled={busy || !companyId || !repositoryUrl.trim()}>{busy ? "Forge copies the repository" : "New project"}</NewButton></DialogFooter>
            </form>
          )}
          {error ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-destructive">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}

type ProjectSettingsForm = {
  name: string;
  baseBranch: string;
  setupCommand: string;
  verificationCommand: string;
  rootProfileId: string;
  workerProfileId: string;
};

function settingsForm(project: ApiProject): ProjectSettingsForm {
  return {
    name: project.name,
    baseBranch: project.baseBranch,
    setupCommand: project.setupCommand,
    verificationCommand: project.verificationCommand,
    rootProfileId: project.rootProfileId,
    workerProfileId: project.workerProfileId,
  };
}

const projectRoles = ["root", "worker"] as const;

function ProjectDefaultAgents({ project, agents }: { project: ApiProject; agents: ApiProfile[] }): ReactElement {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5" aria-label="Default agents">
      {projectRoles.map((role) => {
        const agent = agents.find((candidate) => candidate.id === project[`${role}ProfileId`]);
        const label = role === "root" ? "Coordinator" : "Worker";
        return (
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" key={role} title={`${label}: ${agent?.name ?? "Unassigned"}`}>
            {agent ? <ProfileAvatar name={agent.name} seed={agent.avatarSeed} size="xs" /> : null}
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
    <Avatar size="sm" shape="square">
      <AvatarImage src={`/api/projects/${project.id}/favicon`} alt="" />
      <AvatarFallback aria-label={`${project.name} icon`}>{project.name.slice(0, 1).toUpperCase()}</AvatarFallback>
    </Avatar>
  );
}

function ProjectSettingsDialog({
  project,
  agents,
  onOpenChange,
  onSaved,
}: {
  project: ApiProject | undefined;
  agents: ApiProfile[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}): ReactElement {
  const [form, setForm] = useState<ProjectSettingsForm | undefined>();
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setForm(project ? settingsForm(project) : undefined);
    setFindings([]);
    setError("");
    setBusy(false);
  }, [project]);

  const setField = <Key extends keyof ProjectSettingsForm>(key: Key, value: ProjectSettingsForm[Key]): void => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!project || !form) return;
    setBusy(true);
    setError("");
    setFindings([]);
    try {
      await readJson<ApiProject>(`/api/projects/${project.id}`, {
        method: "PATCH",
        body: JSON.stringify({
          name: form.name,
          repositoryPath: project.repositoryPath,
          worktreeRoot: project.worktreeRoot,
          repository: project.repository ?? "",
          baseBranch: form.baseBranch,
          setupCommand: form.setupCommand,
          verificationCommand: form.verificationCommand,
          rootProfileId: form.rootProfileId,
          workerProfileId: form.workerProfileId,
        }),
      });
      await onSaved();
      onOpenChange(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Project configuration failed");
      if (reason instanceof Error && "findings" in reason) setFindings((reason as Error & { findings?: Array<{ field: string; message: string }> }).findings ?? []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => { if (!open) onOpenChange(false); }}>
      <DialogContent showCloseButton>
        <DialogHeader><DialogTitle>Project settings</DialogTitle><DialogDescription>{project?.repository}</DialogDescription></DialogHeader>
          {project && form ? <form className="max-h-[70dvh] overflow-y-auto" onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <Field><FieldLabel htmlFor="project-name">Project name</FieldLabel><Input id="project-name" autoFocus value={form.name} onChange={(event) => setField("name", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-base-branch">Base branch</FieldLabel><Input id="project-base-branch" value={form.baseBranch} onChange={(event) => setField("baseBranch", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-setup-command">Setup command</FieldLabel><Input id="project-setup-command" value={form.setupCommand} onChange={(event) => setField("setupCommand", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-verification-command">Verification command</FieldLabel><Input id="project-verification-command" value={form.verificationCommand} onChange={(event) => setField("verificationCommand", event.target.value)} /></Field>
              <FieldSet>
                <FieldLegend variant="label">Default agents</FieldLegend>
                {(["rootProfileId", "workerProfileId"] as const).map((key) => {
                  const role = key === "rootProfileId" ? "root" : "worker";
                  const options = agents.filter((agent) => agent.role === role);
                  const selected = options.find((agent) => agent.id === form[key]);
                  return <Field key={key}><FieldLabel htmlFor={`project-${key}`}>{role === "root" ? "Coordinator" : "Worker"} default</FieldLabel><Select value={form[key] || null} onValueChange={(value) => setField(key, value ?? "")}><SelectTrigger id={`project-${key}`}><SelectValue placeholder="None">{selected ? <span className="flex items-center gap-2"><ProfileAvatar name={selected.name} seed={selected.avatarSeed} />{selected.name}</span> : "None"}</SelectValue></SelectTrigger><SelectContent>{options.map((agent) => <SelectItem key={agent.id} value={agent.id}><span className="flex items-center gap-2"><ProfileAvatar name={agent.name} seed={agent.avatarSeed} />{agent.name}</span></SelectItem>)}</SelectContent></Select></Field>;
                })}
                {agents.length === 0 ? <FieldDescription>No agents configured. <a href={withCompany("/admin/agents", project.companyId)}>Add an agent</a> before saving this project.</FieldDescription> : null}
              </FieldSet>
              <DialogFooter><a href={withCompany(`/projects/${encodeURIComponent(project.id)}/templates`, project.companyId)}>Templates</a><DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || !form.rootProfileId || !form.workerProfileId}>{busy ? "Forge saves" : "Save settings"}</Button></DialogFooter>
            </FieldGroup>
          </form> : null}
          {error ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-destructive">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
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
              {!loadError && loadedCompanyId !== companyId ? <div className="flex items-center gap-2 py-8 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Forge loads projects.</span></div> : null}
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
          ) : loading ? <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-busy="true"><Spinner /><span>Forge loads companies.</span></p> : <p className="text-xs text-muted-foreground">{companyError ? "Unable to load companies" : user?.role === "admin" ? "Add a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert></div> : null}
        </section>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} onCreated={reload} reloadCompanies={reloadCompanies} />
        <ProjectSettingsDialog project={settingsProject} agents={agents} onOpenChange={() => setSettingsProject(undefined)} onSaved={reload} />
      </div>
    </ApplicationFrame>
  );
}
