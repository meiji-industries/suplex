import { Button } from "../../components/ui/button.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, matchesSearch, type SettingsTableColumn } from "../../components/app/settings-table.js";
import { adminDate } from "../../shell/view-shared.js";
import type { ApiCompany, ApiUser } from "../../lib/api.js";
import { withCompany } from "../../lib/api.js";
import { Ellipsis } from "lucide-react";
import { useState, type ReactElement } from "react";

const COMPANY_COLUMNS: SettingsTableColumn[] = [{ key: "name", label: "Name ↓", width: 220 }, { key: "issueCode", label: "Issue code", width: 120 }, { key: "status", label: "Status", width: 110 }, { key: "created", label: "Created", width: 170 }, { key: "menu", width: 28 }, { key: "end", width: 32 }];

export function CompaniesSection({ companies, users, pendingAction, onChangeMembership, onClearPendingAction }: { companies: ApiCompany[]; users: ApiUser[]; pendingAction: string; onChangeMembership: (companyId: string, userId: string, add: boolean) => void; onClearPendingAction: () => void }): ReactElement {
  const [search, setSearch] = useState("");
  const visible = companies.filter((company) => matchesSearch(search, company.name, company.issueCode, company.status));
  return (
<section>
            <SettingsToolbar searchLabel="Search companies" searchPlaceholder="Search companies" searchWidth="compact" searchValue={search} onSearchChange={setSearch} />
            <SettingsDataTable label="Companies" columns={COMPANY_COLUMNS} className="mt-5">
              <SettingsTableGroup columnCount={COMPANY_COLUMNS.length} count={visible.length} label="Companies">
                {visible.map((company) => (
                  <SettingsTableRow key={company.id} size="member">
                    <SettingsTableCell className="truncate font-medium">{company.name}</SettingsTableCell>
                    <SettingsTableCell className="truncate text-muted-foreground">{company.issueCode ?? "—"}</SettingsTableCell>
                    <SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={company.status === "active" ? "size-1.5 rounded-full bg-emerald-500" : company.status === "paused" ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-muted-foreground"} />{company.status}</span></SettingsTableCell>
                    <SettingsTableCell className="truncate text-muted-foreground">{adminDate(company.createdAt)}</SettingsTableCell>
                    <SettingsTableCell className="p-0"><DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${company.name} actions`} title={`${company.name} actions`} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => window.location.assign(withCompany(`/companies/${encodeURIComponent(company.id)}/settings`, company.id))}>Settings</DropdownMenuItem>{users.filter((candidate) => candidate.role === "member" && candidate.status === "active").map((candidate) => { const assigned = candidate.companyIds.includes(company.id); const action = `membership:${company.id}:${candidate.id}`; return <DropdownMenuItem key={candidate.id} onClick={() => void onChangeMembership(company.id, candidate.id, !assigned)}>{pendingAction === action ? `Confirm remove ${candidate.displayName}` : `${assigned ? "Remove" : "Add"} ${candidate.displayName}`}</DropdownMenuItem>; })}{pendingAction.startsWith(`membership:${company.id}:`) ? <DropdownMenuItem onClick={() => onClearPendingAction()}>Cancel membership change</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu></SettingsTableCell>
                    <SettingsTableCell className="p-0" />
                  </SettingsTableRow>
                ))}
              </SettingsTableGroup>
              {companies.length === 0 ? <SettingsTableEmpty columnCount={COMPANY_COLUMNS.length}>No companies configured.</SettingsTableEmpty> : visible.length === 0 ? <SettingsTableEmpty columnCount={COMPANY_COLUMNS.length}>No companies match the search.</SettingsTableEmpty> : null}
            </SettingsDataTable>
          </section>
  );
}
