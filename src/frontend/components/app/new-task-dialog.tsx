import { useEffect, useRef, useState, type ReactElement } from "react";
import { ChevronDown, FileText, FolderKanban } from "lucide-react";
import { TaskImageInputSchema, DeliveryTargetSchema, VisualEvidenceSchema, type Task, type TaskInput } from "../../../task-contracts.js";
import type { ApiProfile, ApiProject, ApiTaskTemplate } from "../../lib/view-shared.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../ui/button.js";
import { Checkbox } from "../ui/checkbox.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../ui/dialog.js";
import { Input } from "../ui/input.js";
import { Textarea } from "../ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select.js";
import { InlineAttachmentPicker } from "../ui/inline-attachment-picker.js";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Avatar, AvatarFallback, AvatarImage } from "../ui/avatar.js";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from "../ui/breadcrumb.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group.js";
import { TaskSourcePicker, prefillForTaskSource, type TaskSourceSelector, type TaskSourceSummary } from "./task-source-picker.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";
import { readNewTaskMemory, writeNewTaskMemory } from "./new-task-memory.js";
import { TaskRoleSelector } from "./task-role-selectors.js";
import type { NewTaskDraft } from "../../lib/duplicate-task-prefill.js";

export function NewTaskDialog({ open, onOpenChange, companyId, onCreated, initialDraft }: { open: boolean; onOpenChange: (open: boolean) => void; companyId: string; onCreated: (task: Task) => void; initialDraft?: NewTaskDraft }): ReactElement {
  const [remembered] = useState(readNewTaskMemory);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const [projectId, setProjectId] = useState(initialDraft?.projectId ?? remembered.projectId ?? "");
  const [title, setTitle] = useState(initialDraft?.title ?? "");
  const [description, setDescription] = useState(initialDraft?.description ?? "");
  const [rootProfileId, setRootProfileId] = useState(initialDraft?.rootProfileId ?? remembered.rootProfileId ?? "");
  const [workerProfileId, setWorkerProfileId] = useState(initialDraft?.workerProfileId ?? remembered.workerProfileId ?? "");
  const [startImmediately, setStartImmediately] = useState(initialDraft?.startImmediately ?? remembered.startImmediately ?? true);
  const [deliveryTarget, setDeliveryTarget] = useState<NonNullable<TaskInput["deliveryTarget"]>>(initialDraft?.deliveryTarget ?? remembered.deliveryTarget ?? "pull_request_draft");
  const [runProjectTests, setRunProjectTests] = useState(initialDraft?.runProjectTests ?? remembered.runProjectTests ?? true);
  const [visualEvidence, setVisualEvidence] = useState<NonNullable<TaskInput["visualEvidence"]>>(initialDraft?.visualEvidence ?? remembered.visualEvidence ?? "off");
  const [source, setSource] = useState<TaskSourceSelector | undefined>(initialDraft?.source);
  const [sourceSummary, setSourceSummary] = useState<TaskSourceSummary | undefined>(initialDraft?.sourceSummary);
  const [images, setImages] = useState<NonNullable<TaskInput["images"]>>(initialDraft?.images ?? []);
  const [busy, setBusy] = useState(false);
  const [readingImages, setReadingImages] = useState(false);
  const imageRead = useRef({ generation: 0, pending: false });
  const [error, setError] = useState("");
  const request = useRef<{ body: string; key: string } | null>(null);
  useEffect(() => {
    imageRead.current = { generation: imageRead.current.generation + 1, pending: false };
    setReadingImages(false);
  }, [companyId, open]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([readJson<{ projects: ApiProject[] }>(`/api/companies/${companyId}/projects`), readJson<{ profiles: ApiProfile[] }>("/api/profiles")]).then(([projectResult, profileResult]) => {
      if (cancelled) return;
      setProjects(projectResult.projects); setProfiles(profileResult.profiles);
      setRootProfileId(current => profileResult.profiles.some(profile => profile.id === current && profile.role === "root") ? current : "");
      setWorkerProfileId(current => profileResult.profiles.some(profile => profile.id === current && profile.role === "worker") ? current : "");
      setProjectId(current => projectResult.projects.some(project => project.id === current) ? current : projectResult.projects[0]?.id ?? "");
    }).catch(error => { if (!cancelled) setError(error instanceof Error ? error.message : "Task settings are not available"); });
    return () => { cancelled = true; };
  }, [companyId, open]);
  useEffect(() => {
    setTemplates([]);
    if (!projectId || !open) return;
    let cancelled = false;
    void readJson<{ templates: ApiTaskTemplate[] }>(`/api/projects/${projectId}/task-templates`).then(result => { if (!cancelled) setTemplates(result.templates); }).catch(error => { if (!cancelled) setError(String(error)); });
    return () => { cancelled = true; };
  }, [projectId, open]);
  useEffect(() => {
    if (!open || !projects.some(project => project.id === projectId)) return;
    writeNewTaskMemory({ projectId, rootProfileId: rootProfileId || undefined, workerProfileId: workerProfileId || undefined, startImmediately, deliveryTarget, runProjectTests, visualEvidence });
  }, [open, projects, projectId, rootProfileId, workerProfileId, startImmediately, deliveryTarget, runProjectTests, visualEvidence]);
  const submit = async () => {
    if (busy || imageRead.current.pending || !projectId || !title.trim() || !description.trim()) return;
    setBusy(true); setError("");
    try {
      const body = { projectId, title, description, startImmediately, deliveryTarget, runProjectTests, visualEvidence, images, ...(rootProfileId ? { rootProfileId } : {}), ...(workerProfileId ? { workerProfileId } : {}), ...(source ? { source } : {}) };
      const serialized = JSON.stringify(body);
      if (request.current?.body !== serialized) request.current = { body: serialized, key: crypto.randomUUID() };
      const task = await readJson<Task>(`/api/companies/${companyId}/tasks`, { method: "POST", body: JSON.stringify({ ...body, idempotencyKey: request.current.key }) });
      request.current = null;
      setTitle(""); setDescription(""); setImages([]); setSource(undefined); setSourceSummary(undefined);
      onCreated(task);
    } catch (error) { setError(error instanceof Error ? error.message : "Forge could not create the task"); }
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
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}>
    <DialogContent className="max-h-[min(85vh,420px)] w-[min(92vw,936px)] max-w-none gap-0 overflow-y-auto rounded-xl p-0 shadow-2xl sm:max-w-[936px]" showCloseButton={false}>
      <DialogHeader className="flex-row items-center justify-between px-4 py-3 sm:px-5">
        <Breadcrumb><BreadcrumbList className="gap-2 text-sm"><BreadcrumbItem>
          <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" aria-label="Project" disabled={busy || !projects.length} />}>
            {project ? <Avatar size="xs" shape="square"><AvatarImage src={`/api/projects/${project.id}/favicon`} alt="" /><AvatarFallback>{project.name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar> : <FolderKanban className="size-3.5 text-muted-foreground" />}<span className="max-w-40 truncate">{project?.name ?? "Project"}</span><ChevronDown className="size-3.5" />
          </DropdownMenuTrigger><DropdownMenuContent align="start">{projects.map(candidate => <DropdownMenuItem key={candidate.id} onClick={() => { setProjectId(candidate.id); setSource(undefined); setSourceSummary(undefined); }}><Avatar size="xs" shape="square"><AvatarImage src={`/api/projects/${candidate.id}/favicon`} alt="" /><AvatarFallback>{candidate.name.slice(0, 1).toUpperCase()}</AvatarFallback></Avatar><span className="min-w-0 flex-1 truncate">{candidate.name}</span>{candidate.id === projectId ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
        </BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><DialogTitle className="font-normal">New task</DialogTitle></BreadcrumbItem></BreadcrumbList></Breadcrumb>
        <div className="flex items-center gap-1"><TaskSourcePicker projectId={projectId} value={sourceSummary} disabled={busy} onClear={() => { setSource(undefined); setSourceSummary(undefined); }} onSelect={(summary, selector) => { setSource(selector); setSourceSummary(summary); const prefill = prefillForTaskSource(summary); if (!title) setTitle(prefill.title); if (!description) setDescription(prefill.description); }} />
          {templates.length ? <DropdownMenu><DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={busy} />}><FileText className="size-3.5" />Template</DropdownMenuTrigger><DropdownMenuContent align="end">{templates.map(template => <DropdownMenuItem key={template.id} onClick={() => { setDescription(template.description); setRootProfileId(template.rootProfileId ?? ""); setWorkerProfileId(template.workerProfileId ?? ""); setDeliveryTarget(template.deliveryTarget); setRunProjectTests(template.runProjectTests); setVisualEvidence(template.visualEvidence); }}>{template.name}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu> : null}
        </div>
      </DialogHeader>
      <form className="flex min-h-[310px] flex-col" onPaste={event => { const files = Array.from(event.clipboardData.files); if (files.length && !busy) { event.preventDefault(); void addImages(files); } }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={event => { event.preventDefault(); void submit(); }}>
        <div className="px-5 pt-1">
          <Input aria-label="Task title" autoFocus placeholder="Task title" value={title} onChange={event => setTitle(event.target.value)} className="h-10 border-0 bg-transparent px-0 text-xl font-medium placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-xl" />
          <Textarea aria-label="Task description" placeholder="Write a description" value={description} onChange={event => setDescription(event.target.value)} className="min-h-20 resize-none border-0 bg-transparent px-0 py-1 text-sm shadow-none focus-visible:ring-0" />
        </div>
        {error ? <div className="px-5 pb-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        <div className="mt-auto flex flex-wrap items-end gap-2 px-5 pb-4">
          <InlineAttachmentPicker compact attachments={images.map((image, index) => ({ id: String(index), filename: image.filename, previewUrl: `data:${image.mimeType};base64,${image.base64}` }))} onSelect={addImages} onRemove={index => setImages(current => current.filter((_, item) => item !== index))} disabled={busy || readingImages} />
          <TaskRoleSelector role="root" profiles={profiles} assignment={rootProfileId} defaultProfileId={project?.rootProfileId} busy={busy} onChange={setRootProfileId} />
          <TaskRoleSelector role="worker" profiles={profiles} assignment={workerProfileId} defaultProfileId={project?.workerProfileId} busy={busy} onChange={setWorkerProfileId} />
          <DialogFooter className="ml-auto flex-row items-center gap-2 sm:justify-end"><Button type="submit" size="sm" disabled={busy || readingImages || !projectId || !title.trim() || !description.trim()} title="Create task (⌘Enter)">{busy ? "Forge saves" : "Create task"}</Button></DialogFooter>
        </div>
        <fieldset className="border-t border-border/70 bg-muted/30 px-5 py-3"><legend className="px-0 text-xs font-medium text-muted-foreground">Delivery &amp; checks</legend>
          <RadioGroup aria-label="Delivery target" value={deliveryTarget} onValueChange={value => setDeliveryTarget(DeliveryTargetSchema.parse(value))} className="mt-2.5 flex flex-wrap gap-x-4 gap-y-2">{taskDeliveryTargetOptions.map(option => <label className="flex items-center gap-1.5 text-xs" key={option.value}><RadioGroupItem value={option.value} />{option.label}</label>)}</RadioGroup>
          <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border/60 pt-2.5 text-xs">
            <label className="flex cursor-pointer items-center gap-2"><Checkbox checked={startImmediately} onCheckedChange={value => setStartImmediately(value === true)} />Start immediately</label>
            {project?.verificationCommand.trim() ? <label className="flex items-center gap-2"><Checkbox checked={runProjectTests} onCheckedChange={value => setRunProjectTests(value === true)} />Run project tests</label> : <span className="text-muted-foreground">No project test command configured.</span>}
            <label className="flex items-center gap-2">Screenshots<Select value={visualEvidence} onValueChange={value => setVisualEvidence(VisualEvidenceSchema.parse(value))}><SelectTrigger aria-label="Screenshots" size="sm"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Necessary</SelectItem></SelectContent></Select></label>
          </div>
        </fieldset>
      </form>
    </DialogContent>
  </Dialog>;
}
