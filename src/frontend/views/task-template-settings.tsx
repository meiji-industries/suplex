import { useEffect, useState, type ReactElement } from "react";
import type { TaskTemplateInput } from "../../task-templates.js";
import { DeliveryTargetSchema, VisualEvidenceSchema } from "../../task-contracts.js";
import { SettingsLayout } from "../components/app/settings-layout.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { taskDeliveryTargetOptions } from "../components/app/task-delivery-target.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Input } from "../components/ui/input.js";
import { Textarea } from "../components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { readJson, withCompany } from "../lib/api.js";
import type { ApiProfile, ApiTaskTemplate } from "../lib/view-shared.js";

const empty = (): TaskTemplateInput => ({ name: "", description: "", deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });

export function TaskTemplateSettings({ projectId }: { projectId: string }): ReactElement {
  const companyId = useCompanyContext().currentCompany?.id ?? "";
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [draft, setDraft] = useState<TaskTemplateInput>(empty);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let closed = false;
    setTemplates([]); setSelected(null); setDraft(empty()); setError("");
    void Promise.all([readJson<{ templates: ApiTaskTemplate[] }>(`/api/projects/${projectId}/task-templates`), readJson<{ profiles: ApiProfile[] }>("/api/profiles")]).then(([result, models]) => { if (!closed) { setTemplates(result.templates); setProfiles(models.profiles); } }).catch(error => { if (!closed) setError(String(error)); });
    return () => { closed = true; };
  }, [projectId]);
  const save = async () => {
    setBusy(true); setError("");
    try {
      const result = await readJson<ApiTaskTemplate>(selected ? `/api/task-templates/${selected}` : `/api/projects/${projectId}/task-templates`, { method: selected ? "PATCH" : "POST", body: JSON.stringify(selected ? { ...draft, rootProfileId: draft.rootProfileId ?? null, workerProfileId: draft.workerProfileId ?? null } : draft) });
      setTemplates(current => [...current.filter(template => template.id !== result.id), result]); setSelected(result.id);
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selected) return;
    setBusy(true);
    try { await readJson(`/api/task-templates/${selected}`, { method: "DELETE" }); setTemplates(current => current.filter(template => template.id !== selected)); setSelected(null); setDraft(empty()); }
    catch (error) { setError(String(error)); } finally { setBusy(false); }
  };
  return <SettingsLayout title="Task templates" companyId={companyId} backHref={withCompany("/projects", companyId)} activeHref={withCompany(`/projects/${projectId}/templates`, companyId)}>
    <div className="grid min-w-0 gap-4 p-3 md:grid-cols-[16rem_minmax(0,1fr)]"><section className="grid content-start gap-2"><Button variant="outline" onClick={() => { setSelected(null); setDraft(empty()); }}>Create template</Button>{templates.map(template => <Button key={template.id} variant={selected === template.id ? "secondary" : "ghost"} onClick={() => { setSelected(template.id); setDraft({ name: template.name, description: template.description, deliveryTarget: template.deliveryTarget, runProjectTests: template.runProjectTests, visualEvidence: template.visualEvidence, ...(template.rootProfileId ? { rootProfileId: template.rootProfileId } : {}), ...(template.workerProfileId ? { workerProfileId: template.workerProfileId } : {}) }); }}>{template.name}</Button>)}</section>
    <form className="grid min-w-0 content-start gap-3" onSubmit={event => { event.preventDefault(); void save(); }}>{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <label className="grid gap-1 text-xs">Name<Input aria-label="Template name" value={draft.name} onChange={event => setDraft(current => ({ ...current, name: event.target.value }))} required /></label>
      <label className="grid gap-1 text-xs">Description<Textarea aria-label="Template description" value={draft.description} onChange={event => setDraft(current => ({ ...current, description: event.target.value }))} rows={8} required /></label>
      {(["rootProfileId", "workerProfileId"] as const).map(key => <label key={key} className="grid gap-1 text-xs">{key === "rootProfileId" ? "Root" : "Worker"}<Select value={draft[key] ?? "default"} onValueChange={value => setDraft(current => ({ ...current, [key]: value === "default" ? undefined : value ?? undefined }))}><SelectTrigger aria-label={key === "rootProfileId" ? "Root profile" : "Worker profile"}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Project default</SelectItem>{profiles.filter(profile => profile.role === (key === "rootProfileId" ? "root" : "worker")).map(profile => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.provider}/{profile.model}</SelectItem>)}</SelectContent></Select></label>)}
      <label className="grid gap-1 text-xs">Delivery target<Select value={draft.deliveryTarget} onValueChange={value => setDraft(current => ({ ...current, deliveryTarget: DeliveryTargetSchema.parse(value) }))}><SelectTrigger aria-label="Delivery target"><SelectValue /></SelectTrigger><SelectContent>{taskDeliveryTargetOptions.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>
      <label className="grid gap-1 text-xs">Browser evidence<Select value={draft.visualEvidence} onValueChange={value => setDraft(current => ({ ...current, visualEvidence: VisualEvidenceSchema.parse(value) }))}><SelectTrigger aria-label="Browser evidence"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Necessary</SelectItem></SelectContent></Select></label>
      <label className="flex items-center gap-2 text-xs"><Checkbox checked={draft.runProjectTests ?? true} onCheckedChange={value => setDraft(current => ({ ...current, runProjectTests: value === true }))} />Run project tests</label>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>Save template</Button>{selected ? <Button type="button" variant="outline" disabled={busy} onClick={() => void remove()}>Delete template</Button> : null}</div>
    </form></div>
  </SettingsLayout>;
}
