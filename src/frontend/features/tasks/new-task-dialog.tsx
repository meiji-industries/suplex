import { useEffect, useRef, useState, type ReactElement } from "react";
import { isProfileAllowed } from "../../../projects/provider-policy.js";
import { FileText, FolderKanban, MoreHorizontal, X } from "lucide-react";
import { TaskImageInputSchema, DeliveryTargetSchema, VisualEvidenceSchema, type Task, type TaskInput } from "../../../tasks/contracts.js";
import { ADVISOR_LABELS, workflowDefinition, type AdvisorProfileIds, type AdvisorRole, type WorkflowId } from "../../../coordination/workflows.js";
import type { ApiProfile, ApiProject, ApiTaskTemplate, ApiWorkflow } from "../../shell/view-shared.js";
import { readJson, withCompany } from "../../lib/api.js";
import { Button } from "../../components/ui/button.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { InlineAttachmentPicker } from "../../components/ui/inline-attachment-picker.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from "../../components/ui/breadcrumb.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
import { TaskSourcePicker, prefillForTaskSource, type TaskSourceSelector, type TaskSourceSummary } from "./task-source-picker.js";
import { BlockedByPickerDialog } from "./blocked-by-picker.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { readNewTaskMemory, writeNewTaskMemory, type NewTaskMemory } from "./new-task-memory.js";
import { TaskRoleSelector } from "./task-role-selectors.js";
import { IssuePicker } from "./issue-picker.js";
import type { IssueAssociation } from "../../../tasks/issue-association.js";
import { supportsDeliveryTarget } from "../../../delivery/target-capabilities.js";
import type { NewTaskDraft } from "./lib/duplicate-task-prefill.js";

type Delivery = { deliveryTarget: NonNullable<TaskInput["deliveryTarget"]>; runProjectTests: boolean };
type RecordFallback = { rootProfileId?: string | undefined; workerProfileId?: string | undefined; advisorProfileIds?: AdvisorProfileIds | undefined; deliveryTarget?: Delivery["deliveryTarget"] | undefined; runProjectTests?: boolean | undefined; visualEvidence?: NonNullable<TaskInput["visualEvidence"]> | undefined };
const REPAIR: WorkflowId = "refine_pull_request";
const repairNote = "Forge repairs this pull request, then pushes and merges it after the checks pass.";

/** Keeps only the Advisor selections the selected workflow admits, so hidden or old choices never reach the request. */
function admittedAdvisors(workflow: WorkflowId, ids: AdvisorProfileIds): AdvisorProfileIds {
  const allowed = workflowDefinition(workflow).advisorRoles;
  return Object.fromEntries(Object.entries(ids).filter(([role, id]) => id && allowed.includes(role as AdvisorRole))) as AdvisorProfileIds;
}

/** The record a draft names, else the first live record on its engine, preferring the built-in one. */
function findRecord(records: ApiWorkflow[], id: string | undefined, engine: WorkflowId): ApiWorkflow | undefined {
  return records.find(record => record.id === id) ?? records.find(record => record.id === `workflow_native_${engine}`) ?? records.find(record => record.engine === engine && !record.archivedAt);
}

/** With editTask the dialog edits that task instead of creating one: it saves with PATCH and leaves the task's project, source and images alone. */
export function NewTaskDialog({ open, onOpenChange, companyId, onCreated, initialDraft, editTask }: { open: boolean; onOpenChange: (open: boolean) => void; companyId: string; onCreated: (task: Task) => void; initialDraft?: Partial<NewTaskDraft> | undefined; editTask?: Task | undefined }): ReactElement {
  const editing = editTask !== undefined;
  // An edit is about one task, never a preference: it neither reads nor writes the new task memory.
  const memory = (): NewTaskMemory => editing ? {} : readNewTaskMemory();
  const [remembered] = useState(memory);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [projectId, setProjectId] = useState(initialDraft?.projectId ?? remembered.projectId ?? "");
  const selectedProject = useRef(projectId);
  selectedProject.current = projectId;
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [rootProfileId, setRootProfileId] = useState(initialDraft?.rootProfileId ?? remembered.rootProfileId ?? "");
  const [workerProfileId, setWorkerProfileId] = useState(initialDraft?.workerProfileId ?? remembered.workerProfileId ?? "");
  const [startImmediately, setStartImmediately] = useState(initialDraft?.startImmediately ?? remembered.startImmediately ?? true);
  const [deliveryTarget, setDeliveryTarget] = useState<Delivery["deliveryTarget"]>(initialDraft?.deliveryTarget ?? remembered.deliveryTarget ?? "pull_request_draft");
  const [runProjectTests, setRunProjectTests] = useState(initialDraft?.runProjectTests ?? remembered.runProjectTests ?? true);
  const [visualEvidence, setVisualEvidence] = useState<NonNullable<TaskInput["visualEvidence"]>>(initialDraft?.visualEvidence ?? remembered.visualEvidence ?? "off");
  const [workflow, setWorkflow] = useState<WorkflowId>(initialDraft?.workflow ?? "standard");
  const [workflows, setWorkflows] = useState<ApiWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [advisorProfileIds, setAdvisorProfileIds] = useState<AdvisorProfileIds>(initialDraft?.advisorProfileIds ?? {});
  // The non-repair target/tests this draft had before switching to repair, restored when switching away.
  const previousDelivery = useRef<Delivery | null>(null);
  const [source, setSource] = useState<TaskSourceSelector | undefined>(initialDraft?.source);
  const [sourceSummary, setSourceSummary] = useState<TaskSourceSummary | undefined>(initialDraft?.sourceSummary);
  const [images, setImages] = useState<NonNullable<TaskInput["images"]>>(initialDraft?.images ?? []);
  const [blockedBy, setBlockedBy] = useState<Task["blockedBy"]>([]);
  const [blockedByPickerOpen, setBlockedByPickerOpen] = useState(false);
  const [issue, setIssue] = useState<IssueAssociation | null | undefined>(initialDraft?.issue);
  useEffect(() => { setIssue(initialDraft?.projectId === projectId ? initialDraft.issue : undefined); }, [projectId, initialDraft]);
  const [busy, setBusy] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const imageRead = useRef({ generation: 0, pending: false });
  const [error, setError] = useState("");
  const request = useRef<{ body: string; key: string } | null>(null);
  const repair = workflow === REPAIR;
  /** Explicit draft fields win, then the record's default agents and settings, then the fallback; repair always merges with tests. */
  const applyRecord = (record: ApiWorkflow, explicit: RecordFallback, fallback: RecordFallback) => {
    setRootProfileId(explicit.rootProfileId ?? record.rootProfileId ?? fallback.rootProfileId ?? "");
    setWorkerProfileId(explicit.workerProfileId ?? record.workerProfileId ?? fallback.workerProfileId ?? "");
    setAdvisorProfileIds(admittedAdvisors(record.engine, explicit.advisorProfileIds ?? { ...fallback.advisorProfileIds, ...record.advisorProfileIds }));
    setVisualEvidence(explicit.visualEvidence ?? record.visualEvidence ?? fallback.visualEvidence ?? "off");
    if (record.engine === REPAIR) { setDeliveryTarget("merged"); setRunProjectTests(true); return; }
    setDeliveryTarget(explicit.deliveryTarget ?? record.deliveryTarget ?? fallback.deliveryTarget ?? "pull_request_draft");
    setRunProjectTests(explicit.runProjectTests ?? record.runProjectTests ?? fallback.runProjectTests ?? true);
  };
  useEffect(() => {
    imageRead.current = { generation: imageRead.current.generation + 1, pending: false };
    setReadingImages(false);
  }, [companyId, open]);
  useEffect(() => {
    setSettingsLoaded(false);
    if (!open) return;
    // Explicit draft fields apply over the remembered general settings; workflow selections are never remembered.
    const saved = { ...memory(), ...initialDraft };
    if (!initialDraft && selectedProject.current !== saved.projectId) { setSource(undefined); setSourceSummary(undefined); }
    setProjectId(saved.projectId ?? "");
    setStartImmediately(saved.startImmediately ?? true);
    setVisualEvidence(saved.visualEvidence ?? "off");
    const nextWorkflow = initialDraft?.workflow ?? "standard";
    setRootProfileId(saved.rootProfileId ?? "");
    setWorkerProfileId(saved.workerProfileId ?? "");
    setWorkflow(nextWorkflow);
    setWorkflowId(initialDraft?.workflowId ?? "");
    setAdvisorProfileIds(admittedAdvisors(nextWorkflow, initialDraft?.advisorProfileIds ?? {}));
    previousDelivery.current = null;
    if (nextWorkflow === REPAIR) {
      previousDelivery.current = { deliveryTarget: memory().deliveryTarget ?? "pull_request_draft", runProjectTests: memory().runProjectTests ?? true };
      setDeliveryTarget("merged"); setRunProjectTests(true);
      if (initialDraft?.source?.kind !== "pull_request") { setSource(undefined); setSourceSummary(undefined); }
    } else {
      setDeliveryTarget(saved.deliveryTarget ?? "pull_request_draft");
      setRunProjectTests(saved.runProjectTests ?? true);
    }
    let cancelled = false;
    void Promise.all([readJson<{ projects: ApiProject[] }>(`/api/companies/${companyId}/projects`), readJson<{ profiles: ApiProfile[] }>("/api/profiles"), readJson<{ workflows: ApiWorkflow[] }>("/api/workflows?includeArchived=true")]).then(([projectResult, profileResult, workflowResult]) => {
      if (cancelled) return;
      setProjects(projectResult.projects); setProfiles(profileResult.profiles); setWorkflows(workflowResult.workflows);
      // The workflow record supplies its engine and defaults once it is known; explicit draft fields still win.
      const record = findRecord(workflowResult.workflows, initialDraft?.workflowId, nextWorkflow);
      if (record) { setWorkflow(record.engine); setWorkflowId(record.id); applyRecord(record, initialDraft ?? {}, memory()); }
      setRootProfileId(current => profileResult.profiles.some(profile => profile.id === current && profile.role === "root") ? current : "");
      setWorkerProfileId(current => profileResult.profiles.some(profile => profile.id === current && profile.role === "worker") ? current : "");
      setAdvisorProfileIds(current => Object.fromEntries(Object.entries(current).filter(([, id]) => profileResult.profiles.some(profile => profile.id === id && profile.role === "root"))) as AdvisorProfileIds);
      setProjectId(current => projectResult.projects.some(project => project.id === current) ? current : projectResult.projects[0]?.id ?? "");
      setSettingsLoaded(true);
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "Task settings are not available"); });
    return () => { cancelled = true; };
  }, [companyId, open, initialDraft]);
  useEffect(() => {
    setTemplates([]);
    if (!projectId || !open) return;
    let cancelled = false;
    void readJson<{ templates: ApiTaskTemplate[] }>(`/api/projects/${projectId}/task-templates`).then(result => { if (!cancelled) setTemplates(result.templates); }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [projectId, open]);
  useEffect(() => {
    if (editing || !open || !settingsLoaded || !projects.some(project => project.id === projectId)) return;
    // Repair forces target/tests; remember the draft's own general settings instead of the forced values.
    const general = repair && previousDelivery.current ? previousDelivery.current : { deliveryTarget, runProjectTests };
    // A workflow's default agent is not a general preference: keep the earlier remembered profile instead.
    const defaults: { rootProfileId?: string | undefined; workerProfileId?: string | undefined } = workflows.find(record => record.id === workflowId) ?? {};
    const remembered = memory();
    const rootProfile = rootProfileId && rootProfileId === defaults.rootProfileId ? remembered.rootProfileId : rootProfileId || undefined;
    const workerProfile = workerProfileId && workerProfileId === defaults.workerProfileId ? remembered.workerProfileId : workerProfileId || undefined;
    writeNewTaskMemory({ projectId, rootProfileId: rootProfile, workerProfileId: workerProfile, startImmediately, deliveryTarget: general.deliveryTarget, runProjectTests: general.runProjectTests, visualEvidence });
  }, [open, settingsLoaded, projects, projectId, rootProfileId, workerProfileId, startImmediately, deliveryTarget, runProjectTests, visualEvidence, repair, workflows, workflowId, editing]);
  const selectRecord = (record: ApiWorkflow) => {
    if (record.id === workflowId) return;
    const next = record.engine;
    let fallback: Delivery = { deliveryTarget, runProjectTests };
    if (next === REPAIR && workflow !== REPAIR) {
      previousDelivery.current = { deliveryTarget, runProjectTests };
      if (source?.kind !== "pull_request") { setSource(undefined); setSourceSummary(undefined); }
    } else if (workflow === REPAIR && next !== REPAIR && previousDelivery.current) {
      fallback = previousDelivery.current;
      previousDelivery.current = null;
    }
    setWorkflow(next);
    setWorkflowId(record.id);
    applyRecord(record, {}, { rootProfileId: rootProfileId || undefined, workerProfileId: workerProfileId || undefined, advisorProfileIds, visualEvidence, ...fallback });
  };
  const applyTemplate = (template: ApiTaskTemplate) => {
    setDescription(template.description); setRootProfileId(template.rootProfileId ?? ""); setWorkerProfileId(template.workerProfileId ?? "");
    setVisualEvidence(template.visualEvidence);
    if (template.workflow === REPAIR) { if (workflow !== REPAIR) previousDelivery.current = { deliveryTarget, runProjectTests }; if (source?.kind !== "pull_request") { setSource(undefined); setSourceSummary(undefined); } }
    else previousDelivery.current = null;
    setDeliveryTarget(template.deliveryTarget); setRunProjectTests(template.runProjectTests);
    setWorkflow(template.workflow); setWorkflowId(findRecord(workflows, undefined, template.workflow)?.id ?? ""); setAdvisorProfileIds(admittedAdvisors(template.workflow, template.advisorProfileIds));
  };
  const missingSource = repair && source?.kind !== "pull_request";
  const submit = async () => {
    if (busy || imageRead.current.pending || !projectId || !title.trim() || missingSource) return;
    setBusy(true); setError("");
    try {
      if (editTask) {
        const saved = await readJson<Task>(`/api/tasks/${editTask.id}`, { method: "PATCH", body: JSON.stringify({ title, description, deliveryTarget, runProjectTests, visualEvidence, workflow, advisorProfileIds: admittedAdvisors(workflow, advisorProfileIds), ...(rootProfileId ? { rootProfileId } : {}), ...(workerProfileId ? { workerProfileId } : {}) }) });
        onCreated(saved);
        return;
      }
      const body = { projectId, title, description, startImmediately, deliveryTarget, runProjectTests, visualEvidence, images, workflow, issue, advisorProfileIds: admittedAdvisors(workflow, advisorProfileIds), ...(rootProfileId ? { rootProfileId } : {}), ...(workerProfileId ? { workerProfileId } : {}), ...(source ? { source } : {}), ...(blockedBy.length ? { dependsOn: blockedBy.map(prerequisite => prerequisite.id) } : {}) };
      const serialized = JSON.stringify(body);
      if (request.current?.body !== serialized) request.current = { body: serialized, key: crypto.randomUUID() };
      const task = await readJson<Task>(`/api/companies/${companyId}/tasks`, { method: "POST", body: JSON.stringify({ ...body, idempotencyKey: request.current.key }) });
      request.current = null;
      setTitle(""); setDescription(""); setImages([]); setSource(undefined); setSourceSummary(undefined); setBlockedBy([]); setIssue(undefined);
      onCreated(task);
    } catch (error) { setError(error instanceof Error ? error.message : "Forge could not save the task"); }
    finally { setBusy(false); }
  };
  const addImages = async (files: File[]) => {
    if (busy || imageRead.current.pending) return;
    const generation = imageRead.current.generation;
    imageRead.current.pending = true;
    setReadingImages(true);
    try {
      if (files.length + images.length > 8 || files.some(file => file.size > 8 * 1024 * 1024)) throw new Error("Attach up to eight images of 8 MiB each");
      const added = await Promise.all(files.map(file => new Promise<NonNullable<TaskInput["images"]>[number]>((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error("The image could not be read"));
        reader.onload = () => { try { resolve(TaskImageInputSchema.parse({ filename: file.name, mimeType: file.type, base64: String(reader.result).split(",")[1] })); } catch (error) { reject(error); } };
        reader.readAsDataURL(file);
      })));
      if (imageRead.current.generation === generation) setImages(current => [...current, ...added]);
    } catch (error) { if (imageRead.current.generation === generation) setError(error instanceof Error ? error.message : "The image is not valid"); }
    finally { if (imageRead.current.generation === generation) { imageRead.current.pending = false; setReadingImages(false); } }
  };
  const project = projects.find(project => project.id === projectId);
  const eligibleProfiles = profiles.filter(profile => isProfileAllowed(editTask ? editTask.configuration.providerPolicy : project?.providerPolicy, profile));
  const repositoryConnection = editTask ? editTask.configuration.integration?.repository : project?.integration?.repository;
  const deliveryOptions = taskDeliveryTargetOptions.filter(option => supportsDeliveryTarget(repositoryConnection, option.value));
  const unsupportedTarget = !supportsDeliveryTarget(repositoryConnection, deliveryTarget);
  useEffect(() => { if (!repair && !supportsDeliveryTarget(repositoryConnection, deliveryTarget)) setDeliveryTarget("pull_request_draft"); }, [repair, repositoryConnection, deliveryTarget]);
  useEffect(() => {
    if (editing || !open || !settingsLoaded || !project?.providerPolicy) return;
    const allowed = (id: string) => profiles.some(profile => profile.id === id && isProfileAllowed(project.providerPolicy, profile));
    if (rootProfileId && !allowed(rootProfileId)) setRootProfileId("");
    if (workerProfileId && !allowed(workerProfileId)) setWorkerProfileId("");
    if (Object.values(advisorProfileIds).some(id => id && !allowed(id))) setAdvisorProfileIds(current => Object.fromEntries(Object.entries(current).filter(([, id]) => id && allowed(id))));
  }, [editing, open, settingsLoaded, project, profiles, rootProfileId, workerProfileId, advisorProfileIds]);
  const definition = workflowDefinition(workflow);
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="max-h-[min(85vh,460px)] w-[min(92vw,936px)] max-w-none gap-0 overflow-y-auto rounded-xl p-0 shadow-2xl sm:max-w-[936px]" showCloseButton={false}>
      <DialogHeader className="px-4 py-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><Breadcrumb><BreadcrumbList className="gap-2 text-sm"><BreadcrumbItem>
          <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" aria-label="Project" disabled={busy || editing || !projects.length} />}>
            {project ? <EntityAvatar kind="project" id={project.id} name={project.name} size="xs" /> : <FolderKanban className="size-3.5 text-muted-foreground" />}<span className="max-w-40 truncate">{project?.name ?? "Project"}</span>
          </DropdownMenuTrigger><DropdownMenuContent align="start">{projects.map(candidate => <DropdownMenuItem key={candidate.id} onClick={() => { setProjectId(candidate.id); setSource(undefined); setSourceSummary(undefined); setBlockedBy([]); }}><EntityAvatar kind="project" id={candidate.id} name={candidate.name} size="xs" /><span className="min-w-0 flex-1 truncate">{candidate.name}</span>{candidate.id === projectId ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        </BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><DialogTitle className="font-normal">{editing ? "Edit task" : "New task"}</DialogTitle></BreadcrumbItem></BreadcrumbList></Breadcrumb>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          <TaskSourcePicker projectId={projectId} value={sourceSummary} disabled={busy || editing} pullRequestsOnly={repair} onClear={() => { setSource(undefined); setSourceSummary(undefined); }} onSelect={(summary, selector) => { setSource(selector); setSourceSummary(summary); const prefill = prefillForTaskSource(summary); if (!title) setTitle(prefill.title); if (!description) setDescription(prefill.description); if (summary.kind === "issue" && project?.repository) setIssue(current => current === undefined ? { kind: "github", repository: project.repository!, number: summary.number, id: String(summary.number), key: `#${summary.number}`, title: summary.title, url: summary.url } : current); }} />
          <label className="flex items-center gap-1.5 text-xs"><span className="text-muted-foreground">Workflow</span><Select value={workflowId} onValueChange={value => { const record = workflows.find(candidate => candidate.id === value); if (record) selectRecord(record); }}><SelectTrigger aria-label="Workflow" size="sm" disabled={busy}><SelectValue /></SelectTrigger><SelectContent>{workflows.filter(record => (!record.archivedAt || record.id === workflowId) && (repositoryConnection?.kind !== "bitbucket" || record.engine !== REPAIR)).map(record => <SelectItem key={record.id} value={record.id}>{record.name}</SelectItem>)}</SelectContent></Select></label>
          <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={busy || !projectId} />}><FileText className="size-3.5" />Template</DropdownMenuTrigger><DropdownMenuContent align="end">{templates.length ? templates.map(template => <DropdownMenuItem key={template.id} onClick={() => applyTemplate(template)}>{template.name}</DropdownMenuItem>) : <DropdownMenuItem render={<a href={withCompany(`/projects/${encodeURIComponent(projectId)}/templates`, companyId)} />}>Open templates</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
        </div></div>
      </DialogHeader>
      <form className="flex min-h-[310px] min-w-0 flex-col" onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length && !busy && !editing) { event.preventDefault(); void addImages(files); } }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="px-5 pt-1">
          <Input aria-label="Task title" autoFocus placeholder="Task title" value={title} onChange={event => setTitle(event.target.value)} className="h-10 border-0 bg-transparent px-0 text-lg font-semibold placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-lg dark:bg-transparent" />
          <Textarea aria-label="Task description" placeholder="Write a description" value={description} onChange={event => setDescription(event.target.value)} className="min-h-20 resize-none border-0 bg-transparent px-0 py-1 text-sm font-normal placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent" />
        </div>
        {error ? <div className="px-5 pb-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        <div className="mt-auto flex flex-wrap items-end gap-2 px-5 pb-4">
          {editing ? null : <InlineAttachmentPicker compact attachments={images.map((image, index) => ({ id: String(index), filename: image.filename, previewUrl: `data:${image.mimeType};base64,${image.base64}` }))} onSelect={addImages} onRemove={index => setImages(current => current.filter((_, item) => item !== index))} disabled={busy || readingImages} />}
          <TaskRoleSelector role="root" profiles={eligibleProfiles} assignment={rootProfileId} defaultProfileId={project?.rootProfileId} busy={busy} onChange={setRootProfileId} />
           <TaskRoleSelector role="worker" profiles={eligibleProfiles} assignment={workerProfileId} defaultProfileId={project?.workerProfileId} busy={busy} onChange={setWorkerProfileId} />
           {!editing ? <div className="flex min-w-0 items-center gap-1"><span>Issue</span><IssuePicker projectId={projectId} issue={issue} disabled={busy} onChange={selected => { setIssue(selected); if (selected && !title.trim()) setTitle(selected.title); }} /></div> : null}
           {definition.advisorRoles.map(role => <TaskRoleSelector key={role} role="root" label={ADVISOR_LABELS[role]} profiles={eligibleProfiles} assignment={advisorProfileIds[role] ?? ""} defaultProfileId={rootProfileId || project?.rootProfileId} busy={busy} onChange={profileId => setAdvisorProfileIds(current => ({ ...current, [role]: profileId || undefined }))} />)}
           {editing ? null : <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-xs" aria-label="More options" disabled={busy || !projectId} />}><MoreHorizontal /></DropdownMenuTrigger><DropdownMenuContent><DropdownMenuItem onClick={() => setBlockedByPickerOpen(true)}>Blocked by...</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
           {blockedBy.map(prerequisite => <span key={prerequisite.id} className="flex items-center gap-1 text-xs" data-blocked-by-selection><span className="max-w-40 truncate">Blocked by {prerequisite.title}</span><Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${prerequisite.title} from Blocked by`} disabled={busy} onClick={() => setBlockedBy(current => current.filter(selected => selected.id !== prerequisite.id))}><X /></Button></span>)}
          <DialogFooter className="ml-auto flex-row items-center gap-2 sm:justify-end">{unsupportedTarget ? <span>Select a workflow that delivers a draft pull request.</span> : repair ? <span className="text-xs text-muted-foreground" data-repair-note>{missingSource ? "Select a pull request source." : repairNote}</span> : null}<NewButton type="submit" disabled={busy || readingImages || !projectId || !title.trim() || missingSource || unsupportedTarget} title={editing ? "Save task (⌘Enter)" : "New task (⌘Enter)"}>{busy ? (editing ? "Saving…" : "Creating…") : editing ? "Save task" : "New task"}</NewButton></DialogFooter>
        </div>
        <fieldset className="min-w-0 border-t border-border/70 bg-muted/30 px-5 py-3"><legend className="px-0 text-xs font-medium text-muted-foreground">Delivery &amp; checks</legend>
          <RadioGroup aria-label="Delivery target" value={deliveryTarget} disabled={repair} onValueChange={value => setDeliveryTarget(DeliveryTargetSchema.parse(value))} className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">{deliveryOptions.map(option => <label className="flex items-center gap-1.5 text-xs" key={option.value}><RadioGroupItem value={option.value} disabled={repair} />{option.label}</label>)}</RadioGroup>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-2.5 text-xs">
            {editing ? null : <label className="flex cursor-pointer items-center gap-2"><Checkbox checked={startImmediately} onCheckedChange={value => setStartImmediately(value === true)} />Start immediately</label>}
            {project?.verificationCommand.trim() || repair ? <label className="flex items-center gap-2"><Checkbox checked={runProjectTests} disabled={repair} onCheckedChange={value => setRunProjectTests(value === true)} />Run project tests</label> : <span className="text-muted-foreground">No project test command configured.</span>}
            <label className="flex items-center gap-2">Screenshots<Select value={visualEvidence} onValueChange={value => setVisualEvidence(VisualEvidenceSchema.parse(value))}><SelectTrigger aria-label="Screenshots" size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Necessary</SelectItem></SelectContent></Select></label>
          </div>
        </fieldset>
      </form>
    </DialogContent>
    <BlockedByPickerDialog open={blockedByPickerOpen} onOpenChange={setBlockedByPickerOpen} companyId={companyId} projectId={projectId} excludeTaskIds={blockedBy.map(prerequisite => prerequisite.id)} onSelect={selected => setBlockedBy(current => [...current, selected])} onError={setError} />
  </Dialog>;
}
