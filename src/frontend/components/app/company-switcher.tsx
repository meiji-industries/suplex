import { Check, ChevronDown, CircleAlert, Plus, RefreshCw, Settings2, Shield, UserRound, X } from "lucide-react";
import { useState, type FormEvent, type ReactElement } from "react";

import { Button } from "../ui/button.js";
import { Dialog } from "../ui/dialog.js";
import { Menu } from "../ui/menu.js";
import { Input } from "../ui/input.js";
import { companyInitials, withCompany } from "../../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";

function ForgeMark(): ReactElement {
  return <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background">F</span>;
}

function StatusBadge({ status }: { status: "active" | "paused" | "archived" }): ReactElement | null {
  if (status === "active") return null;
  return <span className="ml-auto text-[10px] text-muted-foreground">{status[0]!.toUpperCase() + status.slice(1)}</span>;
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
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/20" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 w-[min(92vw,360px)] -translate-x-1/2 -translate-y-1/2 border border-border bg-background p-4 shadow-lg outline-none">
          <div className="mb-3 flex items-center justify-between"><Dialog.Title className="text-[13px] font-semibold">Create company</Dialog.Title><Dialog.Close render={<Button variant="ghost" size="icon" aria-label="Close"><X className="size-3.5" /></Button>} /></div>
          <form onSubmit={(event) => void submit(event)}>
            <label className="mb-1 block text-[11px] text-muted-foreground" htmlFor="create-company-name">Company name</label>
            <Input id="create-company-name" autoFocus className="w-full" value={name} onChange={(event) => setName(event.target.value)} />
            {error ? <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p> : null}
            <div className="mt-4 flex justify-end gap-2"><Dialog.Close render={<Button type="button" variant="ghost" size="sm">Cancel</Button>} /><Button type="submit" size="sm" disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create"}</Button></div>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
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
      <Menu.Root>
        <Menu.Trigger aria-label="Switch company" title="Switch company" className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-sidebar-accent focus-visible:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring/50">
          {currentCompany ? <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-muted text-[10px] font-semibold text-muted-foreground">{companyInitials(currentCompany.name)}</span> : <ForgeMark />}
          <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner sideOffset={4} align="start" className="z-50 outline-none">
            <Menu.Popup className="w-64 overflow-hidden rounded-md border border-border bg-background p-1 text-xs shadow-lg outline-none">
              <Menu.Group>
                <Menu.GroupLabel className="px-2 py-1.5 text-[11px] font-medium text-muted-foreground">Switch company</Menu.GroupLabel>
                <Menu.Viewport className="max-h-72 overflow-y-auto">
                  {companies.length ? companies.map((company, index) => <span className="block" key={company.id}>{company.status === "archived" && companies[index - 1]?.status !== "archived" ? <span className="block border-t border-border px-2 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">Archived</span> : null}<Menu.Item className="flex min-h-8 cursor-default items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-muted" onClick={() => context.selectCompany(company.id)}>
                    <span className="flex size-5 shrink-0 items-center justify-center rounded-[5px] bg-muted text-[10px] font-semibold text-muted-foreground">{companyInitials(company.name)}</span>
                    <span className="min-w-0 flex-1 truncate">{company.name}</span>
                    <StatusBadge status={company.status} />
                    {company.id === currentCompany?.id ? <Check className="ml-1 size-3.5 shrink-0 text-primary" /> : null}
                  </Menu.Item></span>) : <div className="px-2 py-2 text-[11px] text-muted-foreground">{user?.role === "admin" ? "No companies yet" : "No company access"}</div>}
                </Menu.Viewport>
              </Menu.Group>
              <Menu.Separator className="my-1 h-px bg-border" />
              {error ? <div className="flex items-center gap-2 px-2 py-2 text-[11px] text-rose-700"><CircleAlert className="size-3.5 shrink-0" />Unable to load companies</div> : null}
              {error ? <Menu.Item className="flex min-h-8 items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-muted" onClick={() => void context.reloadCompanies()}><RefreshCw className="size-3.5 text-muted-foreground" />Retry</Menu.Item> : null}
              {user?.role === "admin" ? <Menu.Item className="flex min-h-8 items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-muted" onClick={() => setCreateOpen(true)}><Plus className="size-3.5 text-muted-foreground" />Create company…</Menu.Item> : null}
              {user?.role === "admin" && currentCompany ? <Menu.LinkItem href={withCompany(`/companies/${encodeURIComponent(currentCompany.id)}/settings`, currentCompany.id)} className="flex min-h-8 items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-muted"><Settings2 className="size-3.5 text-muted-foreground" />Company settings</Menu.LinkItem> : null}
              {user?.role === "admin" ? <Menu.LinkItem href={withCompany("/admin", currentCompany?.id)} className="flex min-h-8 items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-muted"><Shield className="size-3.5 text-muted-foreground" />Administration</Menu.LinkItem> : null}
              <Menu.Separator className="my-1 h-px bg-border" />
              <Menu.Item className="flex min-h-8 items-center gap-2 rounded px-2 py-1.5 outline-none data-[highlighted]:bg-muted" onClick={() => void signOut()}><UserRound className="size-3.5 text-muted-foreground" />Sign out</Menu.Item>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
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
