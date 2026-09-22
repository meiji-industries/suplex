import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { providerIcons } from "../../components/app/provider-icons.js";
import {
  SettingsDataTable,
  SettingsTableCell,
  SettingsTableEmpty,
  SettingsTableGroup,
  SettingsTableRow,
  SettingsToolbar,
  type SettingsTableColumn,
} from "../../components/app/settings-table.js";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Archive, ArchiveRestore, Copy, Ellipsis, Pencil, Zap } from "lucide-react";
import {
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type ReactElement,
  type SetStateAction,
} from "react";
import type { ApiProfile } from "../../shell/view-shared.js";

const AGENT_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 240 },
  { key: "role", label: "Role", width: 140 },
  { key: "provider", label: "Provider", width: 120 },
  { key: "model", label: "Model", width: 200 },
  { key: "reasoning", label: "Reasoning", width: 90 },
  { key: "status", label: "Status", width: 100 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

function AgentNameEditor({
  agent,
  onSave,
}: {
  agent: ApiProfile;
  onSave: (name: string) => Promise<void>;
}): ReactElement {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(agent.name);
  const [saving, setSaving] = useState(false);
  const skipBlur = useRef(false);
  useEffect(() => {
    if (!editing) setDraft(agent.name);
  }, [editing, agent.name]);
  const save = async (): Promise<void> => {
    if (skipBlur.current) {
      skipBlur.current = false;
      return;
    }
    const next = draft.trim();
    if (next === agent.name) {
      setEditing(false);
      return;
    }
    if (!next || saving) return;
    setSaving(true);
    try {
      await onSave(next);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };
  if (editing)
    return (
      <Input
        aria-label="Agent name"
        autoFocus
        className="h-7"
        disabled={saving}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => void save()}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            skipBlur.current = true;
            setDraft(agent.name);
            setEditing(false);
          } else if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
    );
  return (
    <button
      type="button"
      data-agent-name-editor
      aria-label={`Rename ${agent.name}`}
      className="min-w-0 truncate text-left"
      onClick={() => {
        skipBlur.current = false;
        setDraft(agent.name);
        setEditing(true);
      }}
    >
      {agent.name}
    </button>
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
}): ReactElement {
  return (
    <section>
      <SettingsToolbar
        searchLabel="Filter internal agents by name"
        searchPlaceholder="Filter by name"
        filterLabel="All roles"
        searchWidth="compact"
        actions={<NewButton onClick={onOpenNewAgent}>New agent</NewButton>}
      />
      <SettingsDataTable
        label="Internal Agents"
        columns={AGENT_COLUMNS}
        className="mt-4"
      >
        <SettingsTableGroup
          label="Internal agents"
          count={agents.length}
          columnCount={AGENT_COLUMNS.length}
        >
          {sortedAgents.map((agent) => (
            <SettingsTableRow
              aria-label={`Edit ${agent.name}`}
              key={agent.id}
              onClick={(event) => {
                if (
                  !(event.target as HTMLElement).closest(
                    "button, input, label, [data-base-ui-portal]",
                  )
                )
                  onOpenEditAgent(agent);
              }}
              tabIndex={0}
            >
              <SettingsTableCell>
                <span className="flex min-w-0 items-center gap-3">
                  <EntityAvatar
                    kind="agent"
                    id={agent.id}
                    name={agent.name}
                    seed={agent.avatarSeed}
                  />
                  <AgentNameEditor
                    agent={agent}
                    onSave={(name) =>
                      onPatchAgent(agent, { name }, "Unable to rename agent")
                    }
                  />
                  {agent.archivedAt ? (
                    <Badge variant="secondary">Archived</Badge>
                  ) : null}
                </span>
              </SettingsTableCell>
              <SettingsTableCell>
                {agent.role === "root" ? "Coordinator" : "Worker"}
              </SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">
                {providerIcons[agent.provider].label}
              </SettingsTableCell>
              <SettingsTableCell>
                <span className="flex min-w-0 items-center gap-1.5">
                  <span className="truncate">{agent.model}</span>
                  {agent.serviceTier === "priority" ? (
                    <span className="inline-flex" title="Priority service tier">
                      <Zap
                        role="img"
                        aria-label="Priority service tier"
                        fill="currentColor"
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                    </span>
                  ) : null}
                </span>
              </SettingsTableCell>
              <SettingsTableCell className="truncate text-muted-foreground">
                {agent.reasoningLevel}
              </SettingsTableCell>
              <SettingsTableCell>
                <span className="flex items-center gap-1.5 text-muted-foreground">
                  <span
                    className={
                      agent.archivedAt
                        ? "size-1.5 rounded-full bg-muted-foreground"
                        : "size-1.5 rounded-full bg-emerald-500"
                    }
                  />
                  {agent.archivedAt ? "archived" : "active"}
                </span>
              </SettingsTableCell>
              <SettingsTableCell className="p-0">
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
                  </DropdownMenuContent>
                </DropdownMenu>
              </SettingsTableCell>
              <SettingsTableCell className="p-0">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label={`Edit ${agent.name}`}
                  title={`Edit ${agent.name}`}
                  onClick={() => onOpenEditAgent(agent)}
                >
                  <Pencil />
                </Button>
              </SettingsTableCell>
            </SettingsTableRow>
          ))}
        </SettingsTableGroup>
        {agents.length === 0 ? (
          <SettingsTableEmpty columnCount={AGENT_COLUMNS.length}>
            No internal agents configured.
          </SettingsTableEmpty>
        ) : null}
      </SettingsDataTable>
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
              Forge removes archived agents from the task and project lists.
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
    </section>
  );
}
