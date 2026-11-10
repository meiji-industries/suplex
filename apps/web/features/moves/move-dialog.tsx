import { useEffect, useRef, useState, type ReactElement } from "react";
import { Bot, FolderKanban, GitPullRequest, ListTodo, MessageSquareText, Play, ShieldQuestion, SquareTerminal, Trash2 } from "lucide-react";

import { Shimmer } from "../../components/ai-elements/shimmer.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Breadcrumb, BreadcrumbItem, BreadcrumbList, BreadcrumbSeparator } from "../../components/ui/breadcrumb.js";
import { Button } from "../../components/ui/button.js";
import { ButtonGroup } from "../../components/ui/button-group.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Spinner } from "../../components/ui/spinner.js";
import { MoveDraftBodySchema, MoveRunnerSchema, type MoveBody } from "../../contracts/moves.js";
import { WorkflowIdSchema } from "../../contracts/workflows.js";
import type { MoveResponse } from "../../contracts/generated/MoveResponse.js";
import type { ApiProfile, ApiProject } from "../../shell/view-shared.js";
import { isProfileAllowed } from "../projects/lib/provider-policy.js";
import { TaskOptionFilter } from "../tasks/task-option-filter.js";
import { TaskChecksOption, TaskDeliveryOption, workflowIcons } from "../tasks/task-settings-options.js";
import { WORKFLOWS } from "../tasks/workflow-presentation.js";
import { supportsDeliveryTarget } from "../tasks/lib/delivery-target-capabilities.js";
import { createMove, deleteMove, draftMove, listProfiles, updateMove } from "./lib/move-api.js";
import { applyMoveDraft, taskDefaults, withRunner } from "./lib/move-draft.js";
import { Textarea } from "../../components/ui/textarea.js";
import { PlaceholdersHelp } from "./placeholders-help.js";
import { ScriptEditor } from "./prompt-editor.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";

export const runnerLabels = { prompt: "Prompt", script: "Shell script", pull_request_tasks: "Each pull request", task: "Task" } as const;

const runnerOptions = [
  { value: "prompt", label: "a prompt", icon: <MessageSquareText aria-hidden="true" className="size-[11px]" /> },
  { value: "script", label: "a shell script", icon: <SquareTerminal aria-hidden="true" className="size-[11px]" /> },
  { value: "pull_request_tasks", label: "for each pull request", icon: <GitPullRequest aria-hidden="true" className="size-[11px]" /> },
  { value: "task", label: "as a task", icon: <ListTodo aria-hidden="true" className="size-[11px]" /> },
];
/** Review and repair needs a pull request, so "for each pull request" covers it. */
const workflowOptions = WORKFLOWS.filter(definition => definition.id !== "refine_pull_request").map(definition => ({ value: definition.id, label: definition.name, icon: workflowIcons[definition.id] }));

const startOptions = [
  { value: "confirm", label: "ask before start", icon: <ShieldQuestion aria-hidden="true" className="size-[11px]" /> },
  { value: "direct", label: "start right away", icon: <Play aria-hidden="true" className="size-[11px]" /> },
];

const placeholders = {
  prompt: "Write a prompt for something you do all the time",
  script: "npm run test  # Enter your command. Multiline is okay.",
  pull_request_tasks: "Instructions for each pull request",
  task: "Write a description",
} as const;

/** Prompt and script runners open a host terminal, so only an admin can choose them. */
const memberRunnerOptions = runnerOptions.filter(option => option.value === "pull_request_tasks" || option.value === "task");

export function MoveDialog({ companyId, projects, move, open, onOpenChange, onSaved, onDeleted }: {
  companyId: string;
  projects: ApiProject[];
  move: MoveResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (move: MoveResponse) => void;
  onDeleted: (moveId: string) => void;
}): ReactElement {
  const admin = useOptionalCompanyContext()?.user?.role === "admin";
  const [draft, setDraft] = useState<MoveBody>(() => blank(projects, admin));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [description, setDescription] = useState("");
  const [drafting, setDrafting] = useState(false);
  const [draftResult, setDraftResult] = useState<{ variant: "default" | "destructive"; text: string } | null>(null);
  const drafts = useRef<AbortController | null>(null);
  const locked = busy || drafting;
  useEffect(() => {
    if (!open) return;
    setDraft(move ? { projectId: move.projectId, name: move.name, prompt: move.prompt, runner: move.runner, profileId: move.profileId, confirm: move.confirm, workflow: move.workflow, deliveryTarget: move.deliveryTarget, runProjectTests: move.runProjectTests, visualEvidence: move.visualEvidence } : blank(projects, admin));
    setError("");
    setDescription("");
    setDraftResult(null);
    let current = true;
    listProfiles().then(next => { if (current) setProfiles(next); }, () => { if (current) setProfiles([]); });
    return () => { current = false; };
  }, [open, move, projects, admin]);
  // Closing the dialog cancels the draft, and a cancelled request ends the agent.
  useEffect(() => () => { drafts.current?.abort(); drafts.current = null; setDrafting(false); }, [open]);
  const set = <Key extends keyof MoveBody>(key: Key, value: MoveBody[Key]): void => setDraft(current => ({ ...current, [key]: value }));
  const project = projects.find(candidate => candidate.id === draft.projectId);
  const connection = project?.integration?.repository;
  useEffect(() => {
    if (draft.runner === "task" && draft.deliveryTarget && !supportsDeliveryTarget(connection, draft.deliveryTarget)) setDraft(current => ({ ...current, deliveryTarget: "pull_request_draft" }));
  }, [draft.runner, draft.deliveryTarget, connection]);
  const agents = profiles.filter(profile => profile.role === "worker" && !profile.archivedAt && isProfileAllowed(project?.providerPolicy, profile));
  const fallback = profiles.find(profile => profile.id === project?.workerProfileId);
  const agentOptions = [{ value: "default", label: "the default agent", icon: fallback ? <EntityAvatar kind="agent" id={fallback.id} name={fallback.name} seed={fallback.avatarSeed} size="xs" /> : <Bot aria-hidden="true" className="size-[11px]" /> }, ...agents.map(profile => ({ value: profile.id, label: profile.name, icon: <EntityAvatar kind="agent" id={profile.id} name={profile.name} seed={profile.avatarSeed} size="xs" /> }))];
  const save = async (): Promise<void> => {
    setBusy(true); setError("");
    try { onSaved(move ? await updateMove(move.id, draft) : await createMove(companyId, draft)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Suplex could not save the move."); }
    finally { setBusy(false); }
  };
  const draftBody = MoveDraftBodySchema.safeParse({ description });
  const requestDraft = async (): Promise<void> => {
    if (!draftBody.success || !draft.projectId || locked) return;
    const controller = new AbortController();
    drafts.current = controller;
    setDrafting(true); setDraftResult(null);
    try {
      const response = await draftMove(draft.projectId, draftBody.data, controller.signal);
      if (controller.signal.aborted) return;
      const proposed = response.draft;
      if (proposed) {
        setDraft(current => applyMoveDraft(current, proposed, admin));
        setDraftResult(proposed.note ? { variant: "default", text: proposed.note } : null);
      } else setDraftResult({ variant: "destructive", text: response.reason ?? "The agent rejected the description." });
    } catch (cause) {
      if (!controller.signal.aborted) setDraftResult({ variant: "destructive", text: cause instanceof Error ? cause.message : "The agent could not write a draft." });
    } finally {
      if (drafts.current === controller) { drafts.current = null; setDrafting(false); }
    }
  };
  const ready = Boolean(draft.projectId && draft.name.trim() && (draft.runner === "pull_request_tasks" || draft.runner === "task" || draft.prompt.trim()));
  return <>
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="w-[min(92vw,936px)] max-w-none gap-0 p-0 sm:max-w-[936px]" showCloseButton={false}>
        <form className="max-h-[85vh] min-w-0 overflow-y-auto rounded-xl" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={event => { event.preventDefault(); if (ready && !locked) void save(); }}>
          <div className="flex min-h-[230px] min-w-0 flex-col">
            <DialogHeader className="px-4 pt-6 pb-3 sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <Breadcrumb><BreadcrumbList className="gap-2 text-sm"><BreadcrumbItem>
                  <DropdownMenu><DropdownMenuTrigger render={<Button className="pl-0" type="button" variant="ghost" size="xs" aria-label="Project" disabled={locked || !projects.length} />}>
                    {project ? <EntityAvatar kind="project" id={project.id} name={project.name} size="xs" /> : <FolderKanban className="size-3.5 text-muted-foreground" />}<span className="max-w-40 truncate">{project?.name ?? "Project"}</span>
                  </DropdownMenuTrigger><DropdownMenuContent align="start">{projects.map(candidate => <DropdownMenuItem className="text-xs" key={candidate.id} onClick={() => set("projectId", candidate.id)}><EntityAvatar kind="project" id={candidate.id} name={candidate.name} size="xs" /><span className="min-w-0 flex-1 truncate">{candidate.name}</span>{candidate.id === draft.projectId ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
                </BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><DialogTitle className="font-normal">{move ? "Edit move" : "New move"}</DialogTitle></BreadcrumbItem></BreadcrumbList></Breadcrumb>
                {move ? <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setDeleting(true)}><Trash2 className="size-3.5" />Delete</Button> : null}
              </div>
            </DialogHeader>
            {move ? null : <div className="grid gap-2 px-5 pb-2">
              <Textarea aria-label="Describe the move" placeholder="Describe what this move should do and which inputs it asks for" maxLength={2000} value={description} disabled={locked} onChange={event => setDescription(event.target.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.stopPropagation(); void requestDraft(); } }} />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="xs" disabled={locked || !draftBody.success || !draft.projectId} onClick={() => void requestDraft()}>{drafting ? <Spinner /> : null}Draft move</Button>
                {drafting ? <div role="status" className="text-xs"><Shimmer as="span" duration={1.6}>The agent writes a draft</Shimmer></div> : null}
              </div>
              {draftResult ? <Alert variant={draftResult.variant}><AlertDescription>{draftResult.text}</AlertDescription></Alert> : null}
            </div>}
            <div className="flex-1 space-y-2 px-5 pt-1">
              <Input aria-label="Move name" autoFocus placeholder="Move name" value={draft.name} disabled={locked} onChange={event => set("name", event.target.value)} className="h-10 border-0 bg-transparent px-0 font-medium placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 data-[size=default]:text-xl data-[size=default]:md:text-xl dark:bg-transparent" />
              {draft.runner === "script"
                ? <ScriptEditor label="Script" value={draft.prompt} onChange={value => set("prompt", value)} placeholder={placeholders.script} disabled={locked} />
                : <Textarea aria-label="Prompt" placeholder={placeholders[draft.runner]} value={draft.prompt} disabled={locked} onChange={event => set("prompt", event.target.value)} className="min-h-20 resize-none border-0 bg-transparent px-0 py-1 text-sm font-normal placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent" />}
              <PlaceholdersHelp text={draft.prompt} />
            </div>
            {error ? <div className="px-5 pt-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
            <div className="flex flex-wrap items-center gap-2 p-6">
              <div className="-m-1 max-w-full overflow-x-auto p-1">
                <ButtonGroup aria-label="Move options">
                  <TaskOptionFilter prefix="Run" label="Run" value={draft.runner} disabled={locked} options={admin ? runnerOptions : memberRunnerOptions} onValueChange={value => setDraft(current => withRunner(current, MoveRunnerSchema.parse(value)))} />
                  {draft.runner === "task" ? <>
                    <TaskOptionFilter prefix="using" label="Workflow" value={draft.workflow ?? "standard"} disabled={locked} options={workflowOptions} onValueChange={value => set("workflow", WorkflowIdSchema.parse(value))} />
                    <TaskChecksOption runProjectTests={draft.runProjectTests ?? true} visualEvidence={draft.visualEvidence ?? "off"} verificationCommand={project?.verificationCommand} disabled={locked} onChange={checks => setDraft(current => ({ ...current, ...checks }))} />
                    <TaskDeliveryOption value={draft.deliveryTarget ?? "pull_request_ready"} connection={connection} disabled={locked} onChange={target => set("deliveryTarget", target)} />
                  </> : <>
                    {draft.runner !== "script" ? <TaskOptionFilter prefix="with" label="Agent" value={draft.profileId ?? "default"} disabled={locked} options={agentOptions} onValueChange={value => set("profileId", value === "default" ? null : value)} /> : null}
                    <TaskOptionFilter prefix="and" label="Start" value={draft.confirm ? "confirm" : "direct"} disabled={locked} options={startOptions} onValueChange={value => set("confirm", value === "confirm")} />
                  </>}
                </ButtonGroup>
              </div>
              <DialogFooter className="ml-auto flex-row items-center gap-1 sm:justify-end">
                <NewButton type="submit" disabled={locked || !ready} title={move ? "Save move (⌘Enter)" : "Create move (⌘Enter)"}>{busy ? (move ? "Saving…" : "Creating…") : move ? "Save move" : "Create move"}</NewButton>
              </DialogFooter>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <DeleteMoveDialog move={move} open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
  </>;
}

function blank(projects: ApiProject[], admin: boolean): MoveBody {
  return { projectId: projects[0]?.id ?? "", name: "", prompt: "", runner: admin ? "prompt" : "task", profileId: null, confirm: false, ...taskDefaults };
}

/** Asks before it deletes a move and its run history. */
export function DeleteMoveDialog({ move, open, onOpenChange, onDeleted }: { move: MoveResponse | null; open: boolean; onOpenChange: (open: boolean) => void; onDeleted: (moveId: string) => void }): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (open) setError(""); }, [open]);
  const remove = async (): Promise<void> => {
    if (!move) return;
    setBusy(true); setError("");
    try { await deleteMove(move.id); onOpenChange(false); onDeleted(move.id); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Suplex could not delete the move."); }
    finally { setBusy(false); }
  };
  return <AlertDialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
    <AlertDialogContent>
      <AlertDialogHeader><AlertDialogTitle>Delete {move?.name}?</AlertDialogTitle></AlertDialogHeader>
      {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
      <AlertDialogFooter>
        <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
        <AlertDialogAction variant="destructive" disabled={busy} onClick={event => { event.preventDefault(); void remove(); }}>Delete</AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  </AlertDialog>;
}
