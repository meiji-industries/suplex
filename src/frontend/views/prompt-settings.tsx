import { Lock, RotateCcw, Save, Search } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../components/ui/select.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui/tabs.js";
import { Textarea } from "../components/ui/textarea.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, type SettingsTableColumn } from "../components/app/settings-table.js";
import { SettingsLayout } from "../components/app/settings-layout.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { readJson, withCompany } from "../lib/api.js";

type Mode = "inherit" | "append" | "replace";
type Step = { layer: "system" | "global" | "project"; mode: Mode; revision?: number };
type Template = { id: string; category: "agent" | "shared"; archetype: string; title: string; editable: boolean; variables: string[]; guidance: string; contract: string | null; override: { mode: Mode; content: string; currentRevision: number } | null; resolved: { guidance: string; steps: Step[]; staleReplace: boolean }; revisions: Array<{ revision: number; mode: Mode; content: string; actor_user_id: string; note: string | null; created_at: string }> };

const COLUMNS: SettingsTableColumn[] = [{ key: "title", label: "Title", width: 260 }, { key: "id", label: "Template id", width: 220 }, { key: "mode", label: "Mode", width: 100 }, { key: "status", label: "Status", width: 130 }, { key: "updated", label: "Updated", width: 160 }];
const FILTERS = ["All", "Agent", "Shared", "Overridden", "Warnings"] as const;

function templateUrl(id: string, scope: "global" | "project", projectId?: string): string { return `/api/prompts/templates/${encodeURIComponent(id)}?scope=${scope}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`; }

function modeFor(template: Template): Mode { return template.override?.mode ?? "inherit"; }

export function PromptSettings({ scope = "global", projectId }: { scope?: "global" | "project"; projectId?: string }): ReactElement {
  const { currentCompany } = useCompanyContext();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState<(typeof FILTERS)[number]>("All");
  const [search, setSearch] = useState("");
  const [draft, setDraft] = useState<{ mode: Mode; content: string; note: string }>({ mode: "inherit", content: "", note: "" });
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const active = templates.find((template) => template.id === selected);
  const reload = async (): Promise<void> => {
    const response = await readJson<{ templates: Template[] }>(`/api/prompts/templates?scope=${scope}${projectId ? `&projectId=${encodeURIComponent(projectId)}` : ""}`);
    setTemplates(response.templates);
  };
  useEffect(() => { void reload().catch(() => setError("Prompt templates are unavailable.")); }, []);
  useEffect(() => { if (active) setDraft({ mode: modeFor(active), content: active.override?.content ?? "", note: "" }); }, [active?.id, active?.override?.currentRevision]);
  const visible = useMemo(() => templates.filter((template) => {
    const warning = template.resolved.staleReplace;
    const matchesFilter = filter === "All" || filter === (template.category === "agent" ? "Agent" : "Shared") || filter === "Overridden" && template.override !== null || filter === "Warnings" && warning;
    return matchesFilter && `${template.title} ${template.id}`.toLowerCase().includes(search.toLowerCase());
  }), [filter, search, templates]);
  const save = async (): Promise<void> => {
    if (!active) return;
    setError("");
    try {
      await readJson(templateUrl(active.id, scope, projectId).replace(`?scope=${scope}`, `/override?scope=${scope}`), { method: "PUT", body: JSON.stringify(draft) });
      await reload(); setSaved(true); window.setTimeout(() => setSaved(false), 1600);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save prompt override."); }
  };
  const rollback = async (revision: number): Promise<void> => {
    if (!active) return;
    await readJson(templateUrl(active.id, scope, projectId).replace(`?scope=${scope}`, `/rollback?scope=${scope}`), { method: "POST", body: JSON.stringify({ revision }) });
    await reload();
  };
  const backHref = withCompany("/projects", currentCompany?.id);
  return <SettingsLayout title={scope === "project" ? "Project prompts" : "Prompts"} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={scope === "project" && projectId ? withCompany(`/projects/${encodeURIComponent(projectId)}/prompts`, currentCompany?.id) : withCompany("/admin/prompts", currentCompany?.id)}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><label className="relative w-72"><Search className="pointer-events-none absolute left-2 top-2 size-4 text-muted-foreground" /><Input aria-label="Search prompts" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search prompts" /></label><div className="flex flex-wrap gap-1">{FILTERS.map((name) => <Button aria-pressed={filter === name} key={name} onClick={() => setFilter(name)} size="sm" type="button" variant={filter === name ? "default" : "outline"}>{name}</Button>)}</div></div>
      {error ? <Alert variant="destructive"><AlertTitle>Prompt settings</AlertTitle><AlertDescription>{error}</AlertDescription></Alert> : null}
      {(["agent", "shared"] as const).map((category) => { const grouped = visible.filter((template) => template.category === category); return <SettingsDataTable className="" columns={COLUMNS} key={category} label={`${category} prompts`}><SettingsTableGroup columnCount={COLUMNS.length} count={grouped.length} label={category === "agent" ? "Agent prompts" : "Shared prompts"}>{grouped.length === 0 ? <SettingsTableEmpty columnCount={COLUMNS.length}>No overrides. Everything uses system defaults.</SettingsTableEmpty> : grouped.map((template) => <SettingsTableRow key={template.id} onClick={() => setSelected(template.id)} tabIndex={0}><SettingsTableCell>{template.title} {!template.editable ? <Lock className="ml-1 inline size-3" /> : null}</SettingsTableCell><SettingsTableCell className="font-mono text-xs text-muted-foreground">{template.id}</SettingsTableCell><SettingsTableCell><Badge>{modeFor(template)}</Badge></SettingsTableCell><SettingsTableCell>{template.resolved.staleReplace ? <Badge>Warning</Badge> : ""}</SettingsTableCell><SettingsTableCell className="text-muted-foreground">{template.override ? `r${template.override.currentRevision}` : "System"}</SettingsTableCell></SettingsTableRow>)}</SettingsTableGroup></SettingsDataTable>; })}
      {active ? <section aria-label={`${active.title} detail`} className="border-t pt-4"><div className="flex items-center gap-2 text-sm font-medium">{active.category} › {active.archetype} › {active.title} {!active.editable ? <Lock className="size-4" /> : null}</div>{active.resolved.staleReplace ? <Alert><AlertTitle>System guidance changed</AlertTitle><AlertDescription>This replacement does not include current system guidance.</AlertDescription></Alert> : null}<Tabs defaultValue="edit"><TabsList variant="line"><TabsTrigger value="edit">Edit</TabsTrigger><TabsTrigger value="preview">Preview</TabsTrigger><TabsTrigger value="resolved">Resolved</TabsTrigger><TabsTrigger value="history">History</TabsTrigger></TabsList><TabsContent value="edit"><div className="space-y-3 py-3"><p className="text-xs text-muted-foreground">System guidance</p><pre className="max-h-32 overflow-auto whitespace-pre-wrap text-xs text-muted-foreground">{active.guidance}</pre>{active.editable ? <><Select value={draft.mode} onValueChange={(mode) => setDraft({ ...draft, mode: mode as Mode })}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="inherit">Inherit</SelectItem><SelectItem value="append">Append</SelectItem><SelectItem value="replace">Replace</SelectItem></SelectContent></Select><Textarea aria-label="Override content" value={draft.content} onChange={(event) => setDraft({ ...draft, content: event.target.value })} /><div className="flex flex-wrap gap-1">{active.variables.map((variable) => <Button key={variable} onClick={() => setDraft({ ...draft, content: `${draft.content}{{${variable}}}` })} size="sm" type="button" variant="outline">{variable}</Button>)}</div><Input aria-label="Revision note" value={draft.note} onChange={(event) => setDraft({ ...draft, note: event.target.value })} placeholder="Revision note" /><Button onClick={() => void save()} size="sm"><Save />{saved ? "Saved" : "Save"}</Button></> : <p className="text-xs text-muted-foreground">This template is read-only.</p>}</div></TabsContent><TabsContent value="preview"><pre className="whitespace-pre-wrap py-3 text-xs">{draft.content}</pre></TabsContent><TabsContent value="resolved"><div className="space-y-3 py-3"><pre className="whitespace-pre-wrap text-xs">{active.resolved.guidance}</pre><pre className="whitespace-pre-wrap border-l pl-3 text-xs text-muted-foreground">{active.contract ?? "No contract"}</pre><p className="text-xs text-muted-foreground">{active.resolved.steps.map((step) => `${step.layer} ${step.mode}${step.revision ? ` r${step.revision}` : ""}`).join(" → ")}</p></div></TabsContent><TabsContent value="history"><table className="w-full text-xs"><thead><tr><th>Rev</th><th>Mode</th><th>Actor</th><th>Note</th><th>Created</th><th /></tr></thead><tbody>{active.revisions.map((revision) => <tr key={revision.revision}><td>{revision.revision}</td><td>{revision.mode}</td><td>{revision.actor_user_id}</td><td>{revision.note}</td><td>{revision.created_at}</td><td><Button onClick={() => void rollback(revision.revision)} size="sm" type="button" variant="outline"><RotateCcw />Roll back</Button></td></tr>)}</tbody></table></TabsContent></Tabs></section> : null}
    </div>
  </SettingsLayout>;
}
