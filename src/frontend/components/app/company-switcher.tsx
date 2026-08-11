import { Check, ChevronDown, CircleAlert, Plus, RefreshCw, Settings2, Shield, UserRound } from "lucide-react";
import { useState, type FormEvent, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Badge } from "../ui/badge.js";
import { DialogClose, DialogContent, DialogFooter, DialogHeader, Dialog as DialogRoot, DialogTitle } from "../ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "../ui/dropdown-menu.js";
import { Field, FieldLabel } from "../ui/field.js";
import { Input } from "../ui/input.js";
import { companyInitials, withCompany } from "../../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";

function ForgeMark(): ReactElement {
  return <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background">F</span>;
}

function StatusBadge({ status }: { status: "active" | "paused" | "archived" }): ReactElement | null {
  if (status === "active") return null;
  return <Badge variant="secondary" className="ml-auto text-[10px]">{status[0]!.toUpperCase() + status.slice(1)}</Badge>;
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
      window.location.assign(withCompany(`/companies/${encodeURIComponent(created.id)}/settings`, created.id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to create company");
    } finally {
      setBusy(false);
    }
  };
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(92vw,360px)]" showCloseButton>
          <DialogHeader><DialogTitle>Create company</DialogTitle></DialogHeader>
          <form onSubmit={(event) => void submit(event)}>
            <Field>
              <FieldLabel htmlFor="create-company-name">Company name</FieldLabel>
              <Input id="create-company-name" autoFocus value={name} onChange={(event) => setName(event.target.value)} />
            </Field>
            {error ? <Alert variant="destructive" className="mt-2"><AlertDescription>{error}</AlertDescription></Alert> : null}
            <DialogFooter><DialogClose render={<Button type="button" variant="ghost" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</Button></DialogFooter>
          </form>
      </DialogContent>
    </DialogRoot>
  );
}

export function CompanySwitcher(): ReactElement {
  const context = useOptionalCompanyContext();
  const [createOpen, setCreateOpen] = useState(false);
  if (!context) return <div className="flex h-8 items-center gap-2 px-2"><ForgeMark /><span className="text-[13px] font-semibold tracking-[-0.02em]">Forge</span></div>;
  const { currentCompany, companies, loading, error, user } = context;
  const label = loading ? "Loading companies" : currentCompany?.name ?? "No company";
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger aria-label="Switch company" title="Switch company" className="w-full" render={<Button variant="ghost" className="w-full justify-start px-2" />}>
          {currentCompany ? <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-muted text-[10px] font-semibold text-muted-foreground">{companyInitials(currentCompany.name)}</span> : <ForgeMark />}
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-64" align="start">
              <DropdownMenuGroup>
                <DropdownMenuLabel>Switch company</DropdownMenuLabel>
                  {companies.length ? companies.map((company, index) => <span className="block" key={company.id}>{company.status === "archived" && companies[index - 1]?.status !== "archived" ? <div className="px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">Archived</div> : null}<DropdownMenuItem onClick={() => context.selectCompany(company.id)}>
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-muted text-[10px] font-semibold text-muted-foreground">{companyInitials(company.name)}</span>
                    <span className="min-w-0 flex-1 truncate">{company.name}</span>
                    <StatusBadge status={company.status} />
                    {company.id === currentCompany?.id ? <Check className="ml-1 size-3.5 shrink-0 text-primary" /> : null}
                  </DropdownMenuItem></span>) : <div className="px-2 py-2 text-[11px] text-muted-foreground">{user?.role === "admin" ? "No companies yet" : "No company access"}</div>}
              </DropdownMenuGroup>
              <DropdownMenuSeparator />
              {error ? <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-rose-700"><CircleAlert className="size-3.5 shrink-0" />Unable to load companies</div> : null}
              {error ? <DropdownMenuItem onClick={() => void context.reloadCompanies()}><RefreshCw className="size-3.5 text-muted-foreground" />Retry</DropdownMenuItem> : null}
              {user?.role === "admin" ? <DropdownMenuItem onClick={() => setCreateOpen(true)}><Plus className="size-3.5 text-muted-foreground" />Create company…</DropdownMenuItem> : null}
              {user?.role === "admin" && currentCompany ? <DropdownMenuItem render={<a href={withCompany(`/companies/${encodeURIComponent(currentCompany.id)}/settings`, currentCompany.id)} />}><Settings2 className="size-3.5 text-muted-foreground" />Company settings</DropdownMenuItem> : null}
              {user?.role === "admin" ? <DropdownMenuItem render={<a href={withCompany("/admin", currentCompany?.id)} />}><Shield className="size-3.5 text-muted-foreground" />Administration</DropdownMenuItem> : null}
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void signOut()}><UserRound className="size-3.5 text-muted-foreground" />Sign out</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <CreateCompanyDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}

async function signOut(): Promise<void> {
  try { await fetch("/api/auth/sign-out", { method: "POST" }); } finally {
    window.localStorage.removeItem("forge.activeCompanyId");
    window.location.assign("/auth");
  }
}
