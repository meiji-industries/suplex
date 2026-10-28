import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { providerIcons } from "../../components/app/provider-icons.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../../components/ui/alert-dialog.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import { NewButton } from "../../components/ui/new-button.js";
import { SettingsSectionHeader } from "../settings/settings-layout.js";
import { Archive, ArchiveRestore, Copy, Ellipsis, Pencil, Trash2, Zap } from "lucide-react";
import type {
  Dispatch,
  ReactElement,
  ReactNode,
  SetStateAction,
} from "react";
import type { ApiProfile } from "../../shell/view-shared.js";
import { modelHint } from "./model-hints.js";

const SEEDED_AGENT_DESCRIPTIONS: Record<string, string> = {
  profile_native_root: "Plans each task and reviews the changes of the Worker.",
  profile_native_independent: "Provides a second plan, reviews changes, and rates pull requests.",
  profile_native_worker: "Builds the changes for each task.",
};

export const isDefaultAgent = (agent: ApiProfile): boolean =>
  agent.id in SEEDED_AGENT_DESCRIPTIONS;

export function agentDescription(agent: ApiProfile): string {
  const seeded = SEEDED_AGENT_DESCRIPTIONS[agent.id];
  if (seeded) return seeded;
  const role =
    agent.role === "root"
      ? "Plans tasks and reviews changes."
      : "Builds the changes for tasks.";
  const hint = modelHint(agent.model);
  return hint ? `${role} ${hint}` : role;
}

const REASONING_LABELS: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
  max: "Max",
};

export function AgentCard({
  agent,
  actions,
}: {
  agent: ApiProfile;
  actions?: ReactNode;
}): ReactElement {
  return (
    <Card highlighted size="sm" aria-label={agent.name}>
      <CardHeader>
        <CardTitle>
          <span className="flex min-w-0 items-center gap-2">
            <EntityAvatar
              kind="agent"
              id={agent.id}
              name={agent.name}
              seed={agent.avatarSeed}
            />
            <span className="truncate">{agent.name}</span>
          </span>
        </CardTitle>
        <CardDescription>
          <span className="flex items-center gap-2">
            {agent.role === "root" ? "Coordinator" : "Worker"}
            {isDefaultAgent(agent) ? <Badge variant="outline">Default</Badge> : null}
          </span>
        </CardDescription>
        {actions ? <CardAction>{actions}</CardAction> : null}
      </CardHeader>
      <CardContent>
        <p>{agentDescription(agent)}</p>
        <p className="text-xs text-muted-foreground">
          {providerIcons[agent.provider].label} · {agent.model}{" "}
          {REASONING_LABELS[agent.reasoningLevel] ?? agent.reasoningLevel}
          {agent.serviceTier === "priority" ? <> <span title="Priority"><Zap className="inline size-3.5 align-text-bottom" role="img" aria-label="Priority" /></span></> : ""}
        </p>
        {agent.archivedAt ? <Badge variant="secondary">Archived</Badge> : null}
      </CardContent>
    </Card>
  );
}

export function InternalAgentsSection({
  agents,
  sortedAgents,
  archiveTarget,
  onArchiveTargetChange,
  onOpenNewAgent,
  onOpenEditAgent,
  onPatchAgent,
  onDuplicateAgent,
  deleteTarget,
  onDeleteTargetChange,
  onDeleteAgent,
}: {
  agents: readonly ApiProfile[];
  sortedAgents: ApiProfile[];
  archiveTarget: ApiProfile | null;
  onArchiveTargetChange: Dispatch<SetStateAction<ApiProfile | null>>;
  onOpenNewAgent: () => void;
  onOpenEditAgent: (agent: ApiProfile) => void;
  onPatchAgent: (
    agent: ApiProfile,
    body: Record<string, unknown>,
    fallback: string,
  ) => Promise<void>;
  onDuplicateAgent: (agent: ApiProfile) => Promise<void>;
  deleteTarget: ApiProfile | null;
  onDeleteTargetChange: Dispatch<SetStateAction<ApiProfile | null>>;
  onDeleteAgent: (agent: ApiProfile) => Promise<void>;
}): ReactElement {
  return (
    <section className="mb-10">
      <SettingsSectionHeader
        title="Internal agents"
        description="Suplex runs an internal agent as the Coordinator or Worker for a task."
        actions={<NewButton onClick={onOpenNewAgent}>Add agent</NewButton>}
      />
      {agents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No internal agents configured.
        </p>
      ) : (
        <div
          className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3"
          aria-label="Internal agents"
        >
          {sortedAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              actions={
                <span className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Edit ${agent.name}`}
                    title={`Edit ${agent.name}`}
                    onClick={() => onOpenEditAgent(agent)}
                  >
                    <Pencil />
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={`${agent.name} actions`}
                          title={`${agent.name} actions`}
                        />
                      }
                    >
                      <Ellipsis />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem
                        onClick={() => void onDuplicateAgent(agent)}
                      >
                        <Copy />
                        Duplicate
                      </DropdownMenuItem>
                      {agent.archivedAt ? (
                        <DropdownMenuItem
                          onClick={() =>
                            void onPatchAgent(
                              agent,
                              { archived: false },
                              "Unable to unarchive agent",
                            )
                          }
                        >
                          <ArchiveRestore />
                          Unarchive
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => onArchiveTargetChange(agent)}
                        >
                          <Archive />
                          Archive
                        </DropdownMenuItem>
                      )}
                      <DropdownMenuItem
                        variant="destructive"
                        onClick={() => onDeleteTargetChange(agent)}
                      >
                        <Trash2 />
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </span>
              }
            />
          ))}
        </div>
      )}
      <AlertDialog
        open={archiveTarget !== null}
        onOpenChange={(open) => {
          if (!open) onArchiveTargetChange(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {archiveTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Suplex removes archived agents from the task and project lists.
              Tasks that use this agent continue. You can unarchive the agent
              later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = archiveTarget;
                onArchiveTargetChange(null);
                if (target)
                  void onPatchAgent(
                    target,
                    { archived: true },
                    "Unable to archive agent",
                  );
              }}
            >
              Archive
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) onDeleteTargetChange(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Suplex permanently deletes this agent. Tasks that use this agent
              continue. You cannot undo this action.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const target = deleteTarget;
                onDeleteTargetChange(null);
                if (target) void onDeleteAgent(target);
              }}
            >
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
