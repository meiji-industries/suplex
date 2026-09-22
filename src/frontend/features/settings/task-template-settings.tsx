import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Pencil } from "lucide-react";
import type { TaskTemplateInput } from "../../../tasks/templates.js";
import { DeliveryTargetSchema, VisualEvidenceSchema } from "../../../tasks/contracts.js";
import { ADVISOR_LABELS, WORKFLOWS, WorkflowIdSchema, workflowDefinition, type AdvisorRole } from "../../../coordination/workflows.js";
import { SettingsLayout } from "./settings-layout.js";
import { ProjectDetailsLayout } from "../projects/project-details-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, type SettingsTableColumn } from "../../components/app/settings-table.js";
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
import { readJson, withCompany } from "../../lib/api.js";
import type { ApiProfile, ApiProject, ApiTaskTemplate } from "../../shell/view-shared.js";

const columns: SettingsTableColumn[] = [
  { key: "name", label: "Name", width: 180 },
  { key: "description", label: "Description", width: 300 },
  { key: "workflow", label: "Workflow", width: 140 },
  { key: "delivery", label: "Delivery", width: 150 },
  { key: "tests", label: "Tests", width: 80 },
  { key: "evidence", label: "Evidence", width: 100 },
  { key: "edit", width: 36 },
];

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
const evidenceLabel = (value: ApiTaskTemplate["visualEvidence"]): string => value === "required" ? "Necessary" : value === "capture" ? "Capture" : "Off";

export function TaskTemplateSettings({ projectId: initialProjectId }: { projectId?: string }): ReactElement {
  const companyId = useCompanyContext().currentCompany?.id ?? "";
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? "");
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleteError, setDeleteError] = useState("");
  const [search, setSearch] = useState("");
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
      readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      readJson<{ profiles: ApiProfile[] }>("/api/profiles"),
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
    setSearch("");
    setError("");
    if (!projectId) return () => { closed = true; };
    void readJson<{ templates: ApiTaskTemplate[] }>(`/api/projects/${projectId}/task-templates`)
      .then((result) => { if (!closed) setTemplates(result.templates); })
      .catch((reason) => { if (!closed) setError(String(reason)); });
    return () => { closed = true; };
  }, [projectId]);

  const visibleTemplates = useMemo(() => {
    const term = search.trim().toLowerCase();
    return term ? templates.filter((template) => `${template.name} ${template.description}`.toLowerCase().includes(term)) : templates;
  }, [search, templates]);

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
      const result = await readJson<ApiTaskTemplate>(editing ? `/api/task-templates/${editor.templateId}` : `/api/projects/${projectId}/task-templates`, {
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
      await readJson(`/api/task-templates/${editor.templateId}`, { method: "DELETE" });
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

  const content = <>
    {projectError ? <div className="pt-3"><Alert variant="destructive"><AlertDescription>{projectError}</AlertDescription></Alert></div> : null}
    {projectId ? <section className="min-w-0 pt-3 lg:px-8">
      <SettingsToolbar searchLabel="Search templates" searchPlaceholder="Search templates" filterLabel="All templates" searchWidth="compact" searchValue={search} onSearchChange={setSearch} actions={<>
        {!initialProjectId ? <Select value={projectId} disabled={busy} onValueChange={(value) => setProjectId(value ?? "")}>
          <SelectTrigger aria-label="Template project"><SelectValue /></SelectTrigger>
          <SelectContent>{projects.map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
        </Select> : null}
        <NewButton disabled={busy} onClick={() => { setError(""); setEditor({ kind: "create", draft: emptyDraft() }); }}>New template</NewButton>
      </>} />
      {error && editor.kind === "closed" ? <div className="mt-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      <SettingsDataTable label="Task templates" columns={columns} className="mt-4">
        {templates.length > 0 ? <SettingsTableGroup label="Templates" count={visibleTemplates.length} columnCount={columns.length}>
          {visibleTemplates.map((template) => <SettingsTableRow key={template.id}>
            <SettingsTableCell className="truncate font-medium"><Button variant="link" size="sm" aria-label={`Edit ${template.name}`} onClick={() => edit(template)}>{template.name}</Button></SettingsTableCell>
            <SettingsTableCell className="truncate text-muted-foreground">{template.description}</SettingsTableCell>
            <SettingsTableCell className="truncate text-muted-foreground">{workflowDefinition(template.workflow).name}</SettingsTableCell>
            <SettingsTableCell className="truncate text-muted-foreground">{deliveryLabel(template.deliveryTarget)}</SettingsTableCell>
            <SettingsTableCell className="text-muted-foreground">{template.runProjectTests ? "Run" : "Skip"}</SettingsTableCell>
            <SettingsTableCell className="text-muted-foreground">{evidenceLabel(template.visualEvidence)}</SettingsTableCell>
            <SettingsTableCell className="p-0"><Button variant="ghost" size="icon-xs" aria-label={`Edit ${template.name} details`} title={`Edit ${template.name}`} onClick={() => edit(template)}><Pencil /></Button></SettingsTableCell>
          </SettingsTableRow>)}
        </SettingsTableGroup> : null}
        {templates.length === 0 ? <SettingsTableEmpty columnCount={columns.length}>No templates configured.</SettingsTableEmpty> : null}
        {templates.length > 0 && visibleTemplates.length === 0 ? <SettingsTableEmpty columnCount={columns.length}>No templates match the search.</SettingsTableEmpty> : null}
      </SettingsDataTable>
    </section> : !loadingProjects && !projectError ? <p className="pt-3 text-xs text-muted-foreground">Add a project before you add a template.</p> : null}

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
