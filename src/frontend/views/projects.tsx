import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Badge } from ".././components/ui/badge.js";
import { Checkbox } from ".././components/ui/checkbox.js";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from ".././components/ui/field.js";
import { Input } from ".././components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from ".././components/ui/select.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { CreateButton } from ".././components/ui/create-button.js";
import { ApplicationFrame } from ".././components/app/application-frame.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { readJson, withCompany, type CompanyStatus } from ".././lib/api.js";
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactElement } from "react";
import { reconcileScopedNotFound, type ApiCheck, type ApiProfile, type ApiProject } from "../lib/view-shared.js";

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
  allowedProfileIds: string[];
  leadProfile: string;
  developerProfile: string;
  reviewerProfile: string;
};

type ActivationRequirement = { key: string; label: string; complete: boolean };

function activationRequirements(input: { requiredChecks: string[]; allowedProfileIds: string[]; leadProfile: string | undefined; developerProfile: string | undefined }): ActivationRequirement[] {
  return [
    { key: "checks", label: "Add at least one required GitHub check", complete: input.requiredChecks.length > 0 },
    { key: "profiles", label: "Allow at least one Codex profile", complete: input.allowedProfileIds.length > 0 },
    { key: "lead", label: "Choose a Lead default", complete: Boolean(input.leadProfile) },
    { key: "developer", label: "Choose a Developer default", complete: Boolean(input.developerProfile) },
  ];
}

function settingsForm(project: ApiProject, profiles: ApiProfile[]): ProjectSettingsForm {
  return {
    name: project.name,
    baseBranch: project.baseBranch,
    targetBranch: project.targetBranch,
    setupCommand: project.setupCommand,
    verificationCommand: project.verificationCommand,
    requiredChecks: project.requiredChecks.join(", "),
    allowedProfileIds: project.allowedProfileIds.length ? project.allowedProfileIds : profiles.map((profile) => profile.id),
    leadProfile: project.roleDefaults.lead ?? "",
    developerProfile: project.roleDefaults.developer ?? "",
    reviewerProfile: project.roleDefaults.reviewer ?? "",
  };
}

function ProjectSettingsDialog({
  project,
  profiles,
  onOpenChange,
  onSaved,
}: {
  project: ApiProject | undefined;
  profiles: ApiProfile[];
  onOpenChange: (open: boolean) => void;
  onSaved: () => Promise<void>;
}): ReactElement {
  const [form, setForm] = useState<ProjectSettingsForm | undefined>();
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [checkOptions, setCheckOptions] = useState<ApiCheck[]>([]);
  const [checksLoading, setChecksLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setForm(project ? settingsForm(project, profiles) : undefined);
    setFindings([]);
    setError("");
    setBusy(false);
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
      if (project.status === "draft" && project.setupCommand === "pnpm install" && project.verificationCommand === "pnpm test") {
        void readJson<{ setupCommand: string; verificationCommand: string }>(`/api/projects/${project.id}/repository-defaults`)
          .then((defaults) => {
            if (!cancelled) setForm((current) => current ? { ...current, ...defaults } : current);
          })
          .catch(() => undefined);
      }
    }
    return () => { cancelled = true; };
  }, [project, profiles]);

  const setField = <Key extends keyof ProjectSettingsForm>(key: Key, value: ProjectSettingsForm[Key]): void => {
    setForm((current) => current ? { ...current, [key]: value } : current);
  };

  const toggleProfile = (profileId: string): void => {
    if (!form) return;
    const enabled = form.allowedProfileIds.includes(profileId);
    const allowedProfileIds = enabled ? form.allowedProfileIds.filter((id) => id !== profileId) : [...form.allowedProfileIds, profileId];
    setForm({
      ...form,
      allowedProfileIds,
      leadProfile: enabled && form.leadProfile === profileId ? "" : form.leadProfile,
      developerProfile: enabled && form.developerProfile === profileId ? "" : form.developerProfile,
      reviewerProfile: enabled && form.reviewerProfile === profileId ? "" : form.reviewerProfile,
    });
  };

  const toggleCheck = (checkName: string): void => {
    if (!form) return;
    const checks = form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean);
    setField("requiredChecks", (checks.includes(checkName) ? checks.filter((name) => name !== checkName) : [...checks, checkName]).join(", "));
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
          allowedProfileIds: form.allowedProfileIds,
          roleDefaults: { lead: form.leadProfile, developer: form.developerProfile, reviewer: form.reviewerProfile },
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

  const allowedProfiles = profiles.filter((profile) => form?.allowedProfileIds.includes(profile.id));
  const requirements = form ? activationRequirements({
    requiredChecks: form.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean),
    allowedProfileIds: form.allowedProfileIds,
    leadProfile: form.leadProfile,
    developerProfile: form.developerProfile,
  }) : [];
  const missingRequirements = requirements.filter((requirement) => !requirement.complete);
  const selectedChecks = form?.requiredChecks.split(",").map((value) => value.trim()).filter(Boolean) ?? [];
  const availableChecks: ApiCheck[] = [...new Map([...checkOptions, ...selectedChecks.map((name) => ({ name, status: "configured" } satisfies ApiCheck))].map((check) => [check.name, check])).values()];
  return (
    <Dialog open={Boolean(project)} onOpenChange={(open) => { if (!open) onOpenChange(false); }}>
      <DialogContent className="max-h-[85vh] w-[min(92vw,640px)] overflow-y-auto" showCloseButton>
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
                <FieldDescription>Exact check names fetched from GitHub for the target branch.</FieldDescription>
              </FieldSet>
              <FieldSet>
                <FieldLegend variant="label">Profiles</FieldLegend>
                {profiles.length ? <FieldGroup data-slot="checkbox-group">{profiles.map((profile) => <Field orientation="horizontal" key={profile.id}><Checkbox id={`project-profile-${profile.id}`} checked={form.allowedProfileIds.includes(profile.id)} onCheckedChange={() => toggleProfile(profile.id)} /><FieldLabel htmlFor={`project-profile-${profile.id}`}>{profile.name}</FieldLabel></Field>)}</FieldGroup> : <FieldDescription>No Codex profiles configured. <a href={withCompany("/admin/profiles", project.companyId)}>Create a profile</a> before activating this project.</FieldDescription>}
              </FieldSet>
              {(["leadProfile", "developerProfile", "reviewerProfile"] as const).map((key) => <Field key={key}><FieldLabel htmlFor={`project-${key}`}>{key === "leadProfile" ? "Lead default" : key === "developerProfile" ? "Developer default" : "Reviewer default (optional)"}</FieldLabel><Select value={form[key] || null} onValueChange={(value) => setField(key, value ?? "")}><SelectTrigger id={`project-${key}`}><SelectValue placeholder="None">{(value) => allowedProfiles.find((profile) => profile.id === value)?.name ?? (value ? "Unavailable profile" : "None")}</SelectValue></SelectTrigger><SelectContent><SelectItem value={null}>None</SelectItem>{allowedProfiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent></Select></Field>)}
              <DialogFooter>{missingRequirements.length ? <span className="mr-auto text-[11px] text-amber-800">Complete the missing requirements to save.</span> : null}<DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || missingRequirements.length > 0}>{busy ? "Saving…" : "Save settings"}</Button></DialogFooter>
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
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
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
      setProfiles([]);
    }
    if (!companyId || loading) return;
    try {
      const [profileResult, projectResult] = await Promise.all([
        readJson<{ profiles: ApiProfile[] }>("/api/profiles"),
        readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      ]);
      if (token !== requestToken.current) return;
      loadedCompanyIdRef.current = companyId;
      setProfiles(profileResult.profiles); setProjects(projectResult.projects); setLoadedCompanyId(companyId);
    } catch (reason) {
      if (token !== requestToken.current) return;
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      else setLoadError("Unable to load projects");
    }
  }, [companyId, loading, reloadCompanies]);
  useEffect(() => { void reload(); }, [reload]);

  const visibleProjects = loadedCompanyId === companyId ? projects : [];

  const changeStatus = async (projectId: string, status: "activate" | "reactivate" | "pause" | "archive"): Promise<void> => {
    setLoadError("");
    try { await readJson(`/api/projects/${projectId}/${status}`, { method: "POST", body: "{}" }); await reload(); }
    catch (reason) { if (await reconcileScopedNotFound(reason, reloadCompanies)) return; setLoadError(reason instanceof Error ? reason.message : "Project update failed"); }
  };

  return (
    <ApplicationFrame title="Projects" headerRight={currentCompany?.status === "active" ? <CreateButton onClick={() => setCreateOpen(true)} disabled={!companyId}>Create</CreateButton> : undefined}>
      <div className="bg-background text-foreground">
        <section className="p-4">
          {currentCompany && currentCompany.status !== "active" ? <p className="mb-3 text-xs text-muted-foreground">{currentCompany.status === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p> : null}
          {currentCompany ? (
            <div>
              {visibleProjects.map((project) => { const requirements = activationRequirements({ requiredChecks: project.requiredChecks, allowedProfileIds: project.allowedProfileIds, leadProfile: project.roleDefaults.lead, developerProfile: project.roleDefaults.developer }); const missingRequirements = requirements.filter((requirement) => !requirement.complete); const ready = missingRequirements.length === 0; return <article className="py-3" key={project.id}><div className="flex flex-wrap items-center justify-between gap-2"><div className="flex items-center gap-2"><span className="text-[13px] font-medium">{project.name}</span>{project.status === "draft" ? <Badge variant="secondary" data-status="draft"><span className="size-1.5 rounded-full bg-amber-500" />Draft</Badge> : <Badge variant="secondary" data-status={project.status}>{project.status}</Badge>}<span className="text-[11px] text-muted-foreground">revision {project.configurationRevision}</span></div><div className="flex flex-wrap gap-1.5">{project.status === "draft" && ready ? <Button size="sm" onClick={() => void changeStatus(project.id, "activate")}>Activate</Button> : null}{project.status === "needs-reactivation" || project.status === "paused" ? <Button size="sm" onClick={() => void changeStatus(project.id, "reactivate")}>Reactivate</Button> : null}{project.status === "active" || project.status === "needs-reactivation" ? <Button variant="ghost" size="sm" onClick={() => void changeStatus(project.id, "pause")}>Pause</Button> : null}{project.status !== "archived" ? <Button variant={project.status === "draft" && !ready ? "default" : "ghost"} size="sm" onClick={() => setSettingsProject(project)}>Configure</Button> : null}{project.status !== "archived" ? <Button variant="ghost" size="sm" onClick={() => void changeStatus(project.id, "archive")}>Archive</Button> : null}<a className="flex h-7 items-center px-2 text-xs text-muted-foreground hover:text-foreground" href={`/api/projects/${project.id}`}>Inspect</a></div></div><div className="mt-2 grid gap-1 text-[11px] text-muted-foreground sm:grid-cols-2"><span className="truncate">{project.repositoryPath}</span><span className="truncate">{project.repository ?? "Repository not verified"}</span><span>Revision hash {project.configurationIdentity ? `${project.configurationIdentity.slice(0, 8)}…` : "unaccepted"}</span><span>Base {project.baseBranch} · {project.baseSha ? `${project.baseSha.slice(0, 8)}…` : "unaccepted"}</span><span>Target {project.targetBranch} · {project.targetSha ? `${project.targetSha.slice(0, 8)}…` : "unaccepted"}</span><span>{project.requiredChecks.length} required checks</span><span>Defaults: Lead {project.roleDefaults.lead ?? "—"} · Developer {project.roleDefaults.developer ?? "—"}</span>{project.status === "draft" && missingRequirements.length ? <span className="font-medium text-amber-700 sm:col-span-2">{missingRequirements.length} activation requirements missing: {missingRequirements.map((requirement) => requirement.label).join(" · ")}</span> : null}</div></article>; })}
              {!loading && loadedCompanyId === companyId && visibleProjects.length === 0 ? <div className="py-8 text-center text-xs text-muted-foreground">No projects configured.</div> : null}
            </div>
          ) : <p className="text-xs text-muted-foreground">{loading ? "Loading companies" : companyError ? "Unable to load companies" : user?.role === "admin" ? "Create a company to begin." : "No company access. Ask an administrator to assign a company."}</p>}
          {loadError ? <div className="mt-3 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{loadError}</AlertDescription></Alert></div> : null}
        </section>
        <CreateProjectDialog open={createOpen} onOpenChange={setCreateOpen} companyId={companyId} companyStatus={currentCompany?.status} onCreated={reload} reloadCompanies={reloadCompanies} />
        <ProjectSettingsDialog project={settingsProject} profiles={profiles} onOpenChange={() => setSettingsProject(undefined)} onSaved={reload} />
      </div>
    </ApplicationFrame>
  );
}
