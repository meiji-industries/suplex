import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldDescription, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { AvatarEditor, EntityAvatar } from "../../components/app/entity-avatar.js";
import { readJson, withCompany } from "../../lib/api.js";
import type { ApiProfile, ApiProject } from "../../shell/view-shared.js";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";
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

export function ProjectSettingsDialog({
  project,
  agents,
  onOpenChange,
  onSaved,
}: {
  project: ApiProject | undefined;
  agents: readonly ApiProfile[];
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
              <Field><FieldLabel>Avatar</FieldLabel><AvatarEditor kind="project" id={project.id} name={form.name || project.name} /></Field>
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
                  return <Field key={key}><FieldLabel htmlFor={`project-${key}`}>{role === "root" ? "Coordinator" : "Worker"} default</FieldLabel><Select value={form[key] || null} onValueChange={(value) => setField(key, value ?? "")}><SelectTrigger id={`project-${key}`}><SelectValue placeholder="None">{selected ? <span className="flex items-center gap-2"><EntityAvatar kind="agent" id={selected.id} name={selected.name} seed={selected.avatarSeed} />{selected.name}</span> : "None"}</SelectValue></SelectTrigger><SelectContent>{options.map((agent) => <SelectItem key={agent.id} value={agent.id}><span className="flex items-center gap-2"><EntityAvatar kind="agent" id={agent.id} name={agent.name} seed={agent.avatarSeed} />{agent.name}</span></SelectItem>)}</SelectContent></Select></Field>;
                })}
                {agents.length === 0 ? <FieldDescription>No agents configured. <a href={withCompany("/admin/agents", project.companyId)}>Add an agent</a> before saving this project.</FieldDescription> : null}
              </FieldSet>
              <DialogFooter><a href={withCompany(`/projects/${encodeURIComponent(project.id)}/templates`, project.companyId)}>Templates</a><DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || !form.rootProfileId || !form.workerProfileId}>{busy ? "Saving…" : "Save settings"}</Button></DialogFooter>
            </FieldGroup>
          </form> : null}
          {error ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-destructive">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}
