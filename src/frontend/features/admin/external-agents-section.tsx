import { EntityAvatar } from "../../components/app/entity-avatar.js";
import {
  SettingsDataTable,
  SettingsTableCell,
  SettingsTableEmpty,
  SettingsTableGroup,
  SettingsTableRow,
  type SettingsTableColumn,
} from "../../components/app/settings-table.js";
import { Button } from "../../components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu.js";
import { NewButton } from "../../components/ui/new-button.js";
import { SettingsSectionHeader } from "../settings/settings-layout.js";
import {
  adminDate,
  type ApiExternalAgent,
  type ApiProject,
} from "../../shell/view-shared.js";
import { Ellipsis, Key, Pencil, RotateCw, ShieldAlert } from "lucide-react";
import type { ReactElement } from "react";

const EXTERNAL_AGENT_AGENT_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 200 },
  { key: "status", label: "Status", width: 280 },
  { key: "projects", label: "Projects", width: 180 },
  { key: "credentialCreatedAt", label: "Connected with", width: 140 },
  { key: "lastUsed", label: "Last used", width: 140 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

export function ExternalAgentsSection({
  agents,
  projects,
  pendingAction,
  onOpenNewAgent,
  onReissuePairing,
  onRotateAgent,
  onEditProjects,
  onEditAvatar,
  onRevokeAgent,
  onClearPendingAction,
}: {
  agents: ApiExternalAgent[];
  projects: ApiProject[];
  pendingAction: string;
  onOpenNewAgent: () => void;
  onReissuePairing: (agent: ApiExternalAgent) => Promise<void>;
  onRotateAgent: (agent: ApiExternalAgent) => Promise<void>;
  onEditProjects: (agent: ApiExternalAgent) => void;
  onEditAvatar: (agent: ApiExternalAgent) => void;
  onRevokeAgent: (agent: ApiExternalAgent) => Promise<void>;
  onClearPendingAction: () => void;
}): ReactElement {
  return (
    <section>
      <SettingsSectionHeader
        title="External agents"
        description="An external agent connects to Suplex with its own credential. It can open only the projects that you select."
        actions={<NewButton onClick={onOpenNewAgent}>New external agent</NewButton>}
      />
      <SettingsDataTable
        label="External agents"
        columns={EXTERNAL_AGENT_AGENT_COLUMNS}
      >
        <SettingsTableGroup
          label="External agents"
          count={agents.length}
          columnCount={EXTERNAL_AGENT_AGENT_COLUMNS.length}
        >
          {agents.map((agent) => {
            const action = `externalAgent:revoke:${agent.id}`;
            return (
              <SettingsTableRow
                aria-label={`External agent ${agent.name}`}
                key={agent.id}
              >
                <SettingsTableCell>
                  <span className="flex items-center gap-3">
                    <EntityAvatar
                      kind="agent"
                      id={agent.id}
                      name={agent.name}
                      seed={agent.avatarSeed}
                    />
                    <span className="truncate font-medium">{agent.name}</span>
                  </span>
                </SettingsTableCell>
                <SettingsTableCell>
                  <span className="flex items-center gap-1.5 whitespace-nowrap text-muted-foreground">
                    <span
                      className={
                        agent.status === "paired"
                          ? "size-1.5 shrink-0 rounded-full bg-emerald-500"
                          : agent.status === "pending"
                            ? "size-1.5 shrink-0 rounded-full bg-amber-500"
                            : "size-1.5 shrink-0 rounded-full bg-muted-foreground"
                      }
                    />
                    <span>
                      {agent.status === "pending" && agent.pairingExpiresAt
                        ? `Pending until ${adminDate(agent.pairingExpiresAt)}`
                        : agent.status.charAt(0).toUpperCase() +
                          agent.status.slice(1)}
                    </span>
                  </span>
                </SettingsTableCell>
                <SettingsTableCell>
                  <span
                    className="truncate text-muted-foreground"
                    title={agent.projectIds
                      .map(
                        (id) =>
                          projects.find((project) => project.id === id)?.name ??
                          id,
                      )
                      .join(", ")}
                  >
                    {agent.projectIds.length === 0
                      ? "None"
                      : agent.projectIds
                          .map(
                            (id) =>
                              projects.find((project) => project.id === id)
                                ?.name ?? id,
                          )
                          .join(", ")}
                  </span>
                </SettingsTableCell>
                <SettingsTableCell className="truncate text-muted-foreground text-xs">
                  {agent.connectionKind === "oauth"
                    ? "OAuth"
                    : agent.credentialCreatedAt
                    ? adminDate(agent.credentialCreatedAt)
                    : "—"}
                </SettingsTableCell>
                <SettingsTableCell className="truncate text-muted-foreground text-xs">
                  {agent.lastUsedAt ? adminDate(agent.lastUsedAt) : "Never"}
                </SettingsTableCell>
                <SettingsTableCell className="p-0">
                  {agent.status !== "revoked" ? (
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
                        <Ellipsis className="size-4" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        {agent.status === "pending" ? (
                          <DropdownMenuItem
                            onClick={() => void onReissuePairing(agent)}
                          >
                            <Key className="mr-2 size-3.5" /> Reissue pairing
                            code
                          </DropdownMenuItem>
                        ) : agent.connectionKind === "credential" ? (
                          <DropdownMenuItem
                            onClick={() => void onRotateAgent(agent)}
                          >
                            <RotateCw className="mr-2 size-3.5" /> Rotate
                            credential
                          </DropdownMenuItem>
                        ) : null}
                        <DropdownMenuItem onClick={() => onEditProjects(agent)}>
                          <Pencil className="mr-2 size-3.5" /> Edit project
                          scope
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => onEditAvatar(agent)}>
                          <Pencil className="mr-2 size-3.5" /> Edit avatar
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => void onRevokeAgent(agent)}
                        >
                          <ShieldAlert className="mr-2 size-3.5" />{" "}
                          {pendingAction === action
                            ? "Confirm revoke"
                            : "Revoke agent"}
                        </DropdownMenuItem>
                        {pendingAction === action ? (
                          <DropdownMenuItem onClick={onClearPendingAction}>
                            Cancel
                          </DropdownMenuItem>
                        ) : null}
                      </DropdownMenuContent>
                    </DropdownMenu>
                  ) : null}
                </SettingsTableCell>
                <SettingsTableCell className="p-0" />
              </SettingsTableRow>
            );
          })}
        </SettingsTableGroup>
        {agents.length === 0 ? (
          <SettingsTableEmpty columnCount={EXTERNAL_AGENT_AGENT_COLUMNS.length}>
            No external agents configured.
          </SettingsTableEmpty>
        ) : null}
      </SettingsDataTable>
    </section>
  );
}
