import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Archive, ArchiveRestore, CirclePlus, Copy, Ellipsis, Pencil } from "lucide-react";
import { DeliveryTargetSchema, VisualEvidenceSchema } from "../../contracts/tasks.js";
import type { WorkflowRecordInput } from "../../contracts/workflow-presets.js";
import { ADVISOR_LABELS, WORKFLOWS, workflowDefinition } from "../tasks/workflow-presentation.js";
import { WorkflowIdSchema } from "../../contracts/workflows.js";
import type { AdvisorRole } from "../../contracts/advisor-reports.js";
import { SettingsContent, SettingsLayout } from "./settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { requestNewTask } from "../../shell/global-new-task-dialog.js";
import { taskDeliveryTargetOptions } from "../tasks/task-delivery-target.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Checkbox } from "../../components/ui/checkbox.js";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Field, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Textarea } from "../../components/ui/textarea.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";
import type { ApiProfile, ApiWorkflow } from "../../shell/view-shared.js";

const columns: SettingsTableColumn[] = [
  { key: "name", label: "Name", width: 200 },
  { key: "engine", label: "Built-in workflow", width: 150 },
  { key: "agents", label: "Default agents", width: 260 },
  { key: "delivery", label: "Delivery", width: 150 },
  { key: "status", label: "Status", width: 90 },
  { key: "menu", width: 36 },
  { key: "edit", width: 36 },
];

type EditorState =
  | { kind: "closed" }
  | { kind: "create"; draft: WorkflowRecordInput }
  | { kind: "edit"; workflowId: string; draft: WorkflowRecordInput };

const emptyDraft = (): WorkflowRecordInput => ({ name: "", description: "", engine: "standard", advisorProfileIds: {} });
const workflowDraft = (workflow: ApiWorkflow): WorkflowRecordInput => ({
  name: workflow.name, description: workflow.description, engine: workflow.engine, advisorProfileIds: workflow.advisorProfileIds,
  ...(workflow.rootProfileId ? { rootProfileId: workflow.rootProfileId } : {}),
  ...(workflow.workerProfileId ? { workerProfileId: workflow.workerProfileId } : {}),
  ...(workflow.deliveryTarget ? { deliveryTarget: workflow.deliveryTarget } : {}),
  ...(workflow.runProjectTests !== undefined ? { runProjectTests: workflow.runProjectTests } : {}),
  ...(workflow.visualEvidence ? { visualEvidence: workflow.visualEvidence } : {}),
});
const deliveryLabel = (value: ApiWorkflow["deliveryTarget"]): string => value ? taskDeliveryTargetOptions.find((option) => option.value === value)?.label ?? value : "Selected in the task";
const REPAIR = "refine_pull_request";

export function WorkflowSettingsView(): ReactElement {
  const { user, currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [workflows, setWorkflows] = useState<ApiWorkflow[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [editor, setEditor] = useState<EditorState>({ kind: "closed" });
  const [archiveTarget, setArchiveTarget] = useState<ApiWorkflow | null>(null);
  const [search, setSearch] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const admin = user?.role === "admin";

  const reload = async (): Promise<void> => {
    const [workflowResult, profileResult] = await Promise.all([
      readJsonUnchecked<{ workflows: ApiWorkflow[] }>("/api/workflows?includeArchived=true"),
      readJsonUnchecked<{ profiles: ApiProfile[] }>("/api/profiles"),
    ]);
    setWorkflows(workflowResult.workflows);
    setProfiles(profileResult.profiles);
  };
  useEffect(() => {
    let closed = false;
    reload().catch((reason) => { if (!closed) setError(String(reason)); });
    return () => { closed = true; };
  }, []);

  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const sorted = [...workflows].sort((left, right) => Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)));
    return term ? sorted.filter((workflow) => `${workflow.name} ${workflow.description} ${workflowDefinition(workflow.engine).name}`.toLowerCase().includes(term)) : sorted;
  }, [search, workflows]);
  const profileFor = (id: string | undefined): ApiProfile | undefined => id ? profiles.find((profile) => profile.id === id) : undefined;
  const agentLines = (workflow: ApiWorkflow): { label: string; agent: ApiProfile | undefined; fallback: string }[] => [
    { label: "Coordinator", agent: profileFor(workflow.rootProfileId), fallback: "Project default" },
    { label: "Worker", agent: profileFor(workflow.workerProfileId), fallback: "Project default" },
    ...workflowDefinition(workflow.engine).advisorRoles.map((role) => ({ label: ADVISOR_LABELS[role], agent: profileFor(workflow.advisorProfileIds?.[role]), fallback: "Same as Coordinator" })),
  ];

  const edit = (workflow: ApiWorkflow): void => { setError(""); setEditor({ kind: "edit", workflowId: workflow.id, draft: workflowDraft(workflow) }); };
  const setDraft = <Key extends keyof WorkflowRecordInput>(key: Key, value: WorkflowRecordInput[Key]): void => {
    setEditor((current) => current.kind === "closed" ? current : { ...current, draft: { ...current.draft, [key]: value } });
  };
  const selectEngine = (value: string): void => {
    const engine = WorkflowIdSchema.parse(value);
    setEditor((current) => current.kind === "closed" ? current : { ...current, draft: {
      ...current.draft, engine,
      advisorProfileIds: Object.fromEntries(Object.entries(current.draft.advisorProfileIds ?? {}).filter(([role]) => workflowDefinition(engine).advisorRoles.includes(role as AdvisorRole))),
      ...(engine === REPAIR ? { deliveryTarget: "merged" as const, runProjectTests: true } : {}),
    } });
  };
  const patch = async (workflow: ApiWorkflow, body: Record<string, unknown>, failure: string): Promise<void> => {
    setBusy(true); setError("");
    try { await readJsonUnchecked(`/api/admin/workflows/${workflow.id}`, { method: "PATCH", body: JSON.stringify(body) }); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : failure); }
    finally { setBusy(false); }
  };
  const duplicate = async (workflow: ApiWorkflow): Promise<void> => {
    setBusy(true); setError("");
    try { await readJsonUnchecked(`/api/admin/workflows/${workflow.id}/duplicate`, { method: "POST", body: "{}" }); await reload(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to duplicate workflow"); }
    finally { setBusy(false); }
  };
  const save = async (): Promise<void> => {
    if (editor.kind === "closed") return;
    setBusy(true); setError("");
    try {
      const editing = editor.kind === "edit";
      const draft = editor.draft;
      // A patch clears unset optional settings explicitly; a create simply omits them.
      const body = editing
        ? { ...draft, rootProfileId: draft.rootProfileId ?? null, workerProfileId: draft.workerProfileId ?? null, deliveryTarget: draft.deliveryTarget ?? null, runProjectTests: draft.runProjectTests ?? null, visualEvidence: draft.visualEvidence ?? null }
        : draft;
      await readJsonUnchecked(editing ? `/api/admin/workflows/${editor.workflowId}` : "/api/admin/workflows", { method: editing ? "PATCH" : "POST", body: JSON.stringify(body) });
      await reload();
      setEditor({ kind: "closed" });
    } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };

  const draft = editor.kind === "closed" ? null : editor.draft;
  const definition = draft ? workflowDefinition(draft.engine ?? "standard") : null;
  const profileSelect = (id: string, label: string, role: "root" | "worker", value: string | undefined, empty: string, onChange: (value: string | undefined) => void): ReactElement =>
    <Field><FieldLabel htmlFor={id}>{label}</FieldLabel><Select disabled={busy} value={value ?? "default"} onValueChange={(next) => onChange(next === "default" || !next ? undefined : next)}><SelectTrigger id={id}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">{empty}</SelectItem>{profiles.filter((profile) => profile.role === role && (!profile.archivedAt || profile.id === value)).map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name} · {profile.model} · {profile.provider}</SelectItem>)}</SelectContent></Select></Field>;

  return <SettingsLayout title="Workflows" companyId={companyId} backHref={withCompany("/projects", companyId)} activeHref={withCompany("/admin/workflows", companyId)}>
    <SettingsContent width="wide" title="Workflows" description="A workflow sets the steps, default agents, and delivery that Suplex uses for a task.">
      <SettingsToolbar searchLabel="Filter workflows by name" searchPlaceholder="Filter by name" searchWidth="compact" searchValue={search} onSearchChange={setSearch} actions={admin ? <NewButton disabled={busy} onClick={() => { setError(""); setEditor({ kind: "create", draft: emptyDraft() }); }}>New workflow</NewButton> : null} />
      {error && editor.kind === "closed" ? <div className="mt-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      <SettingsDataTable label="Workflows" columns={columns} className="mt-4">
        <SettingsTableGroup label="Workflows" count={visible.length} columnCount={columns.length}>
          {visible.map((workflow) => <SettingsTableRow key={workflow.id} data-workflow-row={workflow.id} aria-label={`Edit ${workflow.name}`} tabIndex={0} onClick={(event) => { if (admin && !(event.target as HTMLElement).closest("button, input, label, [data-base-ui-portal]")) edit(workflow); }}>
            <SettingsTableCell className="font-medium"><span className="flex min-w-0 items-center gap-2"><Button variant="link" size="sm" aria-label={`Edit ${workflow.name}`} onClick={() => edit(workflow)}>{workflow.name}</Button>{workflow.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}</span></SettingsTableCell>
            <SettingsTableCell className="truncate text-muted-foreground">{workflowDefinition(workflow.engine).name}</SettingsTableCell>
            <SettingsTableCell className="text-muted-foreground"><span className="grid gap-1" aria-label="Default agents">{agentLines(workflow).map(({ label, agent, fallback }) => <span key={label} className="flex min-w-0 items-center gap-1.5 text-xs" title={`${label}: ${agent?.name ?? fallback}`}>{agent ? <EntityAvatar kind="agent" id={agent.id} name={agent.name} seed={agent.avatarSeed} size="xs" /> : null}<span className={agent ? "truncate text-foreground" : "truncate"}>{agent?.name ?? fallback}</span></span>)}</span></SettingsTableCell>
            <SettingsTableCell className="truncate text-muted-foreground">{workflow.engine === REPAIR ? "Merged pull request" : deliveryLabel(workflow.deliveryTarget)}</SettingsTableCell>
            <SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={workflow.archivedAt ? "size-1.5 rounded-full bg-muted-foreground" : "size-1.5 rounded-full bg-emerald-500"} />{workflow.archivedAt ? "archived" : "active"}</span></SettingsTableCell>
            <SettingsTableCell className="p-0">
              <DropdownMenu>
                <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${workflow.name} actions`} title={`${workflow.name} actions`} />}><Ellipsis /></DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem disabled={Boolean(workflow.archivedAt) || currentCompany?.status !== "active"} onClick={() => requestNewTask({ workflowId: workflow.id })}><CirclePlus />Create task</DropdownMenuItem>
                  {admin ? <>
                    <DropdownMenuItem onClick={() => void duplicate(workflow)}><Copy />Duplicate</DropdownMenuItem>
                    {workflow.archivedAt
                      ? <DropdownMenuItem onClick={() => void patch(workflow, { archived: false }, "Unable to unarchive workflow")}><ArchiveRestore />Unarchive</DropdownMenuItem>
                      : <DropdownMenuItem onClick={() => setArchiveTarget(workflow)}><Archive />Archive</DropdownMenuItem>}
                  </> : null}
                </DropdownMenuContent>
              </DropdownMenu>
            </SettingsTableCell>
            <SettingsTableCell className="p-0">{admin ? <Button variant="ghost" size="icon-xs" aria-label={`Edit ${workflow.name} details`} title={`Edit ${workflow.name}`} onClick={() => edit(workflow)}><Pencil /></Button> : null}</SettingsTableCell>
          </SettingsTableRow>)}
        </SettingsTableGroup>
        {workflows.length > 0 && visible.length === 0 ? <SettingsTableEmpty columnCount={columns.length}>No workflows match the search.</SettingsTableEmpty> : null}
      </SettingsDataTable>
    </SettingsContent>

    <Dialog open={editor.kind !== "closed"} onOpenChange={(open) => { if (!open && !busy) { setEditor({ kind: "closed" }); setError(""); } }}>
      <DialogContent showCloseButton={!busy}>
        <DialogHeader><DialogTitle>{editor.kind === "edit" ? "Edit workflow" : "New workflow"}</DialogTitle></DialogHeader>
        {draft && definition ? <form className="max-h-[70dvh] overflow-y-auto" onSubmit={(event) => { event.preventDefault(); void save(); }}>
          <FieldGroup>
            {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <Field><FieldLabel htmlFor="workflow-name">Name</FieldLabel><Input id="workflow-name" autoFocus disabled={busy} value={draft.name} onChange={(event) => setDraft("name", event.target.value)} required /></Field>
            <Field><FieldLabel htmlFor="workflow-description">Description</FieldLabel><Textarea id="workflow-description" disabled={busy} value={draft.description ?? ""} onChange={(event) => setDraft("description", event.target.value)} rows={3} /></Field>
            <Field><FieldLabel htmlFor="workflow-engine">Built-in workflow</FieldLabel><Select disabled={busy} value={draft.engine} onValueChange={(value) => { if (value) selectEngine(value); }}><SelectTrigger id="workflow-engine"><SelectValue /></SelectTrigger><SelectContent>{WORKFLOWS.map((option) => <SelectItem key={option.id} value={option.id}>{option.name}</SelectItem>)}</SelectContent></Select>
              <ol aria-label={`${definition.name} steps`} className="mt-2 grid gap-1 text-xs text-muted-foreground">{definition.steps.map((step, index) => <li key={index} className="flex gap-2"><span className="w-4 shrink-0 text-right tabular-nums">{index + 1}.</span><span>{step}</span></li>)}</ol></Field>
            <FieldSet disabled={busy}>
              <FieldLegend variant="label">Default agents</FieldLegend>
              {profileSelect("workflow-root", "Coordinator", "root", draft.rootProfileId, "Project default", (value) => setDraft("rootProfileId", value))}
              {profileSelect("workflow-worker", "Worker", "worker", draft.workerProfileId, "Project default", (value) => setDraft("workerProfileId", value))}
              {definition.advisorRoles.map((role) => profileSelect(`workflow-advisor-${role}`, ADVISOR_LABELS[role], "root", draft.advisorProfileIds?.[role], "Same as Coordinator", (value) => setDraft("advisorProfileIds", { ...draft.advisorProfileIds, [role]: value })))}
            </FieldSet>
            <FieldSet disabled={busy}>
              <FieldLegend variant="label">Default configuration</FieldLegend>
              <Field><FieldLabel htmlFor="workflow-delivery-target">Delivery target</FieldLabel><Select disabled={busy || draft.engine === REPAIR} value={draft.engine === REPAIR ? "merged" : draft.deliveryTarget ?? "default"} onValueChange={(value) => setDraft("deliveryTarget", value === "default" || !value ? undefined : DeliveryTargetSchema.parse(value))}><SelectTrigger id="workflow-delivery-target"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Selected in the task</SelectItem>{taskDeliveryTargetOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="workflow-browser-evidence">Browser evidence</FieldLabel><Select disabled={busy} value={draft.visualEvidence ?? "default"} onValueChange={(value) => setDraft("visualEvidence", value === "default" || !value ? undefined : VisualEvidenceSchema.parse(value))}><SelectTrigger id="workflow-browser-evidence"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="default">Selected in the task</SelectItem><SelectItem value="off">Off</SelectItem><SelectItem value="capture">Capture</SelectItem><SelectItem value="required">Necessary</SelectItem></SelectContent></Select></Field>
              <Field orientation="horizontal"><Checkbox id="workflow-run-project-tests" disabled={busy || draft.engine === REPAIR} checked={draft.engine === REPAIR ? true : draft.runProjectTests ?? true} onCheckedChange={(value) => setDraft("runProjectTests", value === true)} /><FieldLabel htmlFor="workflow-run-project-tests">Run project tests</FieldLabel></Field>
            </FieldSet>
            <DialogFooter>
              <DialogClose disabled={busy} render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose>
              {editor.kind === "edit" ? <Button type="submit" size="sm" disabled={busy}>{busy ? "Saving…" : "Save workflow"}</Button> : <NewButton type="submit" disabled={busy}>{busy ? "Creating…" : "New workflow"}</NewButton>}
            </DialogFooter>
          </FieldGroup>
        </form> : null}
      </DialogContent>
    </Dialog>

    <AlertDialog open={archiveTarget !== null} onOpenChange={(open) => { if (!open) setArchiveTarget(null); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive {archiveTarget?.name}?</AlertDialogTitle>
          <AlertDialogDescription>Suplex removes archived workflows from the task dialog. Tasks that use this workflow continue. You can unarchive the workflow later.</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => { const target = archiveTarget; setArchiveTarget(null); if (target) void patch(target, { archived: true }, "Unable to archive workflow"); }}>Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsLayout>;
}
