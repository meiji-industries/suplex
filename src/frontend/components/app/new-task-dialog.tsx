import { useEffect, useRef, useState, type ReactElement } from "react";
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
import { TaskSourcePicker, prefillForTaskSource, type TaskSourceSelector, type TaskSourceSummary } from "./task-source-picker.js";
import { taskDeliveryTargetOptions } from "./task-delivery-target.js";

export function NewTaskDialog({ open, onOpenChange, companyId, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; companyId: string; onCreated: (task: Task) => void }): ReactElement {
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const [projectId, setProjectId] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [rootProfileId, setRootProfileId] = useState("");
  const [workerProfileId, setWorkerProfileId] = useState("");
  const [startImmediately, setStartImmediately] = useState(true);
  const [deliveryTarget, setDeliveryTarget] = useState<NonNullable<TaskInput["deliveryTarget"]>>("pull_request_draft");
  const [runProjectTests, setRunProjectTests] = useState(true);
  const [visualEvidence, setVisualEvidence] = useState<NonNullable<TaskInput["visualEvidence"]>>("off");
  const [source, setSource] = useState<TaskSourceSelector>();
  const [sourceSummary, setSourceSummary] = useState<TaskSourceSummary>();
  const [images, setImages] = useState<NonNullable<TaskInput["images"]>>([]);
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
  const submit = async () => {
    if (busy || imageRead.current.pending) return;
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
  return <Dialog open={open} onOpenChange={value => { if (!busy) onOpenChange(value); }}><DialogContent><DialogHeader><DialogTitle>Create task</DialogTitle></DialogHeader>
    <form className="grid gap-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
      <div className="grid max-h-[60dvh] gap-3 overflow-y-auto">
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <label className="grid gap-1 text-xs">Project<Select value={projectId} onValueChange={value => { setProjectId(value ?? ""); setSource(undefined); setSourceSummary(undefined); }}><SelectTrigger aria-label="Project"><SelectValue /></SelectTrigger><SelectContent>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select></label>
      {templates.length ? <Select onValueChange={id => { const template = templates.find(template => template.id === id); if (!template) return; setDescription(template.description); setRootProfileId(template.rootProfileId ?? ""); setWorkerProfileId(template.workerProfileId ?? ""); setDeliveryTarget(template.deliveryTarget); setRunProjectTests(template.runProjectTests); setVisualEvidence(template.visualEvidence); }}><SelectTrigger aria-label="Template"><SelectValue placeholder="Select a template" /></SelectTrigger><SelectContent>{templates.map(template => <SelectItem key={template.id} value={template.id}>{template.name}</SelectItem>)}</SelectContent></Select> : null}
      <TaskSourcePicker projectId={projectId} value={sourceSummary} onClear={() => { setSource(undefined); setSourceSummary(undefined); }} onSelect={(summary, selector) => { setSource(selector); setSourceSummary(summary); const prefill = prefillForTaskSource(summary); if (!title) setTitle(prefill.title); if (!description) setDescription(prefill.description); }} />
      <label className="grid gap-1 text-xs">Title<Input aria-label="Title" value={title} onChange={event => setTitle(event.target.value)} required /></label>
      <label className="grid gap-1 text-xs">Description<Textarea aria-label="Description" value={description} rows={5} onChange={event => setDescription(event.target.value)} required /></label>
      <InlineAttachmentPicker attachments={images.map((image, index) => ({ id: String(index), filename: image.filename }))} onSelect={addImages} onRemove={index => setImages(current => current.filter((_, item) => item !== index))} disabled={busy || readingImages} />
      <div className="grid gap-3 sm:grid-cols-2">{([{ role: "Root", value: rootProfileId, change: setRootProfileId }, { role: "Worker", value: workerProfileId, change: setWorkerProfileId }]).map(field => <label key={field.role} className="grid gap-1 text-xs">{field.role}<Select value={field.value || "default"} onValueChange={value => field.change(value === "default" ? "" : value ?? "")}><SelectTrigger aria-label={`${field.role} profile`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Project default</SelectItem>{profiles.filter(profile => profile.role === field.role.toLowerCase()).map(profile => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.provider}/{profile.model}</SelectItem>)}</SelectContent></Select></label>)}</div>
      <label className="grid gap-1 text-xs">Delivery target<Select value={deliveryTarget} onValueChange={value => setDeliveryTarget(DeliveryTargetSchema.parse(value))}><SelectTrigger aria-label="Delivery target"><SelectValue /></SelectTrigger><SelectContent>{taskDeliveryTargetOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>
      <label className="grid gap-1 text-xs">Browser evidence<Select value={visualEvidence} onValueChange={value => setVisualEvidence(VisualEvidenceSchema.parse(value))}><SelectTrigger aria-label="Browser evidence"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Necessary</SelectItem></SelectContent></Select></label>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={runProjectTests} onCheckedChange={value => setRunProjectTests(value === true)} />Run project tests</label>
      </div>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={startImmediately} onCheckedChange={value => setStartImmediately(value === true)} />Start immediately</label>
      <DialogFooter><Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>Cancel</Button><Button type="submit" disabled={busy || readingImages || !projectId || !title.trim() || !description.trim()}>{busy ? "Forge creates the task" : "Create task"}</Button></DialogFooter>
    </form>
  </DialogContent></Dialog>;
}
