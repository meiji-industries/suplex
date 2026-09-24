import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, SettingsToolbarAction, matchesSearch, type SettingsTableColumn } from "../../components/app/settings-table.js";
import type { ApiUser } from "../../lib/api.js";
import type { ApiCredential } from "../../shell/view-shared.js";
import { Ellipsis } from "lucide-react";
import { useState, type ReactElement } from "react";

const USER_COLUMNS: SettingsTableColumn[] = [
  { key: "name", label: "Name ↓", width: 177 },
  { key: "username", label: "Username", width: 118 },
  { key: "role", label: "Role", width: 140 },
  { key: "companies", label: "Companies", width: 82 },
  { key: "passkeys", label: "Passkeys", width: 82 },
  { key: "status", label: "Status", width: 82 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const USER_GROUPS: Array<{ label: string; status: ApiUser["status"] }> = [
  { label: "Active", status: "active" },
  { label: "Pending", status: "pending" },
  { label: "Revoked", status: "revoked" },
];

function downloadUsersCsv(users: ApiUser[]): void {
  const cell = (value: string): string => `"${value.replaceAll('"', '""')}"`;
  const rows = [["Name", "Username", "Role", "Status"], ...users.map((user) => [user.displayName, user.username, user.role, user.status])];
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([rows.map((row) => row.map(cell).join(",")).join("\n")], { type: "text/csv" }));
  link.download = "suplex-users.csv";
  link.click();
  URL.revokeObjectURL(link.href);
}

export function UsersSection({ users, credentials, pendingAction, onRevokeUser, onClearPendingAction }: { users: ApiUser[]; credentials: ApiCredential[]; pendingAction: string; onRevokeUser: (user: ApiUser) => void; onClearPendingAction: () => void }): ReactElement {
  const [search, setSearch] = useState("");
  const visible = users.filter((candidate) => matchesSearch(search, candidate.displayName, candidate.username));
  return (
    <section>
      <SettingsToolbar searchLabel="Search users" searchPlaceholder="Search by name or username" searchValue={search} onSearchChange={setSearch} actions={<SettingsToolbarAction onClick={() => downloadUsersCsv(users)}>Export CSV</SettingsToolbarAction>} />
      <SettingsDataTable label="Users" columns={USER_COLUMNS} className="mt-5">
        {USER_GROUPS.map((group) => {
          const groupUsers = visible.filter((candidate) => candidate.status === group.status);
          if (groupUsers.length === 0) return null;
          return <SettingsTableGroup columnCount={USER_COLUMNS.length} count={groupUsers.length} key={group.status} label={group.label}>{groupUsers.map((candidate) => { const action = `user:${candidate.id}`; const passkeyCount = credentials.filter((credential) => credential.userId === candidate.id && !credential.revokedAt).length; return <SettingsTableRow key={candidate.id} size="member"><SettingsTableCell><span className="flex min-w-0 items-center gap-2"><EntityAvatar kind="user" id={candidate.id} name={candidate.displayName} seed={candidate.avatarSeed} /><span className="truncate">{candidate.displayName}</span></span></SettingsTableCell><SettingsTableCell className="truncate text-muted-foreground">@{candidate.username}</SettingsTableCell><SettingsTableCell><span className="rounded bg-primary/10 px-1.5 py-0.5 text-xs text-primary">{candidate.role}</span></SettingsTableCell><SettingsTableCell className="text-muted-foreground">{candidate.companyIds.length}</SettingsTableCell><SettingsTableCell className="text-muted-foreground">{passkeyCount}</SettingsTableCell><SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={candidate.status === "active" ? "size-1.5 rounded-full bg-emerald-500" : candidate.status === "pending" ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-muted-foreground"} />{candidate.status}</span></SettingsTableCell><SettingsTableCell className="p-0">{candidate.role !== "admin" && candidate.status === "active" ? <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${candidate.displayName} actions`} title={`${candidate.displayName} actions`} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onClick={() => onRevokeUser(candidate)}>{pendingAction === action ? "Confirm revoke" : "Revoke user"}</DropdownMenuItem>{pendingAction === action ? <DropdownMenuItem onClick={onClearPendingAction}>Cancel</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu> : null}</SettingsTableCell><SettingsTableCell className="p-0" /></SettingsTableRow>; })}</SettingsTableGroup>;
        })}
        {users.length === 0 ? <SettingsTableEmpty columnCount={USER_COLUMNS.length}>No users configured.</SettingsTableEmpty> : visible.length === 0 ? <SettingsTableEmpty columnCount={USER_COLUMNS.length}>No users match the search.</SettingsTableEmpty> : null}
      </SettingsDataTable>
    </section>
  );
}
