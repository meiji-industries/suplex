import { updateTask, createTask } from "./lib/task-api.js";
import { useEffect, useRef, useState, type ReactElement } from "react";
import { isProfileAllowed } from "../projects/lib/provider-policy.js";
import { TriangleAlert, ChevronDown, CircleOff, CirclePlus, Combine, FileText, FolderGit2, FolderKanban, GitBranch, GitMerge, GitPullRequest, GitPullRequestDraft, Inbox, ListChecks, Play, ScanEye, Send, TestTube2, Wrench, X } from "lucide-react";
import { TaskImageInputSchema, DeliveryTargetSchema, type Task, type TaskInput } from "../../contracts/tasks.js";
import { ADVISOR_DEFAULT_LABELS, ADVISOR_LABELS, workflowDefinition } from "./workflow-presentation.js";
import type { AdvisorProfileIds, WorkflowId } from "../../contracts/workflows.js";
import type { AdvisorRole } from "../../contracts/advisor-reports.js";
import type { ApiProfile, ApiProject, ApiTaskTemplate, ApiWorkflow } from "../../shell/view-shared.js";
import { ApiError, readJsonUnchecked, withCompany } from "../../lib/api.js";
import { useTaskCache } from "./task-data.js";
import { navigate } from "../../shell/navigation-state.js";
import { Collapsible } from "../../components/ui/collapsible.js";
import { ButtonGroup, ButtonGroupText } from "../../components/ui/button-group.js";
import { Button } from "../../components/ui/button.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { TaskOptionFilter } from "./task-option-filter.js";
import { InlineAttachmentList, InlineAttachmentPicker } from "../../components/ui/inline-attachment-picker.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from "../../components/ui/breadcrumb.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { WorkflowIllustration } from "./workflow-illustration.js";
import { TaskSourcePicker, issueTaskSource, prefillForTaskSource, type TaskSourceSelector, type TaskSourceSummary } from "./task-source-picker.js";
import { BlockedByPickerDialog } from "./blocked-by-picker.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { readNewTaskMemory, writeNewTaskMemory, type NewTaskMemory } from "./new-task-memory.js";
import { TaskRoleSelector } from "./task-role-selectors.js";
import { supportsDeliveryTarget } from "./lib/delivery-target-capabilities.js";
import type { NewTaskDraft } from "./lib/duplicate-task-prefill.js";
import { listProjects } from "../projects/lib/project-api.js";

type Delivery = { deliveryTarget: NonNullable<TaskInput["deliveryTarget"]>; runProjectTests: boolean };
type RecordFallback = { rootProfileId?: string | undefined; workerProfileId?: string | undefined; advisorProfileIds?: AdvisorProfileIds | undefined; deliveryTarget?: Delivery["deliveryTarget"] | undefined; runProjectTests?: boolean | undefined; visualEvidence?: NonNullable<TaskInput["visualEvidence"]> | undefined };
const workflowIcons: Record<WorkflowId, ReactElement> = {
  standard: <ListChecks aria-hidden="true" className="size-[11px]" />,
  direct_build: <Send aria-hidden="true" className="size-[11px]" />,
  independent_review: <ScanEye aria-hidden="true" className="size-[11px]" />,
  competing_plans: <Combine aria-hidden="true" className="size-[11px]" />,
  refine_pull_request: <Wrench aria-hidden="true" className="size-[11px]" />,
};
const deliveryIcons: Record<Delivery["deliveryTarget"], ReactElement> = {
  local_worktree: <FolderGit2 aria-hidden="true" className="size-[11px]" />,
  remote_branch: <GitBranch aria-hidden="true" className="size-[11px]" />,
  pull_request_draft: <GitPullRequestDraft aria-hidden="true" className="size-[11px]" />,
  pull_request_ready: <GitPullRequest aria-hidden="true" className="size-[11px]" />,
  merged: <GitMerge aria-hidden="true" className="size-[11px]" />,
};
const REPAIR: WorkflowId = "refine_pull_request";
const repairNote = "Suplex repairs this pull request, then pushes and merges it after the checks pass.";

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
  const cacheTask = useTaskCache();
  const openTask = (taskId: string): void => { onOpenChange(false); navigate(withCompany(`/tasks/${taskId}`, companyId)); };
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
  const [workflowPreviewOpen, setWorkflowPreviewOpen] = useState(true);
  const [workflows, setWorkflows] = useState<ApiWorkflow[]>([]);
  const [workflowId, setWorkflowId] = useState("");
  const [advisorProfileIds, setAdvisorProfileIds] = useState<AdvisorProfileIds>(initialDraft?.advisorProfileIds ?? {});
  // The non-repair target this draft had before switching to repair, restored when switching away.
  const previousDelivery = useRef<Delivery["deliveryTarget"] | null>(null);
  const [source, setSource] = useState<TaskSourceSelector | undefined>(initialDraft?.source);
  const [sourceSummary, setSourceSummary] = useState<TaskSourceSummary | undefined>(initialDraft?.sourceSummary ?? (initialDraft?.issue ? issueTaskSource(initialDraft.issue) : undefined));
  const [images, setImages] = useState<NonNullable<TaskInput["images"]>>(initialDraft?.images ?? []);
  const [blockedBy, setBlockedBy] = useState<Task["blockedBy"]>([]);
  const [blockedByPickerOpen, setBlockedByPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const imageRead = useRef({ generation: 0, pending: false });
  const [error, setError] = useState("");
  // Project settings problems that stop task creation; the alert links to the settings that fix them.
  const [projectFindings, setProjectFindings] = useState<string[]>([]);
  const request = useRef<{ body: string; key: string } | null>(null);
  const repair = workflow === REPAIR;
  /** Explicit draft fields win, then the record's default agents and settings, then the fallback; repair always merges. */
  const applyRecord = (record: ApiWorkflow, explicit: RecordFallback, fallback: RecordFallback) => {
    setRootProfileId(explicit.rootProfileId ?? record.rootProfileId ?? fallback.rootProfileId ?? "");
    setWorkerProfileId(explicit.workerProfileId ?? record.workerProfileId ?? fallback.workerProfileId ?? "");
    setAdvisorProfileIds(admittedAdvisors(record.engine, explicit.advisorProfileIds ?? { ...fallback.advisorProfileIds, ...record.advisorProfileIds }));
    setVisualEvidence(explicit.visualEvidence ?? record.visualEvidence ?? fallback.visualEvidence ?? "off");
    setDeliveryTarget(record.engine === REPAIR ? "merged" : explicit.deliveryTarget ?? record.deliveryTarget ?? fallback.deliveryTarget ?? "pull_request_draft");
    setRunProjectTests(explicit.runProjectTests ?? record.runProjectTests ?? fallback.runProjectTests ?? true);
  };
  useEffect(() => {
    imageRead.current = { generation: imageRead.current.generation + 1, pending: false };
    setReadingImages(false);
  }, [companyId, open]);
  useEffect(() => {
    setSettingsLoaded(false);
    if (!open) return;
    setWorkflowPreviewOpen(true);
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
    setRunProjectTests(saved.runProjectTests ?? true);
    if (nextWorkflow === REPAIR) {
      previousDelivery.current = memory().deliveryTarget ?? "pull_request_draft";
      setDeliveryTarget("merged");
      if (initialDraft?.source?.kind !== "pull_request") { setSource(undefined); setSourceSummary(undefined); }
    } else {
      setDeliveryTarget(saved.deliveryTarget ?? "pull_request_draft");
    }
    let cancelled = false;
    void Promise.all([listProjects(companyId), readJsonUnchecked<{ profiles: ApiProfile[] }>("/api/profiles"), readJsonUnchecked<{ workflows: ApiWorkflow[] }>("/api/workflows?includeArchived=true")]).then(([projectResult, profileResult, workflowResult]) => {
      if (cancelled) return;
      setProjects(projectResult); setProfiles(profileResult.profiles); setWorkflows(workflowResult.workflows);
      // The workflow record supplies its engine and defaults once it is known; explicit draft fields still win.
      const record = findRecord(workflowResult.workflows, initialDraft?.workflowId, nextWorkflow);
      if (record) { setWorkflow(record.engine); setWorkflowId(record.id); applyRecord(record, initialDraft ?? {}, memory()); }
      setRootProfileId(current => profileResult.profiles.some(profile => profile.id === current && profile.role === "root") ? current : "");
      setWorkerProfileId(current => profileResult.profiles.some(profile => profile.id === current && profile.role === "worker") ? current : "");
      setAdvisorProfileIds(current => Object.fromEntries(Object.entries(current).filter(([, id]) => profileResult.profiles.some(profile => profile.id === id && profile.role === "root"))) as AdvisorProfileIds);
      setProjectId(current => projectResult.some(project => project.id === current) ? current : projectResult[0]?.id ?? "");
      setSettingsLoaded(true);
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "Task settings are not available"); });
    return () => { cancelled = true; };
  }, [companyId, open, initialDraft]);
  useEffect(() => {
    setTemplates([]);
    if (!projectId || !open) return;
    let cancelled = false;
    void readJsonUnchecked<{ templates: ApiTaskTemplate[] }>(`/api/projects/${projectId}/task-templates`).then(result => { if (!cancelled) setTemplates(result.templates); }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [projectId, open]);
  useEffect(() => {
    if (editing || !open || !settingsLoaded || !projects.some(project => project.id === projectId)) return;
    // Repair forces the target; remember the draft's own target instead of the forced value.
    const general = repair && previousDelivery.current ? previousDelivery.current : deliveryTarget;
    // A workflow's default agent is not a general preference: keep the earlier remembered profile instead.
    const defaults: { rootProfileId?: string | undefined; workerProfileId?: string | undefined } = workflows.find(record => record.id === workflowId) ?? {};
    const remembered = memory();
    const rootProfile = rootProfileId && rootProfileId === defaults.rootProfileId ? remembered.rootProfileId : rootProfileId || undefined;
    const workerProfile = workerProfileId && workerProfileId === defaults.workerProfileId ? remembered.workerProfileId : workerProfileId || undefined;
    writeNewTaskMemory({ projectId, rootProfileId: rootProfile, workerProfileId: workerProfile, startImmediately, deliveryTarget: general, runProjectTests, visualEvidence });
  }, [open, settingsLoaded, projects, projectId, rootProfileId, workerProfileId, startImmediately, deliveryTarget, runProjectTests, visualEvidence, repair, workflows, workflowId, editing]);
  const selectRecord = (record: ApiWorkflow) => {
    if (record.id === workflowId) return;
    const next = record.engine;
    let fallback: Delivery = { deliveryTarget, runProjectTests };
    if (next === REPAIR && workflow !== REPAIR) {
      previousDelivery.current = deliveryTarget;
      if (source?.kind !== "pull_request") { setSource(undefined); setSourceSummary(undefined); }
    } else if (workflow === REPAIR && next !== REPAIR && previousDelivery.current) {
      fallback = { deliveryTarget: previousDelivery.current, runProjectTests };
      previousDelivery.current = null;
    }
    setWorkflow(next);
    setWorkflowId(record.id);
    applyRecord(record, {}, { rootProfileId: rootProfileId || undefined, workerProfileId: workerProfileId || undefined, advisorProfileIds, visualEvidence, ...fallback });
  };
  const applyTemplate = (template: ApiTaskTemplate) => {
    setDescription(template.description); setRootProfileId(template.rootProfileId ?? ""); setWorkerProfileId(template.workerProfileId ?? "");
    setVisualEvidence(template.visualEvidence);
    if (template.workflow === REPAIR) { if (workflow !== REPAIR) previousDelivery.current = deliveryTarget; if (source?.kind !== "pull_request") { setSource(undefined); setSourceSummary(undefined); } }
    else previousDelivery.current = null;
    setDeliveryTarget(template.deliveryTarget); setRunProjectTests(template.runProjectTests);
    setWorkflow(template.workflow); setWorkflowId(findRecord(workflows, undefined, template.workflow)?.id ?? ""); setAdvisorProfileIds(admittedAdvisors(template.workflow, template.advisorProfileIds));
  };
  const missingSource = repair && source?.kind !== "pull_request";
  const submit = async () => {
    if (busy || imageRead.current.pending || !projectId || !title.trim() || missingSource) return;
    setBusy(true); setError(""); setProjectFindings([]);
    try {
      if (editTask) {
        const saved = await updateTask(editTask.id, { title, description, deliveryTarget, runProjectTests, visualEvidence, workflow, advisorProfileIds: admittedAdvisors(workflow, advisorProfileIds), ...(rootProfileId ? { rootProfileId } : {}), ...(workerProfileId ? { workerProfileId } : {}) });
        onCreated(saved);
        return;
      }
      const body = { projectId, title, description, startImmediately, deliveryTarget, runProjectTests, visualEvidence, images, workflow, advisorProfileIds: admittedAdvisors(workflow, advisorProfileIds), ...(rootProfileId ? { rootProfileId } : {}), ...(workerProfileId ? { workerProfileId } : {}), ...(sourceSummary?.kind === "issue" ? { issue: sourceSummary.issue } : {}), ...(source ? { source } : {}), ...(blockedBy.length ? { dependsOn: blockedBy.map(prerequisite => prerequisite.id) } : {}) };
      const serialized = JSON.stringify(body);
      if (request.current?.body !== serialized) request.current = { body: serialized, key: crypto.randomUUID() };
      const task = await createTask(companyId, { ...body, idempotencyKey: request.current.key });
      request.current = null;
      setTitle(""); setDescription(""); setImages([]); setSource(undefined); setSourceSummary(undefined); setBlockedBy([]);
      cacheTask(task);
      onCreated(task);
    } catch (error) {
      setError(error instanceof Error ? error.message : "Suplex could not save the task");
      if (error instanceof ApiError) setProjectFindings((error.findings ?? []).filter(finding => ["repositoryPath", "repository", "baseBranch"].includes(finding.field)).map(finding => finding.message));
    }
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
  const availableWorkflows = workflows.filter(record => (!record.archivedAt || record.id === workflowId) && (repositoryConnection?.kind !== "bitbucket" || record.engine !== REPAIR));
  const deliveryLabel = taskDeliveryTargetOptions.find(option => option.value === deliveryTarget)?.label ?? "Selected target";
  const avatarFor = (id: string | undefined) => {
    const profile = eligibleProfiles.find(profile => profile.id === id && !profile.archivedAt);
    return profile ? <EntityAvatar kind="agent" id={profile.id} name={profile.name} seed={profile.avatarSeed} size="default" /> : undefined;
  };
  const rootSelector = <TaskRoleSelector compact inline role="root" profiles={eligibleProfiles} assignment={rootProfileId} defaultProfileId={project?.rootProfileId} busy={busy} onChange={setRootProfileId} />;
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="w-[min(92vw,936px)] max-w-none gap-0 p-0 sm:max-w-[936px]" showCloseButton={false}>
      <Collapsible.Root open={workflowPreviewOpen} onOpenChange={setWorkflowPreviewOpen} className="relative min-w-0">
      <form className="max-h-[85vh] min-w-0 overflow-y-auto rounded-xl" onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length && !busy && !editing) { event.preventDefault(); void addImages(files); } }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="flex min-h-[230px] min-w-0 flex-col">
      <DialogHeader className="px-4 pt-6 pb-3 sm:px-5">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2"><Breadcrumb><BreadcrumbList className="gap-2 text-sm"><BreadcrumbItem>
          <DropdownMenu><DropdownMenuTrigger render={<Button className="pl-0" type="button" variant="ghost" size="xs" aria-label="Project" disabled={busy || editing || !projects.length} />}>
            {project ? <EntityAvatar kind="project" id={project.id} name={project.name} size="xs" /> : <FolderKanban className="size-3.5 text-muted-foreground" />}<span className="max-w-40 truncate">{project?.name ?? "Project"}</span>
          </DropdownMenuTrigger><DropdownMenuContent align="start">{projects.map(candidate => <DropdownMenuItem className="text-xs" key={candidate.id} onClick={() => { setProjectId(candidate.id); setSource(undefined); setSourceSummary(undefined); setBlockedBy([]); }}><EntityAvatar kind="project" id={candidate.id} name={candidate.name} size="xs" /><span className="min-w-0 flex-1 truncate">{candidate.name}</span>{candidate.id === projectId ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        </BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><DialogTitle className="font-normal">{editing ? "Edit task" : "New task"}</DialogTitle></BreadcrumbItem></BreadcrumbList></Breadcrumb>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-1">
          {repair ? null : <TaskSourcePicker compact onOpenTask={openTask} projectId={projectId} value={sourceSummary} disabled={busy || editing} pullRequestsOnly={repair} onClear={() => { setSource(undefined); setSourceSummary(undefined); }} onSelect={(summary, selector) => { setSource(selector); setSourceSummary(summary); const prefill = prefillForTaskSource(summary); if (!title) setTitle(prefill.title); if (!description) setDescription(prefill.description); }} />}
          {editing ? null : <Button type="button" variant="ghost" size="xs" disabled={busy || !projectId} onClick={() => setBlockedByPickerOpen(true)}><CirclePlus className="size-3.5" />Blocked by...</Button>}
          <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="xs" disabled={busy || !projectId} />}><FileText className="size-3.5" />Template</DropdownMenuTrigger><DropdownMenuContent align="end">{templates.length ? templates.map(template => <DropdownMenuItem className="text-xs" key={template.id} onClick={() => applyTemplate(template)}>{template.name}</DropdownMenuItem>) : <DropdownMenuItem className="text-xs" render={<a href={withCompany(`/projects/${encodeURIComponent(projectId)}/templates`, companyId)} />}>Open templates</DropdownMenuItem>}</DropdownMenuContent></DropdownMenu>
        </div></div>
      </DialogHeader>
        <div className="flex-1 px-5 pt-1">
          <Input aria-label="Task title" autoFocus placeholder="Task title" value={title} onChange={event => setTitle(event.target.value)} className="h-10 border-0 bg-transparent px-0 font-medium placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 data-[size=default]:text-xl data-[size=default]:md:text-xl dark:bg-transparent" />
          <Textarea aria-label="Task description" placeholder="Write a description" value={description} onChange={event => setDescription(event.target.value)} className="min-h-20 resize-none border-0 bg-transparent px-0 py-1 text-sm font-normal placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent" />
        </div>
        {error ? <div className="px-5 pb-3"><Alert variant="destructive"><AlertDescription>{error}{projectFindings.length && projectId ? <>. {projectFindings.join(". ")}. <a className="underline" href={withCompany(`/projects/${encodeURIComponent(projectId)}`, companyId)}>Open the project settings</a></> : null}</AlertDescription></Alert></div> : null}
        {!editing && images.length ? <div className="px-5 pb-3"><InlineAttachmentList attachments={images.map((image, index) => ({ id: String(index), filename: image.filename, previewUrl: `data:${image.mimeType};base64,${image.base64}` }))} onRemove={index => setImages(current => current.filter((_, item) => item !== index))} disabled={busy || readingImages} /></div> : null}
        <div className="flex flex-wrap items-center gap-2 p-6">
          {editing ? null : <InlineAttachmentPicker compact attachments={images.map((image, index) => ({ id: String(index), filename: image.filename, previewUrl: `data:${image.mimeType};base64,${image.base64}` }))} onSelect={addImages} disabled={busy || readingImages} />}
          <div className="max-w-full overflow-x-auto p-1 -m-1">
          <ButtonGroup aria-label="Task options">
          <TaskOptionFilter prefix={editing ? "Run" : <DropdownMenu>
            <DropdownMenuTrigger render={<Button type="button" variant="outline" size="sm" aria-label="Task start mode" disabled={busy} />}>{startImmediately ? <Play aria-hidden="true" className="size-[11px]" /> : <Inbox aria-hidden="true" className="size-[11px]" />}{startImmediately ? "Run" : "Backlog"}</DropdownMenuTrigger>
            <DropdownMenuContent align="start"><DropdownMenuRadioGroup value={startImmediately ? "start" : "backlog"} onValueChange={value => setStartImmediately(value === "start")}><DropdownMenuRadioItem value="start"><Play aria-hidden="true" className="size-[11px]" />Run</DropdownMenuRadioItem><DropdownMenuRadioItem value="backlog"><Inbox aria-hidden="true" className="size-[11px]" />Backlog</DropdownMenuRadioItem></DropdownMenuRadioGroup></DropdownMenuContent>
          </DropdownMenu>} label="Workflow" value={workflowId || workflow} valueLabel={workflows.find(record => record.id === workflowId)?.name ?? definition.name} disabled={busy || !availableWorkflows.length} options={availableWorkflows.map(record => ({ value: record.id, label: record.name, icon: workflowIcons[record.engine] }))} onValueChange={value => { const record = availableWorkflows.find(record => record.id === value); if (record) selectRecord(record); }} />
          {repair ? <>
            <ButtonGroupText><span className="text-muted-foreground">on</span></ButtonGroupText>
            <TaskSourcePicker compact onOpenTask={openTask} pullRequestsOnly projectId={projectId} value={sourceSummary} disabled={busy || editing} trigger={<Button type="button" variant="outline" size="sm" aria-label="Pull request">{source?.kind === "pull_request" ? <><GitPullRequest aria-hidden="true" className="size-[11px]" />{`PR #${source.number}`}</> : <><TriangleAlert aria-hidden="true" className="size-[11px] text-destructive" /><span className="text-destructive">a PR</span></>}</Button>} onClear={() => { setSource(undefined); setSourceSummary(undefined); }} onSelect={(summary, selector) => { setSource(selector); setSourceSummary(summary); const prefill = prefillForTaskSource(summary); if (!title) setTitle(prefill.title); if (!description) setDescription(prefill.description); }} />
          </> : null}
          <TaskOptionFilter prefix="with" label="Tests and proof" valueIcon={runProjectTests ? visualEvidence === "off" ? <TestTube2 aria-hidden="true" className="size-[11px]" /> : <ListChecks aria-hidden="true" className="size-[11px]" /> : visualEvidence === "off" ? <CircleOff aria-hidden="true" className="size-[11px]" /> : <ScanEye aria-hidden="true" className="size-[11px]" />} value={[...(runProjectTests ? ["tests"] : []), ...(visualEvidence !== "off" ? ["proof"] : [])]} valueLabel={[runProjectTests ? "tests" : "", visualEvidence === "off" ? "" : visualEvidence === "required" ? "necessary proof" : "proof"].filter(Boolean).join(" and ") || "no checks"} disabled={busy} options={[{ value: "tests", label: "Tests", icon: <TestTube2 aria-hidden="true" className="size-[11px]" />, disabled: !project?.verificationCommand.trim() }, { value: "proof", label: "Proof", icon: <ScanEye aria-hidden="true" className="size-[11px]" /> }]} onValueChange={values => {
            if (project?.verificationCommand.trim()) setRunProjectTests(values.includes("tests"));
            setVisualEvidence(values.includes("proof") ? visualEvidence === "required" ? "required" : "capture" : "off");
          }} />
          <TaskOptionFilter prefix="then" label="Delivery target" value={deliveryTarget} disabled={busy || repair} options={deliveryOptions.map(option => ({ value: option.value, icon: deliveryIcons[option.value], label: option.value === "pull_request_draft" ? "open a draft PR" : option.value === "pull_request_ready" ? "open a PR" : option.label.toLowerCase() }))} onValueChange={value => setDeliveryTarget(DeliveryTargetSchema.parse(value))} />
          </ButtonGroup>
          </div>
          {blockedBy.map(prerequisite => <span key={prerequisite.id} className="flex items-center gap-1 text-xs" data-blocked-by-selection><span className="max-w-40 truncate">Blocked by {prerequisite.title}</span><Button type="button" variant="ghost" size="icon-xs" aria-label={`Remove ${prerequisite.title} from Blocked by`} disabled={busy} onClick={() => setBlockedBy(current => current.filter(selected => selected.id !== prerequisite.id))}><X /></Button></span>)}
          <DialogFooter className="ml-auto flex-row items-center gap-1 sm:justify-end">{unsupportedTarget ? <span>Select a workflow that delivers a draft pull request.</span> : null}<NewButton type="submit" disabled={busy || readingImages || !projectId || !title.trim() || missingSource || unsupportedTarget} title={editing ? "Save task (⌘Enter)" : "Create task (⌘Enter)"}>{busy ? (editing ? "Saving…" : "Creating…") : editing ? "Save task" : "Create task"}</NewButton></DialogFooter>
        </div>
        </div>
        <Collapsible.Panel id="new-task-workflow-preview" keepMounted className="h-(--collapsible-panel-height) overflow-hidden transition-[height] duration-150 data-starting-style:h-0 data-ending-style:h-0 motion-reduce:transition-none">
        <section aria-label="Workflow preview" className="min-w-0 bg-muted/45 px-2 pb-5 pt-3 dark:bg-black/25 sm:px-3">
          {repair && !missingSource ? <p className="mx-auto mb-1 max-w-xl text-center text-xs text-muted-foreground" data-repair-note>{repairNote}</p> : null}
          <WorkflowIllustration workflow={workflow} delivery={repair ? "Merged pull request" : deliveryLabel} pullRequestNumber={source?.kind === "pull_request" ? source.number : editTask?.pullRequest?.number} avatars={{
            root: avatarFor(rootProfileId || project?.rootProfileId),
            worker: avatarFor(workerProfileId || project?.workerProfileId),
            ...Object.fromEntries(definition.advisorRoles.map(role => [role, avatarFor(advisorProfileIds[role] || (role === "planner_a" ? rootProfileId || project?.rootProfileId : project?.altProfileId))])),
          }} agents={{
            root: rootSelector,
            worker: <TaskRoleSelector compact inline role="worker" profiles={eligibleProfiles} assignment={workerProfileId} defaultProfileId={project?.workerProfileId} busy={busy} onChange={setWorkerProfileId} />,
            ...Object.fromEntries(definition.advisorRoles.map(role => [role, <TaskRoleSelector compact inline role="root" label={ADVISOR_LABELS[role]} profiles={eligibleProfiles} assignment={advisorProfileIds[role] ?? ""} defaultProfileId={role === "planner_a" ? rootProfileId || project?.rootProfileId : project?.altProfileId} defaultChoiceLabel={ADVISOR_DEFAULT_LABELS[role]} busy={busy} onChange={profileId => setAdvisorProfileIds(current => ({ ...current, [role]: profileId || undefined }))} />])),
          }} />
        </section>
        </Collapsible.Panel>
      </form>
        <div className="absolute -bottom-3.5 left-1/2 -translate-x-1/2">
          <Collapsible.Trigger aria-label={workflowPreviewOpen ? "Hide workflow preview" : "Show workflow preview"} render={<Button type="button" variant="outline" size="icon-sm" className="bg-background! rounded-full shadow-sm w-7 h-7" />}>
            <ChevronDown aria-hidden="true" className="size-3.5 transition-transform in-data-panel-open:rotate-180" />
          </Collapsible.Trigger>
        </div>
      </Collapsible.Root>
    </DialogContent>
    <BlockedByPickerDialog open={blockedByPickerOpen} onOpenChange={setBlockedByPickerOpen} companyId={companyId} projectId={projectId} excludeTaskIds={blockedBy.map(prerequisite => prerequisite.id)} onSelect={selected => setBlockedBy(current => [...current, selected])} onError={setError} />
  </Dialog>;
}
