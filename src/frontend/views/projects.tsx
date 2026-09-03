import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Avatar, AvatarFallback, AvatarImage } from ".././components/ui/avatar.js";
import { Button } from ".././components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from ".././components/ui/card.js";
import { Checkbox } from ".././components/ui/checkbox.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from ".././components/ui/dropdown-menu.js";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from ".././components/ui/field.js";
import { Input } from ".././components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from ".././components/ui/select.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { CreateButton } from ".././components/ui/create-button.js";
import { Badge as ReuiBadge } from ".././components/reui/badge.js";
import { ApplicationFrame } from ".././components/app/application-frame.js";
import { ProfileAvatar } from ".././components/app/profile-avatar.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { readJson, withCompany, type CompanyStatus } from ".././lib/api.js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { Ellipsis } from "lucide-react";
import { reconcileScopedNotFound, type ApiAgent, type ApiCheck, type ApiProject } from "../lib/view-shared.js";

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
      <DialogContent className="w-[min(92vw,460px)]" showCloseButton>
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
              <DialogFooter className="mt-1"><DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || !companyId || !repositoryUrl.trim()}>{busy ? "Cloning…" : "Create project"}</Button></DialogFooter>
            </form>
          )}
          {error ? <div className="mt-3 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-rose-700">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}

type ProjectSettingsForm = {
  name: string;
  baseBranch: string;
  targetBranch: string;
  setupCommand: string;
  verificationCommand: string;
  requiredChecks: string;
  plannerAgent: string;
  builderAgent: string;
  reviewerAgent: string;
  integratorAgent: string;
};

type ActivationRequirement = { key: string; label: string; complete: boolean };

function activationRequirements(input: { requiredChecks: string[]; builderAgent: string | undefined }): ActivationRequirement[] {
  return [
    { key: "checks", label: "Add at least one required GitHub check", complete: input.requiredChecks.length > 0 },
    { key: "builder", label: "Choose a Builder default", complete: Boolean(input.builderAgent) },
  ];
}

function settingsForm(project: ApiProject): ProjectSettingsForm {
  return {
    name: project.name,
    baseBranch: project.baseBranch,
    targetBranch: project.targetBranch,
    setupCommand: project.setupCommand,
    verificationCommand: project.verificationCommand,
    requiredChecks: project.requiredChecks.join(", "),
    plannerAgent: project.roleDefaults.planner ?? "",
    builderAgent: project.roleDefaults.builder ?? "",
    reviewerAgent: project.roleDefaults.reviewer ?? "",
    integratorAgent: project.roleDefaults.integrator ?? "",
  };
}

const projectRoles = ["planner", "builder", "reviewer", "integrator"] as const;

function ProjectDefaultAgents({ project, agents }: { project: ApiProject; agents: ApiAgent[] }): ReactElement {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1.5" aria-label="Default agents">
      {projectRoles.map((role) => {
        const agent = agents.find((candidate) => candidate.id === project.roleDefaults[role]);
        const label = role.slice(0, 1).toUpperCase() + role.slice(1);
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
  agents: ApiAgent[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}): ReactElement {
  const [form, setForm] = useState<ProjectSettingsForm | undefined>();
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [manualCheck, setManualCheck] = useState("");
  const [checkOptions, setCheckOptions] = useState<ApiCheck[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setForm(project ? settingsForm(project) : undefined);
    setFindings([]);
    setError("");
    setBusy(false);
    setManualCheck("");
    setCheckOptions([]);
    if (project) {
      setChecksLoading(true);
      void readJson<{ checks: ApiCheck[] }>(`/api/projects/${project.id}/checks`)
        .then((result) => {
          if (cancelled) return;
          setCheckOptions(result.checks);
          setForm((current) => current && current.requiredChecks.trim().length === 0
            ? { ...current, requiredChecks: result.checks.map((check) => check.name).join(", ") }
            : current);
        })
        .catch(() => { if (!cancelled) setCheckOptions([]); })
        .finally(() => { if (!cancelled) setChecksLoading(false); });
      if (project.setupCommand === "pnpm install" && project.verificationCommand === "pnpm test") {
        void readJson<{ setupCommand: string; verificationCommand: string }>(`/api/projects/${project.id}/repository-defaults`)
          .then((defaults) => {
            if (!cancelled) setForm((current) => current ? { ...current, ...defaults } : current);
          })
          .catch(() => undefined);
      }
    }
    return () => { cancelled = true; };
  }, [project, agents]);

  const setField = <Key extends keyof ProjectSettingsForm>(key: Key, value: ProjectSettingsForm[Key]): void => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

  const toggleCheck = (checkName: string): void => {
    if (!form) return;
    const checks = form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean);
    setField("requiredChecks", (checks.includes(checkName) ? checks.filter((name) => name !== checkName) : [...checks, checkName]).join(", "));
  };

  const addManualCheck = (): void => {
    if (!form || !manualCheck.trim()) return;
    const checks = form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean);
    setField("requiredChecks", [...new Set([...checks, manualCheck.trim()])].join(", "));
    setManualCheck("");
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
          targetBranch: form.targetBranch,
          setupCommand: form.setupCommand,
          verificationCommand: form.verificationCommand,
          requiredChecks: form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean),
          roleDefaults: { planner: form.plannerAgent, builder: form.builderAgent, reviewer: form.reviewerAgent, integrator: form.integratorAgent },
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

  const requirements = form ? activationRequirements({
    requiredChecks: form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean),
    builderAgent: form.builderAgent,
  }) : [];
  const missingRequirements = requirements.filter((requirement) => !requirement.complete);
  const selectedChecks = form?.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const availableChecks: ApiCheck[] = [...new Map([...checkOptions, ...selectedChecks.map((name) => ({ name, status: "configured" } satisfies ApiCheck))].map((check) => [check.name, check])).values()];
  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => { if (!open) onOpenChange(false); }}>
      <DialogContent className="max-h-[85vh] w-[min(92vw,936px)] max-w-none overflow-y-auto sm:max-w-[936px]" showCloseButton>
        <DialogHeader><DialogTitle>Project settings</DialogTitle><DialogDescription>{project?.repository}</DialogDescription></DialogHeader>
          {project && form ? <form onSubmit={(event) => void submit(event)}>
            <FieldGroup>
              <div className={`grid gap-2 px-3 py-2 ${missingRequirements.length ? "bg-amber-50/70" : "bg-emerald-50/70"}`}>
                <div className="flex items-center justify-between gap-2"><span className="text-xs font-medium">Activation requirements</span><span className={missingRequirements.length ? "text-[11px] font-medium text-amber-800" : "text-[11px] font-medium text-emerald-700"}>{missingRequirements.length ? `${missingRequirements.length} missing` : "Ready"}</span></div>
                <ul className="grid gap-x-4 gap-y-1 sm:grid-cols-2">{requirements.map((requirement) => <li className={`flex items-center gap-1.5 text-[11px] ${requirement.complete ? "text-muted-foreground" : "font-medium text-amber-800"}`} key={requirement.key}><span className={`size-1.5 rounded-full ${requirement.complete ? "bg-emerald-500" : "bg-amber-500"}`} />{requirement.label}</li>)}</ul>
              </div>
              <Field><FieldLabel htmlFor="project-name">Project name</FieldLabel><Input id="project-name" autoFocus value={form.name} onChange={(event) => setField("name", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-base-branch">Base branch</FieldLabel><Input id="project-base-branch" value={form.baseBranch} onChange={(event) => setField("baseBranch", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-target-branch">Target branch</FieldLabel><Input id="project-target-branch" value={form.targetBranch} onChange={(event) => setField("targetBranch", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-setup-command">Setup command</FieldLabel><Input id="project-setup-command" value={form.setupCommand} onChange={(event) => setField("setupCommand", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-verification-command">Verification command</FieldLabel><Input id="project-verification-command" value={form.verificationCommand} onChange={(event) => setField("verificationCommand", event.target.value)} /></Field>
              <FieldSet>
                <FieldLegend variant="label">Required GitHub checks</FieldLegend>
                {checksLoading ? <FieldDescription>Loading checks from {project.targetBranch}…</FieldDescription> : availableChecks.length ? <FieldGroup data-slot="checkbox-group">{availableChecks.map((check, index) => <Field orientation="horizontal" key={check.name}><Checkbox id={`project-check-${index}`} checked={selectedChecks.includes(check.name)} onCheckedChange={() => toggleCheck(check.name)} /><FieldLabel htmlFor={`project-check-${index}`}>{check.name}{check.conclusion ? ` · ${check.conclusion}` : ""}</FieldLabel></Field>)}</FieldGroup> : <FieldDescription>No check runs were found on {project.targetBranch}. Run the repository workflows once, then reopen settings.</FieldDescription>}
                <div className="flex gap-2"><Input aria-label="Add required check" placeholder="Exact check name" value={manualCheck} onChange={(event) => setManualCheck(event.target.value)} /><Button type="button" size="sm" variant="outline" disabled={!manualCheck.trim()} onClick={addManualCheck}>Add</Button></div>
                <FieldDescription>The exact check names from GitHub for the target branch.</FieldDescription>
              </FieldSet>
              <FieldSet>
                <FieldLegend variant="label">Default agents</FieldLegend>
                {(["plannerAgent", "reviewerAgent", "builderAgent", "integratorAgent"] as const).map((key) => {
                  const role = key === "plannerAgent" ? "planner" : key === "builderAgent" ? "builder" : key === "integratorAgent" ? "integrator" : "reviewer";
                  const options = agents.filter((agent) => agent.role === role);
                  const selected = options.find((agent) => agent.id === form[key]);
                  return <Field key={key}><FieldLabel htmlFor={`project-${key}`}>{role.slice(0, 1).toUpperCase() + role.slice(1)} default</FieldLabel><Select value={form[key] || null} onValueChange={(value) => setField(key, value ?? "")}><SelectTrigger id={`project-${key}`}><SelectValue placeholder="None">{selected ? <span className="flex items-center gap-2"><ProfileAvatar name={selected.name} seed={selected.avatarSeed} />{selected.name}</span> : "None"}</SelectValue></SelectTrigger><SelectContent><SelectItem value={null}>None</SelectItem>{options.map((agent) => <SelectItem key={agent.id} value={agent.id}><span className="flex items-center gap-2"><ProfileAvatar name={agent.name} seed={agent.avatarSeed} />{agent.name}</span></SelectItem>)}</SelectContent></Select></Field>;
                })}
                {agents.length === 0 ? <FieldDescription>No agents configured. <a href={withCompany("/admin/agents", project.companyId)}>Create an agent</a> before activating this project.</FieldDescription> : null}
              </FieldSet>
              <DialogFooter>{missingRequirements.length ? <span className="mr-auto text-[11px] text-amber-800">Complete the missing requirements to save.</span> : null}<a href={withCompany(`/projects/${encodeURIComponent(project.id)}/prompts`, project.companyId)}>Prompts</a><a href={withCompany(`/projects/${encodeURIComponent(project.id)}/templates`, project.companyId)}>Templates</a><DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || missingRequirements.length > 0}>{busy ? "Saving…" : "Save settings"}</Button></DialogFooter>
            </FieldGroup>
          </form> : null}
          {error ? <div className="mt-3 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-rose-700">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}

export function ProjectsView(): ReactElement {
  const { currentCompany, loading, user, error: companyError, reloadCompanies } = useCompanyContext();
  const [agents, setAgents] = useState<ApiAgent[]>([]);
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
        readJson<{ agents: ApiAgent[] }>("/api/agents"),
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      ]);
      if (token !== requestToken.current) return;
      loadedCompanyIdRef.current = companyId;
      setAgents(agentResult.agents); setProjects(projectResult.projects); setLoadedCompanyId(companyId);
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
    <ApplicationFrame title="Projects" headerRight={currentCompany?.status === "active" ? <CreateButton onClick={() => setCreateOpen(true)} disabled={!companyId}>New Project</CreateButton> : undefined}>
      <div className="bg-background text-foreground">
        <section className="p-4">
          {currentCompany && currentCompany.status !== "active" ? <p className="mb-3 text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p> : null}
          {currentCompany ? (
            <div className="grid gap-3">
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
                          <span aria-hidden="true">→</span>
                          <span>Target <span className="font-mono text-foreground">{project.targetBranch}</span></span>
                          <ReuiBadge variant="secondary" size="sm">{project.requiredChecks.length} {project.requiredChecks.length === 1 ? "check" : "checks"}</ReuiBadge>
                        </div>
                        <ProjectDefaultAgents project={project} agents={agents} />
                      </div>
                    </CardContent>
                  </Card>
                </article>
              ))}
              {!loading && loadedCompanyId === companyId && visibleProjects.length === 0 ? <div className="py-8 text-center text-xs text-muted-foreground">No projects configured.</div> : null}
            </div>
          ) : <p className="text-xs text-muted-foreground">{loading ? "Loading companies" : companyError ? "Unable to load companies" : user?.role === "admin" ? "Create a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <div className="mt-3 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert></div> : null}
        </section>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} onCreated={reload} reloadCompanies={reloadCompanies} />
        <ProjectSettingsDialog project={settingsProject} agents={agents} onOpenChange={() => setSettingsProject(undefined)} onSaved={reload} />
      </div>
    </ApplicationFrame>
  );
}
