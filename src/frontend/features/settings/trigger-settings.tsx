import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Archive, ArchiveRestore, Check, CircleAlert, Ellipsis, Pencil, Power, PowerOff } from "lucide-react";
import type { GithubTriggerActivity, GithubTriggerRule } from "../../../http/contracts/github-triggers.js";
import type { ApiProject, ApiWorkflow } from "../../shell/view-shared.js";
import { readJson, withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SettingsLayout } from "./settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Textarea } from "../../components/ui/textarea.js";
import { taskDeliveryTargetOptions } from "../tasks/task-delivery-target.js";

const columns: SettingsTableColumn[] = [
  { key: "name", label: "Name", width: 180 },
  { key: "project", label: "Project", width: 150 },
  { key: "label", label: "Label", width: 140 },
  { key: "workflow", label: "Workflow", width: 170 },
  { key: "delivery", label: "Delivery", width: 140 },
  { key: "status", label: "Status", width: 100 },
  { key: "check", label: "Last check", width: 180 },
  { key: "menu", width: 36 },
  { key: "edit", width: 36 },
];

type Draft = { name: string; projectId: string; label: string; workflowId: string; deliveryTarget: GithubTriggerRule["deliveryTarget"]; protectedPaths: string };
type Editor = { kind: "closed" } | { kind: "create"; draft: Draft } | { kind: "edit"; rule: GithubTriggerRule; draft: Draft };

const emptyDraft = (): Draft => ({ name: "", projectId: "", label: "", workflowId: "", deliveryTarget: "merged", protectedPaths: "" });
const draftFor = (rule: GithubTriggerRule): Draft => ({ name: rule.name, projectId: rule.projectId, label: rule.label, workflowId: rule.workflowId, deliveryTarget: rule.deliveryTarget, protectedPaths: rule.protectedPaths.join("\n") });
const paths = (value: string): string[] => value.split("\n").map((path) => path.trim()).filter(Boolean);

export function TriggerSettingsView(): ReactElement {
  const { user, currentCompany, loading } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const admin = user?.role === "admin";
  const [rules, setRules] = useState<GithubTriggerRule[]>([]);
  const [projects, setProjects] = useState<ApiProject[]>([]);
  const [workflows, setWorkflows] = useState<ApiWorkflow[]>([]);
  const [editor, setEditor] = useState<Editor>({ kind: "closed" });
  const [search, setSearch] = useState("");
  const [activityTarget, setActivityTarget] = useState<GithubTriggerRule | null>(null);
  const [activity, setActivity] = useState<GithubTriggerActivity[]>([]);
  const [enableTarget, setEnableTarget] = useState<{ rule: GithubTriggerRule; activity: GithubTriggerActivity[] } | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<GithubTriggerRule | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = async (): Promise<GithubTriggerRule[]> => {
    const [ruleResult, projectResult, workflowResult] = await Promise.all([
      readJson<{ rules: GithubTriggerRule[] }>(`/api/companies/${encodeURIComponent(companyId)}/github-triggers`),
      readJson<{ projects: ApiProject[] }>(`/api/companies/${encodeURIComponent(companyId)}/projects`),
      readJson<{ workflows: ApiWorkflow[] }>("/api/workflows?includeArchived=true"),
    ]);
    setRules(ruleResult.rules);
    setProjects(projectResult.projects);
    setWorkflows(workflowResult.workflows.filter((workflow) => !workflow.archivedAt));
    return ruleResult.rules;
  };
  useEffect(() => {
    if (!admin || !companyId) return;
    let closed = false;
    void reload().catch((reason) => { if (!closed) setError(reason instanceof Error ? reason.message : "Unable to load triggers"); });
    return () => { closed = true; };
  }, [admin, companyId]);

  const update = async (rule: GithubTriggerRule, patch: Record<string, unknown>, failure: string): Promise<void> => {
    setBusy(true); setError("");
    try {
      await readJson(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(rule.id)}`, { method: "PATCH", body: JSON.stringify({ ...patch, expectedRevision: rule.revision }) });
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : failure); throw reason; }
    finally { setBusy(false); }
  };
  const save = async (): Promise<void> => {
    if (editor.kind === "closed") return;
    setBusy(true); setError("");
    try {
      const body = { ...editor.draft, protectedPaths: paths(editor.draft.protectedPaths) };
      if (editor.kind === "edit") await readJson(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(editor.rule.id)}`, { method: "PATCH", body: JSON.stringify({ ...body, expectedRevision: editor.rule.revision }) });
      else await readJson(`/api/companies/${encodeURIComponent(companyId)}/github-triggers`, { method: "POST", body: JSON.stringify(body) });
      await reload(); setEditor({ kind: "closed" });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to save trigger"); }
    finally { setBusy(false); }
  };
  const check = async (rule: GithubTriggerRule, preview = false): Promise<void> => {
    setBusy(true); setError("");
    try {
      const result = await readJson<{ activity: GithubTriggerActivity[] }>(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(rule.id)}/check`, { method: "POST", body: "{}" });
      const loaded = await reload();
      if (preview) setEnableTarget({ rule: loaded.find((candidate) => candidate.id === rule.id) ?? rule, activity: result.activity });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to check trigger"); }
    finally { setBusy(false); }
  };
  const viewActivity = async (rule: GithubTriggerRule): Promise<void> => {
    setActivityTarget(rule); setActivity([]); setError("");
    try { const result = await readJson<{ activity: GithubTriggerActivity[] }>(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(rule.id)}/activity`); setActivity(result.activity); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to load activity"); }
  };
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const sorted = [...rules].sort((left, right) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)));
    return term ? sorted.filter((rule) => `${rule.name} ${rule.label} ${projects.find((project) => project.id === rule.projectId)?.name ?? ""} ${workflows.find((workflow) => workflow.id === rule.workflowId)?.name ?? ""}`.toLowerCase().includes(term)) : sorted;
  }, [projects, rules, search, workflows]);
  const draft = editor.kind === "closed" ? null : editor.draft;
  const selectedWorkflow = draft ? workflows.find((workflow) => workflow.id === draft.workflowId) : undefined;
  const status = (rule: GithubTriggerRule): { text: string; color: string } => rule.archivedAt ? { text: "archived", color: "bg-muted-foreground" } : rule.enabled ? { text: "enabled", color: "bg-emerald-500" } : { text: "disabled", color: "bg-amber-500" };
  const lastCheck = (rule: GithubTriggerRule): { text: string; title: string } => rule.latestError ? { text: "Error", title: rule.latestError } : rule.nextRetryAt ? { text: `Retry ${new Date(rule.nextRetryAt).toLocaleString()}`, title: rule.nextRetryAt } : rule.lastSuccessfulCheckAt ? { text: new Date(rule.lastSuccessfulCheckAt).toLocaleString(), title: rule.lastSuccessfulCheckAt } : { text: "Never", title: "No successful checks" };
  const updateDraft = (patch: Partial<Draft>): void => setEditor((current) => current.kind === "closed" ? current : { ...current, draft: { ...current.draft, ...patch } });
  const backHref = withCompany("/projects", companyId);

  if (loading) return <SettingsLayout title="Triggers" companyId={companyId} backHref={backHref} activeHref={withCompany("/admin/triggers", companyId)}><div className="p-4 text-xs text-muted-foreground">Loading...</div></SettingsLayout>;
  if (!admin) return <SettingsLayout title="Triggers" companyId={companyId} backHref={backHref} activeHref={withCompany("/admin/triggers", companyId)}><div className="p-4 text-xs text-muted-foreground">Administration is unavailable.</div></SettingsLayout>;

  return <SettingsLayout title="Triggers" companyId={companyId} backHref={backHref} activeHref={withCompany("/admin/triggers", companyId)}>
    <section className="min-w-0 pt-3 lg:px-8">
      <SettingsToolbar searchLabel="Filter triggers by name, label, project, or workflow" searchPlaceholder="Filter triggers" filterLabel="All triggers" searchWidth="compact" searchValue={search} onSearchChange={setSearch} actions={<NewButton disabled={busy} onClick={() => { setError(""); setEditor({ kind: "create", draft: emptyDraft() }); }}>New trigger</NewButton>} />
      {error && editor.kind === "closed" ? <div className="mt-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      <SettingsDataTable label="Triggers" columns={columns} className="mt-4">
        <SettingsTableGroup label="Triggers" count={visible.length} columnCount={columns.length}>
          {visible.map((rule) => {
            const ruleStatus = status(rule); const checkStatus = lastCheck(rule);
            return <SettingsTableRow key={rule.id} aria-label={`Edit ${rule.name}`} tabIndex={0} onClick={(event) => { if (!busy && !(event.target as HTMLElement).closest("button, input, label, [data-base-ui-portal]")) { setError(""); setEditor({ kind: "edit", rule, draft: draftFor(rule) }); } }}>
              <SettingsTableCell className="font-medium">{rule.name}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{projects.find((project) => project.id === rule.projectId)?.name ?? rule.projectId}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{rule.label}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{workflows.find((workflow) => workflow.id === rule.workflowId)?.name ?? rule.workflowId}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{rule.deliveryTarget}</SettingsTableCell>
              <SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={`size-1.5 rounded-full ${ruleStatus.color}`} />{ruleStatus.text}</span></SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground" title={checkStatus.title}>{checkStatus.text}</SettingsTableCell>
              <SettingsTableCell className="p-0"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${rule.name} actions`} title={`${rule.name} actions`} disabled={busy} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end">
                <DropdownMenuItem disabled={busy || Boolean(rule.archivedAt)} onClick={() => void check(rule)}><Check />Check now</DropdownMenuItem>
                {!rule.archivedAt ? <DropdownMenuItem disabled={busy} onClick={() => { if (rule.enabled) void update(rule, { enabled: false }, "Unable to disable trigger").catch(() => undefined); else void check(rule, true); }}>{rule.enabled ? <PowerOff /> : <Power />}{rule.enabled ? "Disable" : "Enable"}</DropdownMenuItem> : null}
                {rule.archivedAt ? <DropdownMenuItem disabled={busy} onClick={() => void update(rule, { archived: false }, "Unable to restore trigger").catch(() => undefined)}><ArchiveRestore />Restore</DropdownMenuItem> : <DropdownMenuItem disabled={busy} onClick={() => setArchiveTarget(rule)}><Archive />Archive</DropdownMenuItem>}
                <DropdownMenuItem disabled={busy} onClick={() => void viewActivity(rule)}><CircleAlert />View activity</DropdownMenuItem>
              </DropdownMenuContent></DropdownMenu></SettingsTableCell>
              <SettingsTableCell className="p-0"><Button variant="ghost" size="icon-xs" aria-label={`Edit ${rule.name} details`} title={`Edit ${rule.name}`} disabled={busy} onClick={() => { setError(""); setEditor({ kind: "edit", rule, draft: draftFor(rule) }); }}><Pencil /></Button></SettingsTableCell>
            </SettingsTableRow>;
          })}
        </SettingsTableGroup>
        {rules.length === 0 ? <SettingsTableEmpty columnCount={columns.length}>No triggers configured.</SettingsTableEmpty> : visible.length === 0 ? <SettingsTableEmpty columnCount={columns.length}>No triggers match the search.</SettingsTableEmpty> : null}
      </SettingsDataTable>
    </section>

    <Dialog open={editor.kind !== "closed"} onOpenChange={(open) => { if (!open && !busy) { setEditor({ kind: "closed" }); setError(""); } }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>{editor.kind === "edit" ? "Edit trigger" : "New trigger"}</DialogTitle><DialogDescription>Run a workflow when a pull request has a label.</DialogDescription></DialogHeader>
      {draft ? <form className="max-h-[70dvh] overflow-y-auto" onSubmit={(event) => { event.preventDefault(); void save(); }}><FieldGroup>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <Field><FieldLabel htmlFor="trigger-name">Name</FieldLabel><Input id="trigger-name" autoFocus disabled={busy} value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} required /></Field>
        <Field><FieldLabel htmlFor="trigger-project">Project</FieldLabel><Select disabled={busy || Boolean(editor.kind === "edit" && editor.rule.enabled)} value={draft.projectId} onValueChange={(value) => updateDraft({ projectId: value ?? "" })}><SelectTrigger id="trigger-project"><SelectValue placeholder="Select a project" /></SelectTrigger><SelectContent>{projects.filter((project) => project.repository).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select>{editor.kind === "edit" && editor.rule.enabled ? <p className="text-xs text-muted-foreground">Disable the rule before you change the project.</p> : null}</Field>
        <Field><FieldLabel htmlFor="trigger-label">Pull request label</FieldLabel><Input id="trigger-label" disabled={busy} value={draft.label} onChange={(event) => updateDraft({ label: event.target.value })} required /></Field>
        <Field><FieldLabel htmlFor="trigger-workflow">Workflow</FieldLabel><Select disabled={busy} value={draft.workflowId} onValueChange={(value) => { const workflow = workflows.find((candidate) => candidate.id === value); updateDraft({ workflowId: value ?? "", deliveryTarget: workflow?.engine === "refine_pull_request" ? "merged" : workflow?.deliveryTarget ?? "pull_request_draft" }); }}><SelectTrigger id="trigger-workflow"><SelectValue placeholder="Select a workflow" /></SelectTrigger><SelectContent>{workflows.map((workflow) => <SelectItem key={workflow.id} value={workflow.id}>{workflow.name}</SelectItem>)}</SelectContent></Select></Field>
        <Field><FieldLabel htmlFor="trigger-delivery">Delivery</FieldLabel><Select disabled={busy || selectedWorkflow?.engine === "refine_pull_request"} value={draft.deliveryTarget} onValueChange={(value) => updateDraft({ deliveryTarget: value as Draft["deliveryTarget"] })}><SelectTrigger id="trigger-delivery"><SelectValue /></SelectTrigger><SelectContent>{taskDeliveryTargetOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
        <Field><FieldLabel htmlFor="trigger-paths">Protected paths</FieldLabel><Textarea id="trigger-paths" disabled={busy} value={draft.protectedPaths} onChange={(event) => updateDraft({ protectedPaths: event.target.value })} /><p className="text-xs text-muted-foreground">Enter one file path or directory prefix per line. End each directory prefix with /. No globs. Empty means no file exclusion.</p></Field>
        <p className="text-xs text-muted-foreground">Suplex starts eligible pull requests that already have this label. Anyone who can apply this label can request this workflow.</p>
        <DialogFooter><DialogClose disabled={busy} render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>{editor.kind === "edit" ? <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save changes"}</Button> : <NewButton type="submit" disabled={busy}>{busy ? "Creating…" : "New trigger"}</NewButton>}</DialogFooter>
      </FieldGroup></form> : null}
    </DialogContent></Dialog>

    <AlertDialog open={enableTarget !== null} onOpenChange={(open) => { if (!open) setEnableTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Enable {enableTarget?.rule.name}?</AlertDialogTitle><AlertDialogDescription>Suplex starts eligible pull requests that already have this label. Anyone who can apply this label can request this workflow. {enableTarget?.activity.filter((entry) => entry.previouslyProcessed).map((entry) => `Pull request ${entry.pullRequestNumber} was previously processed.`).join(" ")}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction disabled={busy} onClick={() => { const target = enableTarget; if (target) void update(rules.find((rule) => rule.id === target.rule.id) ?? target.rule, { enabled: true }, "Unable to enable trigger").then(() => setEnableTarget(null)).catch(() => undefined); }}>Enable</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive {archiveTarget?.name}?</AlertDialogTitle><AlertDialogDescription>Suplex stops checking this trigger. You can restore it later.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" disabled={busy} onClick={() => { const target = archiveTarget; if (target) void update(target, { archived: true }, "Unable to archive trigger").then(() => setArchiveTarget(null)).catch(() => undefined); }}>Archive</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    <Dialog open={activityTarget !== null} onOpenChange={(open) => { if (!open) setActivityTarget(null); }}><DialogContent><DialogHeader><DialogTitle>{activityTarget?.name} activity</DialogTitle><DialogDescription>Activity for this trigger.</DialogDescription></DialogHeader><div className="max-h-[50dvh] space-y-2 overflow-y-auto text-xs">{activity.length === 0 ? <p className="text-muted-foreground">No activity yet.</p> : activity.map((entry) => <div key={`${entry.at}-${entry.reason}`} className="border-b pb-2 last:border-0"><div>{entry.url ? <a className="text-primary underline underline-offset-2" href={entry.url}>Pull request {entry.pullRequestNumber}</a> : "Pull request"} · {entry.outcome} · {entry.reason}</div><div className="text-muted-foreground">{entry.at}{entry.matchingPaths.length ? ` · ${entry.matchingPaths.join(", ")}` : ""}{entry.taskId ? <> · <a className="text-primary underline underline-offset-2" href={withCompany(`/tasks/${entry.taskId}`, companyId)}>Task {entry.taskStatus ?? entry.taskId}</a></> : null}</div></div>)}</div><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Close</DialogClose></DialogFooter></DialogContent></Dialog>
  </SettingsLayout>;
}
