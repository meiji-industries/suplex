import { useEffect, useState, type ReactElement } from "react";
import { Pencil, Plus } from "lucide-react";
import type { TaskTemplateInput } from "../../contracts/task-templates.js";
import { DeliveryTargetSchema, VisualEvidenceSchema } from "../../contracts/tasks.js";
import { ADVISOR_LABELS, WORKFLOWS, workflowDefinition } from "../tasks/workflow-presentation.js";
import { WorkflowIdSchema } from "../../contracts/workflows.js";
import type { AdvisorRole } from "../../contracts/advisor-reports.js";
import { SettingRow, SettingsContent, SettingsLayout, SettingsSection } from "./settings-layout.js";
import { ProjectDetailsLayout } from "../projects/project-details-layout.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { taskDeliveryTargetOptions } from "../tasks/task-delivery-target.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Button } from "../../components/ui/button.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import type { ApiProfile, ApiProject, ApiTaskTemplate } from "../../shell/view-shared.js";

type EditorState =
  | { kind: "closed" }
  | { kind: "create"; draft: TaskTemplateInput }
  | { kind: "edit"; templateId: string; draft: TaskTemplateInput };

const emptyDraft = (): TaskTemplateInput => ({ name: "", description: "", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off", workflow: "standard", advisorProfileIds: {} });

const templateDraft = (template: ApiTaskTemplate): TaskTemplateInput => ({
  name: template.name,
  description: template.description,
  deliveryTarget: template.deliveryTarget,
  runProjectTests: template.runProjectTests,
  visualEvidence: template.visualEvidence,
  workflow: template.workflow,
  advisorProfileIds: template.advisorProfileIds,
  ...(template.rootProfileId ? { rootProfileId: template.rootProfileId } : {}),
  ...(template.workerProfileId ? { workerProfileId: template.workerProfileId } : {}),
});

const deliveryLabel = (value: ApiTaskTemplate["deliveryTarget"]): string => taskDeliveryTargetOptions.find((option) => option.value === value)?.label ?? value;

export function TaskTemplateSettings({ projectId: initialProjectId }: { projectId?: string }): ReactElement {
  const companyId = useCompanyContext().currentCompany?.id ?? "";
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [projectError, setProjectError] = useState("");
  const [loadingProjects, setLoadingProjects] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!companyId) return;
    let closed = false;
    setLoadingProjects(true);
    setProjectError("");
    void Promise.all([
      readJsonUnchecked<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      readJsonUnchecked<{ profiles: ApiProfile[] }>("/api/profiles"),
    ]).then(([projectResult, profileResult]) => {
      if (closed) return;
      setProjects(projectResult.projects);
      setProfiles(profileResult.profiles);
      setProjectId((current) => initialProjectId
        ? projectResult.projects.some((project) => project.id === initialProjectId) ? initialProjectId : ""
        : projectResult.projects.some((project) => project.id === current) ? current : projectResult.projects[0]?.id ?? "");
    }).catch((reason) => { if (!closed) setProjectError(String(reason)); })
      .finally(() => { if (!closed) setLoadingProjects(false); });
    return () => { closed = true; };
  }, [companyId, initialProjectId]);

  useEffect(() => {
    let closed = false;
    setTemplates([]);
    setEditor({ kind: "closed" });
    setDeleteOpen(false);
    setDeleteError("");
    setError("");
    if (!projectId) return () => { closed = true; };
    void readJsonUnchecked<{ templates: ApiTaskTemplate[] }>(`/api/projects/${projectId}/task-templates`)
      .then((result) => { if (!closed) setTemplates(result.templates); })
      .catch((reason) => { if (!closed) setError(String(reason)); });
    return () => { closed = true; };
  }, [projectId]);

  const edit = (template: ApiTaskTemplate): void => {
    setError("");
    setEditor({ kind: "edit", templateId: template.id, draft: templateDraft(template) });
  };

  const setDraft = <Key extends keyof TaskTemplateInput>(key: Key, value: TaskTemplateInput[Key]): void => {
    setEditor((current) => current.kind === "closed" ? current : { ...current, draft: { ...current.draft, [key]: value } });
  };

  const save = async (): Promise<void> => {
    if (editor.kind === "closed") return;
    setBusy(true);
    setError("");
    try {
      const editing = editor.kind === "edit";
      const result = await readJsonUnchecked<ApiTaskTemplate>(editing ? `/api/task-templates/${editor.templateId}` : `/api/projects/${projectId}/task-templates`, {
        method: editing ? "PATCH" : "POST",
        body: JSON.stringify(editing ? { ...editor.draft, rootProfileId: editor.draft.rootProfileId ?? null, workerProfileId: editor.draft.workerProfileId ?? null } : editor.draft),
      });
      setTemplates((current) => [...current.filter((template) => template.id !== result.id), result].sort((left, right) => left.name.localeCompare(right.name)));
      setEditor({ kind: "closed" });
    } catch (reason) {
      setError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (): Promise<void> => {
    if (editor.kind !== "edit") return;
    setBusy(true);
    setDeleteError("");
    try {
      await readJsonUnchecked(`/api/task-templates/${editor.templateId}`, { method: "DELETE" });
      setTemplates((current) => current.filter((template) => template.id !== editor.templateId));
      setDeleteOpen(false);
      setEditor({ kind: "closed" });
    } catch (reason) {
      setDeleteError(String(reason));
    } finally {
      setBusy(false);
    }
  };

  const draft = editor.kind === "closed" ? null : editor.draft;
  const editingTemplate = editor.kind === "edit" ? templates.find((template) => template.id === editor.templateId) : undefined;

  const create = (): void => { setError(""); setEditor({ kind: "create", draft: emptyDraft() }); };
  const content = <><SettingsContent title="Task templates" description="A template sets the workflow, delivery, and checks for a new task in its project." actions={projectId ? <>
      {!initialProjectId && projects.length > 1 ? <Select value={projectId} disabled={busy} onValueChange={(value) => setProjectId(value ?? "")}>
        <SelectTrigger size="sm" aria-label="Template project"><SelectValue /></SelectTrigger>
        <SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
      </Select> : null}
      {templates.length > 0 ? <NewButton disabled={busy} onClick={create}>New template</NewButton> : null}
    </> : null}>
    {projectError ? <div className="mb-4"><Alert variant="destructive"><AlertDescription>{projectError}</AlertDescription></Alert></div> : null}
    {error && editor.kind === "closed" ? <div className="mb-4"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
    {projectId ? <SettingsSection>
      {templates.length === 0 ? <SettingRow label="No task templates">
        <Button variant="ghost" size="sm" disabled={busy} onClick={create}><Plus />New template</Button>
      </SettingRow> : templates.map((template) => <SettingRow key={template.id} label={template.name} description={template.description || workflowDefinition(template.workflow).name}>
        <div className="flex items-center gap-3">
          <span className="hidden text-xs text-muted-foreground sm:inline">{workflowDefinition(template.workflow).name} · {deliveryLabel(template.deliveryTarget)}</span>
          <Button variant="ghost" size="icon-sm" aria-label={`Edit ${template.name}`} title={`Edit ${template.name}`} onClick={() => edit(template)}><Pencil /></Button>
        </div>
      </SettingRow>)}
    </SettingsSection> : !loadingProjects && !projectError ? <SettingsSection>
      <SettingRow label="No projects" description="Add a project before you add a template.">
        <Button variant="ghost" size="sm" nativeButton={false} render={<a href={withCompany("/projects", companyId)} />}><Plus />New project</Button>
      </SettingRow>
    </SettingsSection> : null}
  </SettingsContent>

    <Dialog open={editor.kind !== "closed"} onOpenChange={(open) => { if (!open && !busy) { setEditor({ kind: "closed" }); setDeleteOpen(false); setError(""); } }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{editor.kind === "edit" ? "Edit template" : "New template"}</DialogTitle></DialogHeader>
        {draft ? <form className="max-h-[70dvh] overflow-y-auto" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FieldGroup>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Field><FieldLabel htmlFor="template-name">Name</FieldLabel><Input id="template-name" autoFocus disabled={busy} value={draft.name} onChange={(event) => setDraft("name", event.target.value)} required /></Field>
            <Field><FieldLabel htmlFor="template-description">Description</FieldLabel><Textarea id="template-description" disabled={busy} value={draft.description} onChange={(event) => setDraft("description", event.target.value)} rows={5} required /></Field>
            <Field><FieldLabel htmlFor="template-workflow">Workflow</FieldLabel><Select disabled={busy} value={draft.workflow ?? "standard"} onValueChange={(value) => { const workflow = WorkflowIdSchema.parse(value); setEditor((current) => current.kind === "closed" ? current : { ...current, draft: { ...current.draft, workflow, advisorProfileIds: Object.fromEntries(Object.entries(current.draft.advisorProfileIds ?? {}).filter(([role]) => workflowDefinition(workflow).advisorRoles.includes(role as AdvisorRole))), ...(workflow === "refine_pull_request" ? { deliveryTarget: "merged" as const, runProjectTests: true } : {}) } }); }}><SelectTrigger id="template-workflow"><SelectValue /></SelectTrigger><SelectContent>{WORKFLOWS.map((workflow) => <SelectItem key={workflow.id} value={workflow.id}>{workflow.name}</SelectItem>)}</SelectContent></Select></Field>
            <FieldSet disabled={busy}>
              <FieldLegend variant="label">Agents</FieldLegend>
              {workflowDefinition(draft.workflow ?? "standard").advisorRoles.map((role) => <Field key={role}><FieldLabel htmlFor={`template-advisor-${role}`}>{ADVISOR_LABELS[role]} profile</FieldLabel><Select disabled={busy} value={draft.advisorProfileIds?.[role] ?? "default"} onValueChange={(value) => setDraft("advisorProfileIds", { ...draft.advisorProfileIds, [role]: value === "default" ? undefined : value ?? undefined })}><SelectTrigger id={`template-advisor-${role}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Same as Coordinator</SelectItem>{profiles.filter((profile) => profile.role === "root").map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.model} · {profile.provider}</SelectItem>)}</SelectContent></Select></Field>)}
              {(["rootProfileId", "workerProfileId"] as const).map((key) => {
                const role = key === "rootProfileId" ? "root" : "worker";
                return <Field key={key}><FieldLabel htmlFor={`template-${key}`}>{role === "root" ? "Coordinator profile" : "Worker profile"}</FieldLabel><Select disabled={busy} value={draft[key] ?? "default"} onValueChange={(value) => setDraft(key, value === "default" ? undefined : value ?? undefined)}><SelectTrigger id={`template-${key}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Project default</SelectItem>{profiles.filter((profile) => profile.role === role).map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.model} · {profile.provider}</SelectItem>)}</SelectContent></Select></Field>;
              })}
            </FieldSet>
            <FieldSet disabled={busy}>
              <FieldLegend variant="label">Configuration</FieldLegend>
              <Field><FieldLabel htmlFor="template-delivery-target">Delivery target</FieldLabel><Select disabled={busy || draft.workflow === "refine_pull_request"} value={draft.deliveryTarget} onValueChange={(value) => setDraft("deliveryTarget", DeliveryTargetSchema.parse(value))}><SelectTrigger id="template-delivery-target"><SelectValue /></SelectTrigger><SelectContent>{taskDeliveryTargetOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="template-browser-evidence">Browser evidence</FieldLabel><Select disabled={busy} value={draft.visualEvidence} onValueChange={(value) => setDraft("visualEvidence", VisualEvidenceSchema.parse(value))}><SelectTrigger id="template-browser-evidence"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Necessary</SelectItem></SelectContent></Select></Field>
              <Field orientation="horizontal"><Checkbox id="template-run-project-tests" disabled={busy || draft.workflow === "refine_pull_request"} checked={draft.runProjectTests ?? true} onCheckedChange={(value) => setDraft("runProjectTests", value === true)} /><FieldLabel htmlFor="template-run-project-tests">Run project tests</FieldLabel></Field>
            </FieldSet>
            <DialogFooter>
              {editor.kind === "edit" ? <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={() => { setDeleteError(""); setDeleteOpen(true); }}>Delete template</Button> : null}
              <DialogClose disabled={busy} render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
              {editor.kind === "edit" ? <Button type="submit" size="sm" disabled={busy}>{busy ? "Creating…" : "Save template"}</Button> : <NewButton type="submit" disabled={busy}>{busy ? "Creating…" : "New template"}</NewButton>}
            </DialogFooter>
          </FieldGroup>
        </form> : null}
      </DialogContent>
    </Dialog>

    <AlertDialog open={deleteOpen} onOpenChange={(open) => { if (!busy) { setDeleteOpen(open); if (!open) setDeleteError(""); } }}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Delete {editingTemplate?.name}?</AlertDialogTitle><AlertDialogDescription>Suplex permanently deletes this template. Existing tasks do not change.</AlertDialogDescription></AlertDialogHeader>
        {deleteError ? <Alert variant="destructive"><AlertDescription>{deleteError}</AlertDescription></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" disabled={busy} onClick={(event) => { event.preventDefault(); void remove(); }}>{busy ? "Deleting…" : "Delete"}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </>;
  if (initialProjectId) {
    const selectedProject = projects.find((project) => project.id === initialProjectId);
    return <ProjectDetailsLayout projectId={initialProjectId} companyId={companyId} title={selectedProject?.name ?? "Project templates"} active="templates">{content}</ProjectDetailsLayout>;
  }
  return <SettingsLayout title="Task templates" companyId={companyId} backHref={withCompany("/projects", companyId)} activeHref={withCompany("/templates", companyId)}>{content}</SettingsLayout>;
}
