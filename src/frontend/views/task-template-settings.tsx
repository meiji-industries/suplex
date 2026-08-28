import { useEffect, useMemo, useState, type ReactElement } from "react";

import { TaskRoleSelectors, type TaskRoleAssignments } from "../components/app/task-role-selectors.js";
import { taskDeliveryTargetOptions } from "../components/app/task-delivery-target.js";
import { TaskSourcePicker, type TaskSourceSelector, type TaskSourceSummary } from "../components/app/task-source-picker.js";
import { SettingsLayout } from "../components/app/settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, type SettingsTableColumn } from "../components/app/settings-table.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Input } from "../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Textarea } from "../components/ui/textarea.js";
import { isApiError, readJson, withCompany } from "../lib/api.js";
import { relativeTime, type ApiAgent, type ApiTaskTemplate } from "../lib/view-shared.js";

const COLUMNS: SettingsTableColumn[] = [{ key: "name", label: "Name", width: 230 }, { key: "delivery", label: "Delivery target", width: 150 }, { key: "source", label: "Source", width: 140 }, { key: "roles", label: "Role agents", width: 210 }, { key: "updated", label: "Updated", width: 120 }];
type Draft = Omit<ApiTaskTemplate, "id" | "projectId" | "createdAt" | "updatedAt">;

const blankDraft = (): Draft => ({ name: "", description: "", roleAgents: {}, supplementalReview: false, autoApprovePlan: false, deliveryTarget: "pull_request_draft", runProjectTests: true, visualEvidence: "off" });
const sourceSummary = (source: Draft["source"]): TaskSourceSummary | undefined => source?.kind === "pull_request" ? { kind: "pull_request", number: source.number, title: `Pull request #${source.number}`, body: "", author: "", headBranch: "", baseBranch: "", isDraft: false } : source?.kind === "branch" ? { kind: "branch", branch: source.branch, headSha: "", subject: source.branch, author: "" } : undefined;
const sourceLabel = (source: Draft["source"]): string => source?.kind === "pull_request" ? `PR #${source.number}` : source?.kind === "branch" ? source.branch : "—";
const roleSummary = (roles: TaskRoleAssignments): string => Object.entries(roles).filter(([, agent]) => agent).map(([role, agent]) => `${role}: ${agent}`).join(" · ") || "—";

function TemplateEditor({ template, projectId, agents, onSaved, onDeleted }: { template: ApiTaskTemplate | undefined; projectId: string; agents: ApiAgent[]; onSaved: (template: ApiTaskTemplate, created: boolean) => void; onDeleted: (id: string) => void }): ReactElement {
  const created = !template;
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [nameError, setNameError] = useState("");
  useEffect(() => { setDraft(template ? { name: template.name, description: template.description, roleAgents: template.roleAgents, supplementalReview: template.supplementalReview, autoApprovePlan: template.autoApprovePlan, deliveryTarget: template.deliveryTarget, runProjectTests: template.runProjectTests, visualEvidence: template.visualEvidence, ...(template.source ? { source: template.source } : {}) } : blankDraft()); setError(""); setNameError(""); }, [template?.id]);
  const set = <Key extends keyof Draft>(key: Key, value: Draft[Key]): void => setDraft((current) => ({ ...current, [key]: value }));
  const save = async (): Promise<void> => {
    setBusy(true); setError(""); setNameError("");
    try {
      const url = template ? `/api/task-templates/${encodeURIComponent(template.id)}` : `/api/projects/${encodeURIComponent(projectId)}/task-templates`;
      const saved = await readJson<ApiTaskTemplate>(url, { method: template ? "PATCH" : "POST", body: JSON.stringify(draft) });
      onSaved(saved, created);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Unable to save template.";
      const finding = isApiError(reason) ? reason.findings?.find((item) => item.field === "name") : undefined;
      if (finding) setNameError(finding.message || message || "Template name is already in use"); else setError(message);
    }
    finally { setBusy(false); }
  };
  const remove = async (): Promise<void> => {
    if (!template || !window.confirm(`Delete template “${template.name}”?`)) return;
    setBusy(true); setError("");
    try { await readJson(`/api/task-templates/${encodeURIComponent(template.id)}`, { method: "DELETE" }); onDeleted(template.id); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to delete template."); }
    finally { setBusy(false); }
  };
  return <section aria-label="Template editor" className="min-w-0 border-t p-4 lg:border-l lg:border-t-0">
    <div className="space-y-3">
      <label className="grid gap-1 text-xs font-medium">Name<Input aria-describedby={nameError ? "template-name-error" : undefined} aria-label="Name" value={draft.name} onChange={(event) => set("name", event.target.value)} />{nameError ? <span className="text-destructive" id="template-name-error">{nameError}</span> : null}</label>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <label className="grid gap-1 text-xs font-medium">Description<Textarea aria-label="Description" value={draft.description} onChange={(event) => set("description", event.target.value)} /></label>
      <label className="grid gap-1 text-xs font-medium">Delivery target<Select value={draft.deliveryTarget} onValueChange={(value) => set("deliveryTarget", value as Draft["deliveryTarget"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{taskDeliveryTargetOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></label>
      <div className="flex flex-wrap gap-2"><TaskRoleSelectors agents={agents} assignments={draft.roleAgents} deliveryTarget={draft.deliveryTarget} supplementalReview={draft.supplementalReview} busy={busy} onChange={(role, agentId) => set("roleAgents", { ...draft.roleAgents, [role]: agentId })} /></div>
      <div className="grid gap-2 text-xs"><label className="flex items-center gap-2"><Checkbox checked={draft.runProjectTests} onCheckedChange={(checked) => set("runProjectTests", checked === true)} />Run project tests</label><label className="flex items-center gap-2"><Checkbox checked={draft.supplementalReview} onCheckedChange={(checked) => set("supplementalReview", checked === true)} />Supplemental review</label><label className="flex items-center gap-2"><Checkbox checked={draft.autoApprovePlan} onCheckedChange={(checked) => set("autoApprovePlan", checked === true)} />Auto-approve plan</label></div>
      <label className="grid gap-1 text-xs font-medium">Visual evidence<Select value={draft.visualEvidence} onValueChange={(value) => set("visualEvidence", value as Draft["visualEvidence"])}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Required</SelectItem></SelectContent></Select></label>
      <div className="grid gap-1 text-xs font-medium"><span>Source</span><TaskSourcePicker projectId={projectId} value={sourceSummary(draft.source)} disabled={busy} onSelect={(_summary, selector: TaskSourceSelector) => set("source", selector)} onClear={() => set("source", undefined)} /></div>
      <div className="flex gap-2"><Button type="button" size="sm" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save"}</Button>{template ? <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void remove()}>Delete</Button> : null}</div>
    </div>
  </section>;
}

export function TaskTemplateSettings({ projectId }: { projectId: string }): ReactElement {
  const { currentCompany } = useCompanyContext();
  const [templates, setTemplates] = useState<ApiTaskTemplate[]>([]);
  const [agents, setAgents] = useState<ApiAgent[]>([]);
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const reload = async (): Promise<void> => { const [list, agentList] = await Promise.all([readJson<{ templates: ApiTaskTemplate[] }>(`/api/projects/${encodeURIComponent(projectId)}/task-templates`), readJson<{ agents: ApiAgent[] }>("/api/agents")]); setTemplates(list.templates); setAgents(agentList.agents); };
  useEffect(() => { void reload().catch(() => setError("Task templates are unavailable.")); }, [projectId]);
  const visible = useMemo(() => templates.filter((template) => template.name.toLowerCase().includes(search.toLowerCase())), [search, templates]);
  const active = templates.find((template) => template.id === selected);
  const upsert = (saved: ApiTaskTemplate, wasCreated: boolean): void => { setTemplates((current) => wasCreated ? [...current, saved].sort((a, b) => a.name.localeCompare(b.name)) : current.map((item) => item.id === saved.id ? saved : item)); setSelected(saved.id); setCreating(false); };
  const remove = (id: string): void => { setTemplates((current) => current.filter((item) => item.id !== id)); setSelected(undefined); };
  return <SettingsLayout title="Project templates" companyId={currentCompany?.id ?? ""} backHref={withCompany("/projects", currentCompany?.id)} activeHref={withCompany(`/projects/${encodeURIComponent(projectId)}/templates`, currentCompany?.id)}>
    <SettingsToolbar actions={<Button size="sm" onClick={() => { setSelected(undefined); setCreating(true); }}>New template</Button>} filterLabel="All templates" searchLabel="Search templates" searchPlaceholder="Search templates" searchValue={search} onSearchChange={setSearch} />
    {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
    <div className="mt-5 grid min-w-0 lg:grid-cols-[minmax(0,1fr)_360px]">
      <SettingsDataTable label="Task templates" columns={COLUMNS}><SettingsTableGroup label="Templates" count={visible.length} columnCount={COLUMNS.length}>{visible.length === 0 ? <SettingsTableEmpty columnCount={COLUMNS.length}>No task templates.</SettingsTableEmpty> : visible.map((template) => <SettingsTableRow className={template.id === selected ? "[&>td]:bg-black/[0.04]" : undefined} key={template.id} onClick={() => { setCreating(false); setSelected(template.id); }} tabIndex={0}><SettingsTableCell>{template.name}</SettingsTableCell><SettingsTableCell>{taskDeliveryTargetOptions.find((option) => option.value === template.deliveryTarget)?.label}</SettingsTableCell><SettingsTableCell>{sourceLabel(template.source)}</SettingsTableCell><SettingsTableCell className="truncate text-muted-foreground">{roleSummary(template.roleAgents)}</SettingsTableCell><SettingsTableCell className="text-muted-foreground">{template.updatedAt ? relativeTime(template.updatedAt) : relativeTime(template.createdAt)}</SettingsTableCell></SettingsTableRow>)}</SettingsTableGroup></SettingsDataTable>
      {active || creating ? <TemplateEditor key={active?.id ?? "new"} template={active} projectId={projectId} agents={agents} onSaved={upsert} onDeleted={remove} /> : <section aria-label="Template editor" className="border-t p-4 text-xs text-muted-foreground lg:border-l lg:border-t-0">Select a template to edit it.</section>}
    </div>
  </SettingsLayout>;
}
