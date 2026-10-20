import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Archive, ArchiveRestore, Check, CircleAlert, Ellipsis, Pencil, Power, PowerOff } from "lucide-react";
import type { GithubTriggerActivity, GithubTriggerPullRequestHandling, GithubTriggerRule, GithubTriggerSortOrder } from "../../contracts/github-triggers.js";
import type { ApiProject, ApiWorkflow } from "../../shell/view-shared.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SettingRow, SettingsContent, SettingsLayout, SettingsSection } from "./settings-layout.js";
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
import { LoadingState } from "../../components/app/loading-state.js";
import type { GithubLabelsResponse } from "../../contracts/generated/GithubLabelsResponse.js";
import { listGithubLabels, listProjects } from "../projects/lib/project-api.js";

const sortOrderOptions: Array<{ value: GithubTriggerSortOrder; label: string }> = [
  { value: "created_asc", label: "Oldest created first" },
  { value: "created_desc", label: "Newest created first" },
  { value: "labeled_asc", label: "Oldest labelled first" },
  { value: "labeled_desc", label: "Newest labelled first" },
];

const handlingOptions: Array<{ value: GithubTriggerPullRequestHandling; label: string }> = [
  { value: "ignore", label: "Ignore" },
  { value: "review_only", label: "Review only" },
  { value: "deliver", label: "Deliver" },
];

const columns: SettingsTableColumn[] = [
  { key: "status", label: "Status", width: 100 },
  { key: "name", label: "Name", width: 180 },
  { key: "project", label: "Project", width: 150 },
  { key: "label", label: "Label", width: 140 },
  { key: "workflow", label: "Workflow", width: 170 },
  { key: "delivery", label: "Delivery", width: 140 },
  { key: "check", label: "Last check", width: 180 },
  { key: "menu", width: 36 },
  { key: "edit", width: 36 },
];

type Draft = { name: string; projectId: string; label: string; workflowId: string; deliveryTarget: GithubTriggerRule["deliveryTarget"]; sortOrder: GithubTriggerRule["sortOrder"]; draftPullRequests: GithubTriggerRule["draftPullRequests"]; readyPullRequests: GithubTriggerRule["readyPullRequests"]; protectedPaths: string };
type Editor = { kind: "closed" } | { kind: "create"; draft: Draft } | { kind: "edit"; rule: GithubTriggerRule; draft: Draft };

const emptyDraft = (): Draft => ({ name: "", projectId: "", label: "", workflowId: "", deliveryTarget: "merged", sortOrder: "labeled_asc", draftPullRequests: "review_only", readyPullRequests: "deliver", protectedPaths: "" });
const draftFor = (rule: GithubTriggerRule): Draft => ({ name: rule.name, projectId: rule.projectId, label: rule.label, workflowId: rule.workflowId, deliveryTarget: rule.deliveryTarget, sortOrder: rule.sortOrder, draftPullRequests: rule.draftPullRequests, readyPullRequests: rule.readyPullRequests, protectedPaths: rule.protectedPaths.join("\n") });
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
  const labelProjectId = editor.kind === "closed" ? "" : editor.draft.projectId;
  const [labelResult, setLabelResult] = useState<{ projectId: string; response: GithubLabelsResponse | null } | null>(null);
  useEffect(() => {
    if (!companyId || !labelProjectId) return;
    let closed = false;
    void listGithubLabels(companyId, labelProjectId).then(
      (response) => { if (!closed) setLabelResult({ projectId: labelProjectId, response }); },
      () => { if (!closed) setLabelResult({ projectId: labelProjectId, response: null }); },
    );
    return () => { closed = true; };
  }, [companyId, labelProjectId]);
  const loadedLabels = labelResult?.projectId === labelProjectId ? labelResult : null;
  const labelNames = loadedLabels?.response?.labels.map((label) => label.name) ?? [];
  if (editor.kind === "edit" && editor.rule.projectId === labelProjectId && !labelNames.includes(editor.rule.label)) labelNames.unshift(editor.rule.label);


  const reload = async (): Promise<GithubTriggerRule[]> => {
    const [ruleResult, projectResult, workflowResult] = await Promise.all([
      readJsonUnchecked<{ rules: GithubTriggerRule[] }>(`/api/companies/${encodeURIComponent(companyId)}/github-triggers`),
      listProjects(companyId),
      readJsonUnchecked<{ workflows: ApiWorkflow[] }>("/api/workflows?includeArchived=true"),
    ]);
    setRules(ruleResult.rules);
    setProjects(projectResult);
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
      await readJsonUnchecked(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(rule.id)}`, { method: "PATCH", body: JSON.stringify({ ...patch, expectedRevision: rule.revision }) });
      await reload();
    } catch (reason) { setError(reason instanceof Error ? reason.message : failure); throw reason; }
    finally { setBusy(false); }
  };
  const save = async (): Promise<void> => {
    if (editor.kind === "closed") return;
    setBusy(true); setError("");
    let created: GithubTriggerRule | null = null;
    try {
      const body = { ...editor.draft, protectedPaths: paths(editor.draft.protectedPaths) };
      if (editor.kind === "edit") await readJsonUnchecked(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(editor.rule.id)}`, { method: "PATCH", body: JSON.stringify({ ...body, expectedRevision: editor.rule.revision }) });
      else created = await readJsonUnchecked<GithubTriggerRule>(`/api/companies/${encodeURIComponent(companyId)}/github-triggers`, { method: "POST", body: JSON.stringify(body) });
      await reload(); setEditor({ kind: "closed" });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to save trigger");
      if (!created) return;
      setEditor({ kind: "closed" });
    }
    finally { setBusy(false); }
    if (created) await check(created, true);
  };
  const check = async (rule: GithubTriggerRule, preview = false): Promise<void> => {
    setBusy(true); setError("");
    try {
      const result = await readJsonUnchecked<{ activity: GithubTriggerActivity[] }>(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(rule.id)}/check`, { method: "POST", body: "{}" });
      const loaded = await reload();
      if (preview) setEnableTarget({ rule: loaded.find((candidate) => candidate.id === rule.id) ?? rule, activity: result.activity });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to check trigger"); }
    finally { setBusy(false); }
  };
  const viewActivity = async (rule: GithubTriggerRule): Promise<void> => {
    setActivityTarget(rule); setActivity([]); setError("");
    try { const result = await readJsonUnchecked<{ activity: GithubTriggerActivity[] }>(`/api/companies/${encodeURIComponent(companyId)}/github-triggers/${encodeURIComponent(rule.id)}/activity`); setActivity(result.activity); }
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

  if (loading) return <SettingsLayout title="Triggers" companyId={companyId} backHref={backHref} activeHref={withCompany("/admin/triggers", companyId)}><LoadingState /></SettingsLayout>;
  if (!admin) return <SettingsLayout title="Triggers" companyId={companyId} backHref={backHref} activeHref={withCompany("/admin/triggers", companyId)}><SettingsContent title="Triggers"><SettingsSection><SettingRow label="Administration is not available" description="Only administrators can change triggers." /></SettingsSection></SettingsContent></SettingsLayout>;

  return <SettingsLayout title="Triggers" companyId={companyId} backHref={backHref} activeHref={withCompany("/admin/triggers", companyId)}>
    <SettingsContent width="wide" title="Triggers" description="A trigger starts a task when a pull request has a specified label. Suplex uses the project and workflow of the trigger.">
      <SettingsToolbar actionsInHeader searchLabel="Filter triggers by name, label, project, or workflow" searchPlaceholder="Filter triggers" searchWidth="compact" searchValue={search} onSearchChange={setSearch} actions={<NewButton disabled={busy} onClick={() => { setError(""); setEditor({ kind: "create", draft: emptyDraft() }); }}>New trigger</NewButton>} />
      {error && editor.kind === "closed" ? <div className="mt-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      <SettingsDataTable label="Triggers" columns={columns} className="mt-4">
        <SettingsTableGroup label="Triggers" count={visible.length} columnCount={columns.length}>
          {visible.map((rule) => {
            const ruleStatus = status(rule); const checkStatus = lastCheck(rule);
            return <SettingsTableRow key={rule.id} aria-label={`Edit ${rule.name}`} tabIndex={0} onClick={(event) => { if (!busy && !(event.target as HTMLElement).closest("button, input, label, [data-base-ui-portal]")) { setError(""); setEditor({ kind: "edit", rule, draft: draftFor(rule) }); } }} onKeyDown={(event) => { if (busy || event.target !== event.currentTarget || event.key !== "Enter" && event.key !== " ") return; event.preventDefault(); setError(""); setEditor({ kind: "edit", rule, draft: draftFor(rule) }); }}>
              <SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={`size-1.5 rounded-full ${ruleStatus.color}`} />{ruleStatus.text}</span></SettingsTableCell>
              <SettingsTableCell className="font-medium">{rule.name}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{projects.find((project) => project.id === rule.projectId)?.name ?? rule.projectId}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{rule.label}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{workflows.find((workflow) => workflow.id === rule.workflowId)?.name ?? rule.workflowId}</SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">{rule.deliveryTarget}</SettingsTableCell>
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
    </SettingsContent>

    <Dialog open={editor.kind !== "closed"} onOpenChange={(open) => { if (!open && !busy) { setEditor({ kind: "closed" }); setError(""); } }}><DialogContent showCloseButton={!busy}><DialogHeader><DialogTitle>{editor.kind === "edit" ? "Edit trigger" : "New trigger"}</DialogTitle><DialogDescription>Run a workflow when a pull request has a label.</DialogDescription></DialogHeader>
      {draft ? <form className="max-h-[70dvh] overflow-y-auto" onSubmit={(event) => { event.preventDefault(); void save(); }}><FieldGroup>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <Field><FieldLabel htmlFor="trigger-name">Name</FieldLabel><Input id="trigger-name" autoFocus disabled={busy} value={draft.name} onChange={(event) => updateDraft({ name: event.target.value })} required /></Field>
        <Field><FieldLabel htmlFor="trigger-project">Project</FieldLabel><Select disabled={busy || Boolean(editor.kind === "edit" && editor.rule.enabled)} value={draft.projectId} onValueChange={(value) => updateDraft({ projectId: value ?? "", label: editor.kind === "edit" && value === editor.rule.projectId ? editor.rule.label : "" })}><SelectTrigger id="trigger-project"><SelectValue placeholder="Select a project" /></SelectTrigger><SelectContent>{projects.filter((project) => project.repository).map((project) => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent></Select>{editor.kind === "edit" && editor.rule.enabled ? <p className="text-xs text-muted-foreground">Disable the rule before you change the project.</p> : null}</Field>
        <Field><FieldLabel htmlFor="trigger-label">Pull request label</FieldLabel><Select name="label" required disabled={busy || !draft.projectId} value={draft.label || null} onValueChange={(value) => updateDraft({ label: value ?? "" })}><SelectTrigger id="trigger-label"><SelectValue placeholder="Select a label" /></SelectTrigger><SelectContent>{labelNames.map((label) => <SelectItem key={label} value={label}>{label}</SelectItem>)}</SelectContent></Select>{loadedLabels && !loadedLabels.response ? <p className="text-xs text-muted-foreground">Suplex cannot load the repository labels.</p> : loadedLabels?.response?.labels.length === 0 ? <p className="text-xs text-muted-foreground">The GitHub repository has no labels.</p> : null}</Field>
        <Field><FieldLabel htmlFor="trigger-draft-pull-requests">Draft pull requests</FieldLabel><Select disabled={busy} value={draft.draftPullRequests} onValueChange={(value) => updateDraft({ draftPullRequests: value as Draft["draftPullRequests"] })}><SelectTrigger id="trigger-draft-pull-requests"><SelectValue /></SelectTrigger><SelectContent>{handlingOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
        <Field><FieldLabel htmlFor="trigger-ready-pull-requests">Ready pull requests</FieldLabel><Select disabled={busy} value={draft.readyPullRequests} onValueChange={(value) => updateDraft({ readyPullRequests: value as Draft["readyPullRequests"] })}><SelectTrigger id="trigger-ready-pull-requests"><SelectValue /></SelectTrigger><SelectContent>{handlingOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select><p className="text-xs text-muted-foreground">With Review only, Suplex pushes changes to the pull request and observes checks. It does not request review or merge.</p></Field>
        <Field><FieldLabel htmlFor="trigger-sort-order">Sort by</FieldLabel><Select disabled={busy} value={draft.sortOrder} onValueChange={(value) => updateDraft({ sortOrder: value as Draft["sortOrder"] })}><SelectTrigger id="trigger-sort-order"><SelectValue /></SelectTrigger><SelectContent>{sortOrderOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
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
