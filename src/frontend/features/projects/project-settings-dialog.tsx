import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Textarea } from "../../components/ui/textarea.js";
import { ProjectConnections } from "./project-connections.js";
import { ProjectIntegrationSchema, type ProjectIntegration } from "../../../projects/integration-configuration.js";
import { ProjectExecutionSchema } from "../../../projects/execution-configuration.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { HARNESS_KIND_IDS } from "../../../runtimes/harness-kind.js";
import { isProfileAllowed, type ProjectProviderPolicy } from "../../../projects/provider-policy.js";
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
  integration: ProjectIntegration;
  instructions: string;
  skillDirectories: string;
  mcp: string;
  environment: string;
  providerPolicy: ProjectProviderPolicy | null;
  name: string;
  baseBranch: string;
  setupCommand: string;
  verificationCommand: string;
  rootProfileId: string;
  workerProfileId: string;
};

function settingsForm(project: ApiProject): ProjectSettingsForm {
  return {
    integration: project.integration ?? { repository: { kind: "github" }, tracker: project.repository ? { kind: "github", repository: project.repository } : null },
    instructions: project.execution?.instructions ?? "",
    skillDirectories: project.execution?.skillDirectories.join("\n") ?? "",
    mcp: JSON.stringify(project.execution?.mcp ?? [], null, 2),
    environment: JSON.stringify(project.execution?.environment ?? {}, null, 2),
    providerPolicy: project.providerPolicy ?? null,
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
          integration: ProjectIntegrationSchema.parse(form.integration),
          execution: ProjectExecutionSchema.parse({ instructions: form.instructions, skillDirectories: form.skillDirectories.split("\n").map(path => path.trim()).filter(Boolean), mcp: JSON.parse(form.mcp), environment: JSON.parse(form.environment) }),
          repositoryPath: project.repositoryPath,
          worktreeRoot: project.worktreeRoot,
          repository: project.repository ?? "",
          baseBranch: form.baseBranch,
          setupCommand: form.setupCommand,
          verificationCommand: form.verificationCommand,
          rootProfileId: form.rootProfileId,
          workerProfileId: form.workerProfileId,
          providerPolicy: form.providerPolicy,
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
                <FieldLegend variant="label">Provider access</FieldLegend>
                <Field orientation="horizontal"><Checkbox id="project-provider-policy" checked={form.providerPolicy !== null} onCheckedChange={checked => setField("providerPolicy", checked ? { allowedProviders: [...HARNESS_KIND_IDS], allowedInstanceIds: [] } : null)} /><FieldLabel htmlFor="project-provider-policy">Restrict providers and logins</FieldLabel></Field>
                {form.providerPolicy ? <>
                  {HARNESS_KIND_IDS.map(provider => <Field key={provider} orientation="horizontal"><Checkbox id={`project-provider-${provider}`} checked={form.providerPolicy!.allowedProviders.includes(provider)} onCheckedChange={checked => setField("providerPolicy", { ...form.providerPolicy!, allowedProviders: checked ? [...form.providerPolicy!.allowedProviders, provider] : form.providerPolicy!.allowedProviders.filter(value => value !== provider) })} /><FieldLabel htmlFor={`project-provider-${provider}`}>{provider}</FieldLabel></Field>)}
                  <FieldDescription>Claude Code needs an allowed dedicated login. Add logins and agents in Settings.</FieldDescription>
                  {[...new Set(agents.flatMap(agent => agent.providerInstanceId ? [agent.providerInstanceId] : []))].map(id => <Field key={id} orientation="horizontal"><Checkbox id={`project-login-${id}`} checked={form.providerPolicy!.allowedInstanceIds.includes(id)} onCheckedChange={checked => setField("providerPolicy", { ...form.providerPolicy!, allowedInstanceIds: checked ? [...form.providerPolicy!.allowedInstanceIds, id] : form.providerPolicy!.allowedInstanceIds.filter(value => value !== id) })} /><FieldLabel htmlFor={`project-login-${id}`}>Login for {agents.filter(agent => agent.providerInstanceId === id).map(agent => agent.name).join(", ")}</FieldLabel></Field>)}
                </> : null}
              </FieldSet>
              <ProjectConnections value={form.integration} onChange={value => setField("integration", value)} />
              <Field><FieldLabel htmlFor="project-instructions">Project instructions</FieldLabel><Textarea id="project-instructions" value={form.instructions} onChange={event => setField("instructions", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-skills">Skill directories, one per line</FieldLabel><Textarea id="project-skills" value={form.skillDirectories} onChange={event => setField("skillDirectories", event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="project-environment">Environment values (JSON)</FieldLabel><Textarea id="project-environment" value={form.environment} onChange={event => setField("environment", event.target.value)} /><FieldDescription>Use non-secret values. Configure credential references in Connections.</FieldDescription></Field>
              <Field><FieldLabel htmlFor="project-mcp">Claude MCP servers and tool grants (JSON)</FieldLabel><Textarea id="project-mcp" value={form.mcp} onChange={event => setField("mcp", event.target.value)} /><FieldDescription>Claude profiles only. Use environment variable names for credential references. Grant tools to Coordinator, Advisor, and Worker explicitly.</FieldDescription></Field>
              <FieldSet>
                <FieldLegend variant="label">Default agents</FieldLegend>
                {(["rootProfileId", "workerProfileId"] as const).map((key) => {
                  const role = key === "rootProfileId" ? "root" : "worker";
                  const options = agents.filter((agent) => agent.role === role && isProfileAllowed(form.providerPolicy, agent));
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
