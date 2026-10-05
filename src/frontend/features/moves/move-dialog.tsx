import { useEffect, useState, type ReactElement } from "react";
import { Bot, FolderKanban, GitPullRequest, ListTodo, MessageSquareText, Play, ShieldQuestion, SquareTerminal, Trash2 } from "lucide-react";

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
import { MoveRunnerSchema, type MoveBody } from "../../contracts/moves.js";
import { WorkflowIdSchema } from "../../contracts/workflows.js";
import type { MoveResponse } from "../../contracts/generated/MoveResponse.js";
import type { ApiProfile, ApiProject } from "../../shell/view-shared.js";
import { isProfileAllowed } from "../projects/lib/provider-policy.js";
import { TaskOptionFilter } from "../tasks/task-option-filter.js";
import { TaskChecksOption, TaskDeliveryOption, workflowIcons } from "../tasks/task-settings-options.js";
import { WORKFLOWS } from "../tasks/workflow-presentation.js";
import { supportsDeliveryTarget } from "../tasks/lib/delivery-target-capabilities.js";
import { createMove, deleteMove, listProfiles, updateMove } from "./lib/move-api.js";
import { Textarea } from "../../components/ui/textarea.js";
import { PlaceholdersHelp } from "./placeholders-help.js";
import { ScriptEditor } from "./prompt-editor.js";

export const runnerLabels = { prompt: "Prompt", script: "Shell script", pull_request_tasks: "Each pull request", task: "Task" } as const;

const runnerOptions = [
  { value: "prompt", label: "a prompt", icon: <MessageSquareText aria-hidden="true" className="size-[11px]" /> },
  { value: "script", label: "a shell script", icon: <SquareTerminal aria-hidden="true" className="size-[11px]" /> },
  { value: "pull_request_tasks", label: "for each pull request", icon: <GitPullRequest aria-hidden="true" className="size-[11px]" /> },
  { value: "task", label: "as a task", icon: <ListTodo aria-hidden="true" className="size-[11px]" /> },
];
/** Review and repair needs a pull request, so "for each pull request" covers it. */
const workflowOptions = WORKFLOWS.filter(definition => definition.id !== "refine_pull_request").map(definition => ({ value: definition.id, label: definition.name, icon: workflowIcons[definition.id] }));
/** Agents with an interactive command line for a move. */
const terminalProviders = new Set(["claude-code", "codex"]);

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

export function MoveDialog({ companyId, projects, move, open, onOpenChange, onSaved, onDeleted }: {
  companyId: string;
  projects: ApiProject[];
  move: MoveResponse | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: (move: MoveResponse) => void;
  onDeleted: (moveId: string) => void;
}): ReactElement {
  const [draft, setDraft] = useState<MoveBody>(() => blank(projects));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  useEffect(() => {
    if (!open) return;
    setDraft(move ? { projectId: move.projectId, name: move.name, prompt: move.prompt, runner: move.runner, profileId: move.profileId, confirm: move.confirm, workflow: move.workflow, deliveryTarget: move.deliveryTarget, runProjectTests: move.runProjectTests, visualEvidence: move.visualEvidence } : blank(projects));
    setError("");
    let current = true;
    listProfiles().then(next => { if (current) setProfiles(next); }, () => { if (current) setProfiles([]); });
    return () => { current = false; };
  }, [open, move, projects]);
  const set = <Key extends keyof MoveBody>(key: Key, value: MoveBody[Key]): void => setDraft(current => ({ ...current, [key]: value }));
  const project = projects.find(candidate => candidate.id === draft.projectId);
  const connection = project?.integration?.repository;
  useEffect(() => {
    if (draft.runner === "task" && draft.deliveryTarget && !supportsDeliveryTarget(connection, draft.deliveryTarget)) setDraft(current => ({ ...current, deliveryTarget: "pull_request_draft" }));
  }, [draft.runner, draft.deliveryTarget, connection]);
  // A prompt opens the agent in a terminal; pull request tasks take any allowed Worker.
  const agents = profiles.filter(profile => profile.role === "worker" && !profile.archivedAt && (draft.runner !== "prompt" || terminalProviders.has(profile.provider)) && isProfileAllowed(project?.providerPolicy, profile));
  const fallback = profiles.find(profile => profile.id === project?.workerProfileId);
  const agentOptions = [{ value: "default", label: "the default agent", icon: fallback ? <EntityAvatar kind="agent" id={fallback.id} name={fallback.name} seed={fallback.avatarSeed} size="xs" /> : <Bot aria-hidden="true" className="size-[11px]" /> }, ...agents.map(profile => ({ value: profile.id, label: profile.name, icon: <EntityAvatar kind="agent" id={profile.id} name={profile.name} seed={profile.avatarSeed} size="xs" /> }))];
  const save = async (): Promise<void> => {
    setBusy(true); setError("");
    try { onSaved(move ? await updateMove(move.id, draft) : await createMove(companyId, draft)); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Suplex could not save the move."); }
    finally { setBusy(false); }
  };
  const ready = Boolean(draft.projectId && draft.name.trim() && (draft.runner === "pull_request_tasks" || draft.runner === "task" || draft.prompt.trim()));
  return <>
    <Dialog open={open} onOpenChange={next => { if (!busy) onOpenChange(next); }}>
      <DialogContent className="w-[min(92vw,936px)] max-w-none gap-0 p-0 sm:max-w-[936px]" showCloseButton={false}>
        <form className="max-h-[85vh] min-w-0 overflow-y-auto rounded-xl" onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "Enter") { event.preventDefault(); event.currentTarget.requestSubmit(); } }} onSubmit={event => { event.preventDefault(); if (ready) void save(); }}>
          <div className="flex min-h-[230px] min-w-0 flex-col">
            <DialogHeader className="px-4 pt-6 pb-3 sm:px-5">
              <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                <Breadcrumb><BreadcrumbList className="gap-2 text-sm"><BreadcrumbItem>
                  <DropdownMenu><DropdownMenuTrigger render={<Button className="pl-0" type="button" variant="ghost" size="xs" aria-label="Project" disabled={busy || !projects.length} />}>
                    {project ? <EntityAvatar kind="project" id={project.id} name={project.name} size="xs" /> : <FolderKanban className="size-3.5 text-muted-foreground" />}<span className="max-w-40 truncate">{project?.name ?? "Project"}</span>
                  </DropdownMenuTrigger><DropdownMenuContent align="start">{projects.map(candidate => <DropdownMenuItem className="text-xs" key={candidate.id} onClick={() => set("projectId", candidate.id)}><EntityAvatar kind="project" id={candidate.id} name={candidate.name} size="xs" /><span className="min-w-0 flex-1 truncate">{candidate.name}</span>{candidate.id === draft.projectId ? <span aria-label="Selected">✓</span> : null}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
                </BreadcrumbItem><BreadcrumbSeparator /><BreadcrumbItem><DialogTitle className="font-normal">{move ? "Edit move" : "New move"}</DialogTitle></BreadcrumbItem></BreadcrumbList></Breadcrumb>
                {move ? <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={() => setDeleting(true)}><Trash2 className="size-3.5" />Delete</Button> : null}
              </div>
            </DialogHeader>
            <div className="flex-1 space-y-2 px-5 pt-1">
              <Input aria-label="Move name" autoFocus placeholder="Move name" value={draft.name} onChange={event => set("name", event.target.value)} className="h-10 border-0 bg-transparent px-0 font-medium placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 data-[size=default]:text-xl data-[size=default]:md:text-xl dark:bg-transparent" />
              {draft.runner === "script"
                ? <ScriptEditor label="Script" value={draft.prompt} onChange={value => set("prompt", value)} placeholder={placeholders.script} disabled={busy} />
                : <Textarea aria-label="Prompt" placeholder={placeholders[draft.runner]} value={draft.prompt} disabled={busy} onChange={event => set("prompt", event.target.value)} className="min-h-20 resize-none border-0 bg-transparent px-0 py-1 text-sm font-normal placeholder:text-muted-foreground/70 shadow-none focus-visible:ring-0 md:text-sm dark:bg-transparent" />}
              <PlaceholdersHelp text={draft.prompt} />
            </div>
            {error ? <div className="px-5 pt-3"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
            <div className="flex flex-wrap items-center gap-2 p-6">
              <div className="-m-1 max-w-full overflow-x-auto p-1">
                <ButtonGroup aria-label="Move options">
                  <TaskOptionFilter prefix="Run" label="Run" value={draft.runner} disabled={busy} options={runnerOptions} onValueChange={value => setDraft(current => withRunner(current, MoveRunnerSchema.parse(value), profiles))} />
                  {draft.runner === "task" ? <>
                    <TaskOptionFilter prefix="using" label="Workflow" value={draft.workflow ?? "standard"} disabled={busy} options={workflowOptions} onValueChange={value => set("workflow", WorkflowIdSchema.parse(value))} />
                    <TaskChecksOption runProjectTests={draft.runProjectTests ?? true} visualEvidence={draft.visualEvidence ?? "off"} verificationCommand={project?.verificationCommand} disabled={busy} onChange={checks => setDraft(current => ({ ...current, ...checks }))} />
                    <TaskDeliveryOption value={draft.deliveryTarget ?? "pull_request_ready"} connection={connection} disabled={busy} onChange={target => set("deliveryTarget", target)} />
                  </> : <>
                    {draft.runner !== "script" ? <TaskOptionFilter prefix="with" label="Agent" value={draft.profileId ?? "default"} disabled={busy} options={agentOptions} onValueChange={value => set("profileId", value === "default" ? null : value)} /> : null}
                    <TaskOptionFilter prefix="and" label="Start" value={draft.confirm ? "confirm" : "direct"} disabled={busy} options={startOptions} onValueChange={value => set("confirm", value === "confirm")} />
                  </>}
                </ButtonGroup>
              </div>
              <DialogFooter className="ml-auto flex-row items-center gap-1 sm:justify-end">
                <NewButton type="submit" disabled={busy || !ready} title={move ? "Save move (⌘Enter)" : "Create move (⌘Enter)"}>{busy ? (move ? "Saving…" : "Creating…") : move ? "Save move" : "Create move"}</NewButton>
              </DialogFooter>
            </div>
          </div>
        </form>
      </DialogContent>
    </Dialog>
    <DeleteMoveDialog move={move} open={deleting} onOpenChange={setDeleting} onDeleted={onDeleted} />
  </>;
}

/**
 * A script keeps no agent, and a prompt keeps only an agent that runs in a terminal.
 * A task uses the project's agents, starts without a confirmation, and keeps task settings that other runners clear.
 */
function withRunner(draft: MoveBody, runner: MoveBody["runner"], profiles: ApiProfile[]): MoveBody {
  if (runner === "task") return { ...draft, runner, profileId: null, confirm: false };
  const provider = profiles.find(profile => profile.id === draft.profileId)?.provider;
  const keep = runner !== "script" && (runner !== "prompt" || !provider || terminalProviders.has(provider));
  return { ...draft, ...taskDefaults, runner, profileId: keep ? draft.profileId ?? null : null };
}

const taskDefaults = { workflow: "standard", deliveryTarget: "pull_request_ready", runProjectTests: true, visualEvidence: "off" } as const;

function blank(projects: ApiProject[]): MoveBody {
  return { projectId: projects[0]?.id ?? "", name: "", prompt: "", runner: "prompt", profileId: null, confirm: false, ...taskDefaults };
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
