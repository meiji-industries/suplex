import { CircleAlert, CircleGauge, CirclePlus, RefreshCw, Settings2 } from "lucide-react";
import { useState, type FormEvent, type ReactElement } from "react";

import { Button } from "../components/ui/button.js";
import { NewButton } from "../components/ui/new-button.js";
import { Alert, AlertDescription } from "../components/ui/alert.js";
import { Badge } from "../components/ui/badge.js";
import { DialogClose, DialogContent, DialogFooter, DialogHeader, Dialog as DialogRoot, DialogTitle } from "../components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../components/ui/dropdown-menu.js";
import { Field, FieldLabel } from "../components/ui/field.js";
import { Input } from "../components/ui/input.js";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from "../components/ui/sidebar.js";
import { withCompany } from "../lib/api.js";
import { navigate } from "./navigation-state.js";
import { activeCompanyStorageKey, useOptionalCompanyContext } from "./company-context.js";
import { EntityAvatar } from "../components/app/entity-avatar.js";

function SuplexMark(): ReactElement {
  return <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-foreground text-xs font-bold text-background">F</span>;
}

function StatusBadge({ status }: { status: "active" | "paused" | "archived" }): ReactElement | null {
  if (status === "active") return null;
  return <Badge variant="secondary" className="ml-auto text-xs">{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
}

const planLabels = { free: "Free", pro: "Pro", team: "Team" } as const;

function PlanBadge({ plan }: { plan: keyof typeof planLabels | null | undefined }): ReactElement | null {
  return plan ? <Badge variant="secondary">{planLabels[plan]}</Badge> : null;
}

function CreateCompanyDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }): ReactElement {
  const context = useOptionalCompanyContext();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  if (!context) return <></>;
  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await context.createCompany(name);
      onOpenChange(false);
      navigate(withCompany(`/companies/${encodeURIComponent(created.id)}/settings`, created.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to add company");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,360px)]" showCloseButton>
          <DialogHeader><DialogTitle>New company</DialogTitle></DialogHeader>
          <form className="grid gap-3" onSubmit={(event) => void submit(event)}>
            <Field>
              <FieldLabel htmlFor="create-company-name">Company name</FieldLabel>
              <Input id="create-company-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            {error ? <Alert variant="destructive" className="mt-2"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><NewButton type="submit" disabled={busy || !name.trim()}>{busy ? "Creating…" : "New company"}</NewButton></DialogFooter>
          </form>
      </DialogContent>
    </DialogRoot>
  );
}

export function CompanySwitcher(): ReactElement {
  const context = useOptionalCompanyContext();
  const [createOpen, setCreateOpen] = useState(false);
  if (!context) return <div className="flex h-8 items-center gap-2 px-2"><SuplexMark /><span className="text-sm font-semibold tracking-[-0.02em]">Suplex</span></div>;
  const { currentCompany, companies, loading, error, user } = context;
  const label = loading ? "Loading companies" : currentCompany?.name ?? "No company";
  return (
    <>
      <SidebarMenu><SidebarMenuItem><DropdownMenu>
        <DropdownMenuTrigger aria-label="Switch company" title="Switch company" render={<SidebarMenuButton className="data-[slot=sidebar-menu-button]:p-1.5! h-14" />}>
          {currentCompany ? <EntityAvatar kind="company" id={currentCompany.id} name={currentCompany.name} seed={currentCompany.name} size="sm" /> : <CircleGauge className="size-5!" />}
          <span className="min-w-0 flex-1 truncate text-sm font-semibold">{label}</span>
          <PlanBadge plan={currentCompany?.plan} />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Switch company</DropdownMenuLabel>
                  {companies.length ? companies.map((company, index) => <span className="block" key={company.id}>{company.status === "archived" && companies[index - 1]?.status !== "archived" ? <div className="px-2 pb-1 pt-2 text-xs font-medium text-muted-foreground">Archived</div> : null}<DropdownMenuItem onClick={() => {
                    window.localStorage.setItem(activeCompanyStorageKey, company.id);
                    navigate(withCompany("/", company.id));
                  }}>
                    <EntityAvatar kind="company" id={company.id} name={company.name} seed={company.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{company.name}</span>
                    <PlanBadge plan={company.plan} />
                    <StatusBadge status={company.status} />
                  </DropdownMenuItem></span>) : <div className="px-2 py-2 text-xs text-muted-foreground">{user?.role === "admin" ? "No companies yet" : "No company access"}</div>}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {error ? <div className="flex items-center gap-2 px-2 py-2 text-xs text-destructive"><CircleAlert className="size-3.5 shrink-0" />Unable to load companies</div> : null}
              {error ? <DropdownMenuItem aria-label="Refresh" title="Refresh" onClick={() => void context.reloadCompanies()}><RefreshCw aria-hidden="true" className="size-3.5 text-muted-foreground" /></DropdownMenuItem> : null}
              {user?.role === "admin" ? <DropdownMenuItem onClick={() => setCreateOpen(true)}><CirclePlus className="size-3.5 text-muted-foreground" />New company…</DropdownMenuItem> : null}
              {user?.role === "admin" && currentCompany ? <DropdownMenuItem render={<a href={withCompany(`/companies/${encodeURIComponent(currentCompany.id)}/settings`, currentCompany.id)} />}><Settings2 className="size-3.5 text-muted-foreground" />Company settings</DropdownMenuItem> : null}
        </DropdownMenuContent>
      </DropdownMenu></SidebarMenuItem></SidebarMenu>
      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
