import { Collapsible } from "./components/ui/collapsible.js";
import { Button } from "./components/ui/button.js";
import { Input } from "./components/ui/input.js";
import { AppSidebar, MobileNavigation } from "./components/app/navigation.js";
import { ApplicationFrame } from "./components/app/application-frame.js";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import type { HealthCheck, HealthSnapshot } from "../health.js";
import { isOwnedHealthCheck } from "../health-contract.js";
import {
  Activity,
  ChevronRight,
  CircleHelp,
  Clock3,
  Database,
  GitBranch,
  HardDrive,
  RefreshCw,
  Terminal,
  Workflow,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

import "./styles.css";

const icons: Record<string, LucideIcon> = {
  temporal: Workflow,
  database: Database,
  "artifact-root": HardDrive,
  worker: Activity,
  "codex-auth": Terminal,
  "gh-auth": GitBranch,
};

function relativeTime(timestamp: string): string {
  const elapsed = Math.max(0, Date.now() - Date.parse(timestamp));
  if (elapsed < 10_000) return "just now";
  if (elapsed < 60_000) return `${Math.floor(elapsed / 1_000)}s ago`;
  return `${Math.floor(elapsed / 60_000)}m ago`;
}

async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(init?.headers ?? {}) } });
  const text = await response.text();
  const body = (text ? JSON.parse(text) : {}) as T & { error?: string };
  if (!response.ok) {
    throw new Error(body.error ?? "Request failed");
  }
  return body;
}

type ApiUser = { id: string; displayName: string; username: string; role: "admin" | "member"; status: string; companyIds: string[] };
type ApiCompany = { id: string; name: string; createdAt: string };

function AuthView(): ReactElement {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [required, setRequired] = useState(false);
  const [token, setToken] = useState(params.get("invite") ?? "");
  const mode = params.get("mode") ?? "";
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void readJson<{ required: boolean; authenticated: boolean }>("/api/auth/status").then((status) => {
      if (status.authenticated) window.location.assign("/health");
      setRequired(status.required);
    }).catch(() => setError("Unable to read sign-in state"));
  }, []);

  const enroll = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const registrationKind = mode === "recovery" ? "recovery" : required ? "bootstrap" : "invitation";
      const options = await readJson<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(`/api/auth/${registrationKind}/options`, { method: "POST", body: JSON.stringify({ token }) });
      const response = await startRegistration({ optionsJSON: options.options });
      await readJson(`/api/auth/${registrationKind}/verify`, { method: "POST", body: JSON.stringify({ token, challengeId: options.challengeId, response }) });
      window.location.assign("/health");
    } catch {
      setError("Passkey enrollment failed");
    } finally { setBusy(false); }
  };

  const signIn = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const options = await readJson<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/auth/options", { method: "POST", body: "{}" });
      const response = await startAuthentication({ optionsJSON: options.options });
      await readJson("/api/auth/verify", { method: "POST", body: JSON.stringify({ challengeId: options.challengeId, response }) });
      window.location.assign("/health");
    } catch {
      setError("Passkey sign-in failed");
    } finally { setBusy(false); }
  };

  const enrollment = required || token.length > 0;
  return (
    <ApplicationFrame title={enrollment ? "Enroll passkey" : "Sign in"}>
      <div className="mx-auto max-w-md px-4 py-4 sm:px-8">
        <div className="border border-border bg-card p-4">
          <div className="mb-5 flex items-center justify-between"><span className="text-[13px] font-semibold">{enrollment ? "Passkey enrollment" : "Passkey sign-in"}</span><span className="text-xs text-muted-foreground">No password</span></div>
          {enrollment ? <><label className="mb-1 block text-xs text-muted-foreground" htmlFor="invitation">Invitation token</label><Input id="invitation" className="mb-3 w-full" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /><Button className="w-full" onClick={() => void enroll()} disabled={busy || token.length < 16}>{busy ? "Waiting for passkey…" : "Enroll passkey"}</Button></> : <Button className="w-full" onClick={() => void signIn()} disabled={busy}>{busy ? "Waiting for passkey…" : "Sign in with passkey"}</Button>}
          {error ? <p role="alert" className="mt-3 text-xs text-rose-700">{error}</p> : null}
        </div>
      </div>
    </ApplicationFrame>
  );
}

function AdminView(): ReactElement {
  const [user, setUser] = useState<ApiUser>();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [companies, setCompanies] = useState<ApiCompany[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [companyName, setCompanyName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    try {
      const me = await readJson<{ user: ApiUser }>("/api/auth/me");
      setUser(me.user);
      const [userList, companyList] = await Promise.all([readJson<{ users: ApiUser[] }>("/api/admin/users"), readJson<{ companies: ApiCompany[] }>("/api/companies")]);
      setUsers(userList.users); setCompanies(companyList.companies);
    } catch (reason) {
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else setError("Unable to load administration");
    }
  }, []);
  useEffect(() => { void reload(); }, [reload]);

  const invite = async (): Promise<void> => {
    try { const result = await readJson<{ token: string }>("/api/admin/invitations", { method: "POST", body: JSON.stringify({ displayName: displayName || "Forge user" }) }); setInviteToken(result.token); setDisplayName(""); await reload(); } catch { setError("Unable to invite user"); }
  };
  const createCompany = async (): Promise<void> => {
    try { await readJson("/api/admin/companies", { method: "POST", body: JSON.stringify({ name: companyName }) }); setCompanyName(""); await reload(); } catch { setError("Unable to create company"); }
  };
  const changeMembership = async (companyId: string, targetUserId: string, add: boolean): Promise<void> => {
    try {
      const init: RequestInit = { method: add ? "POST" : "DELETE" };
      if (add) init.body = JSON.stringify({ userId: targetUserId });
      await readJson(add ? `/api/admin/companies/${companyId}/members` : `/api/admin/companies/${companyId}/members/${targetUserId}`, init);
      await reload();
    } catch { setError("Unable to change membership"); }
  };
  const signOut = async (): Promise<void> => { await readJson("/api/auth/sign-out", { method: "POST", body: "{}" }); window.location.assign("/auth"); };

  return (
    <ApplicationFrame title="Administration">
      <div className="divide-y divide-border/70">
        <section className="flex flex-wrap items-center justify-between gap-3 border-b border-border/70 px-3 py-3 sm:px-4"><span className="text-xs text-muted-foreground">{user?.displayName ?? ""} · {user?.role ?? ""}</span><Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button></section>
        <section className="grid gap-px border-b border-border/70 bg-border sm:grid-cols-2">
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Users</span><span className="text-[11px] text-muted-foreground">{users.length}</span></div><div className="mb-3 flex gap-2"><Input className="h-7 flex-1" placeholder="Display name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /><Button size="sm" onClick={() => void invite()}>Invite</Button></div>{inviteToken ? <code className="block break-all border border-border bg-muted/30 p-2 text-[11px]">{inviteToken}</code> : null}<div className="mt-3 divide-y divide-border/70 border-y border-border/70">{users.map((candidate) => <div className="flex min-h-8 items-center justify-between gap-2 text-xs" key={candidate.id}><span className="truncate">{candidate.displayName} <span className="text-muted-foreground">{candidate.status}</span></span>{candidate.role !== "admin" && candidate.status === "active" ? <Button variant="ghost" size="sm" onClick={() => void readJson(`/api/admin/users/${candidate.id}/revoke`, { method: "POST", body: "{}" }).then(() => reload()).catch(() => setError("Unable to revoke user"))}>Revoke</Button> : null}</div>)}</div></div>
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Companies</span><span className="text-[11px] text-muted-foreground">{companies.length}</span></div><div className="mb-3 flex gap-2"><Input className="h-7 flex-1" placeholder="Company name" value={companyName} onChange={(event) => setCompanyName(event.target.value)} /><Button size="sm" onClick={() => void createCompany()}>Create</Button></div><div className="divide-y divide-border/70 border-y border-border/70">{companies.map((company) => <div className="py-2 text-xs" key={company.id}><div className="mb-2 flex items-center justify-between"><span>{company.name}</span><span className="text-muted-foreground">{company.id.slice(0, 8)}</span></div><div className="flex flex-wrap gap-1.5">{users.filter((candidate) => candidate.role === "member" && candidate.status === "active").map((candidate) => { const assigned = candidate.companyIds.includes(company.id); return <Button key={candidate.id} variant={assigned ? "secondary" : "outline"} size="sm" onClick={() => void changeMembership(company.id, candidate.id, !assigned)}>{assigned ? "− " : "+ "}{candidate.displayName}</Button>; })}</div></div>)}</div></div>
        </section>
        {error ? <p role="alert" className="px-4 py-3 text-xs text-rose-700">{error}</p> : null}
      </div>
    </ApplicationFrame>
  );
}

function StatusIndicator({ status }: { status: HealthCheck["status"] }): ReactElement {
  const healthy = status === "healthy";
  return (
    <span className={healthy ? "flex items-center gap-1.5 text-xs text-emerald-700" : "flex items-center gap-1.5 text-xs text-rose-700"}>
      <span className={healthy ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-rose-500"} />
      {healthy ? "Healthy" : "Unhealthy"}
    </span>
  );
}

function HealthRow({ check }: { check: HealthCheck }): ReactElement {
  const Icon = icons[check.id] ?? CircleHelp;
  return (
    <Collapsible.Root data-slot="health-row" data-status={check.status} className="group border-b border-border/70 last:border-b-0">
      <Collapsible.Trigger className="flex min-h-9 w-full items-center gap-2.5 px-3 text-left outline-none transition-colors hover:bg-muted/50 focus-visible:bg-muted/70 focus-visible:ring-1 focus-visible:ring-ring/50 sm:px-4">
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="min-w-0 truncate text-[13px] font-medium text-foreground">{check.label}</span>
        <span className="hidden min-w-0 flex-1 truncate pl-2 text-xs text-muted-foreground sm:block">{check.summary}</span>
        <StatusIndicator status={check.status} />
        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-data-[panel-open]:rotate-90" />
      </Collapsible.Trigger>
      <Collapsible.Panel className="border-t border-border/70 bg-muted/20 px-9 py-2.5 sm:px-11">
        {Object.keys(check.details).length > 0 ? (
          <dl className="grid gap-1.5 text-xs sm:grid-cols-[max-content_1fr] sm:gap-x-5">
            {Object.entries(check.details).map(([key, value]) => (
              <div className="contents" key={key}>
                <dt className="text-muted-foreground">{key}</dt>
                <dd className="truncate text-foreground/80">{String(value)}</dd>
              </div>
            ))}
          </dl>
        ) : (
          <span className="text-xs text-muted-foreground">No additional details reported.</span>
        )}
      </Collapsible.Panel>
    </Collapsible.Root>
  );
}

function Dashboard({ initialSnapshot }: { initialSnapshot: HealthSnapshot }): ReactElement {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const response = await fetch("/api/health", { headers: { Accept: "application/json" } });
      if (!response.ok) throw new Error("Health request failed");
      setSnapshot(await response.json() as HealthSnapshot);
    } catch {
      // Keep the last truthful snapshot visible when a refresh is interrupted.
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const ownedChecks = useMemo(() => snapshot.checks.filter((check) => isOwnedHealthCheck(check.id)), [snapshot.checks]);
  const providerChecks = useMemo(() => snapshot.checks.filter((check) => !isOwnedHealthCheck(check.id)), [snapshot.checks]);
  const healthyCount = snapshot.checks.filter((check) => check.status === "healthy").length;
  const failingCount = snapshot.checks.length - healthyCount;

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="flex min-h-screen">
        <AppSidebar />

        <main className="min-w-0 flex-1">
          <header className="flex h-10 items-center justify-between border-b border-border/70 px-3 sm:px-4">
            <div className="flex min-w-0 items-center gap-2">
              <span className="lg:hidden"><MobileNavigation /></span>
              <span className="flex size-5 items-center justify-center rounded-[5px] bg-foreground text-[10px] font-bold text-background lg:hidden">F</span>
              <h1 className="truncate text-[13px] font-semibold">Host health</h1>
              <span className="text-border">/</span>
              <span className={snapshot.ready ? "flex items-center gap-1.5 text-xs text-emerald-700" : "flex items-center gap-1.5 text-xs text-amber-700"}>
                <span className={snapshot.ready ? "size-1.5 rounded-full bg-emerald-500" : "size-1.5 rounded-full bg-amber-500"} />
                {snapshot.ready ? "Ready" : "Needs attention"}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <a className="max-w-[34vw] truncate text-[11px] text-muted-foreground hover:text-foreground sm:max-w-64 sm:text-xs" href={snapshot.reachableAddress}>{snapshot.reachableAddress.replace(/^https?:\/\//, "")}</a>
              <span className="hidden text-xs text-muted-foreground md:inline">{relativeTime(snapshot.generatedAt)}</span>
              <Button aria-label="Refresh health" title="Refresh health" variant="ghost" size="icon" onClick={() => void refresh()} disabled={refreshing}><RefreshCw className={refreshing ? "size-3.5 animate-spin" : "size-3.5"} /></Button>
            </div>
          </header>

          <div className="flex h-9 items-center justify-between border-b border-border/70 bg-muted/20 px-3 sm:px-4">
            <div className="flex h-full items-center gap-4 text-xs">
              <span className="flex h-full items-center border-b-2 border-primary font-medium text-foreground">Health</span>
              <span className="text-muted-foreground">{snapshot.checks.length} checks</span>
              <span className="text-emerald-700">{healthyCount} healthy</span>
              <span className={failingCount > 0 ? "text-rose-700" : "text-muted-foreground"}>{failingCount} issues</span>
            </div>
            <span className="hidden items-center gap-1.5 text-[11px] text-muted-foreground sm:flex"><Clock3 className="size-3" />Updated {relativeTime(snapshot.generatedAt)}</span>
          </div>

          <div>
            <section aria-labelledby="owned-services">
              <div className="flex h-8 items-center justify-between border-b border-border/70 px-3 sm:px-4">
                <h2 id="owned-services" className="text-[11px] font-semibold text-muted-foreground">Owned services</h2>
                <span className="text-[11px] text-muted-foreground">{ownedChecks.length}</span>
              </div>
              <div>{ownedChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
            <section aria-labelledby="provider-access" className="mt-5">
              <div className="flex h-8 items-center justify-between border-y border-border/70 px-3 sm:px-4">
                <h2 id="provider-access" className="text-[11px] font-semibold text-muted-foreground">Provider access</h2>
                <span className="text-[11px] text-muted-foreground">{providerChecks.length}</span>
              </div>
              <div>{providerChecks.map((check) => <HealthRow check={check} key={check.id} />)}</div>
            </section>
          </div>

        </main>
      </div>
    </div>
  );
}

const view = window.__FORGE_VIEW__;
createRoot(document.getElementById("forge-app")!).render(view === "auth" ? <AuthView /> : view === "admin" ? <AdminView /> : <Dashboard initialSnapshot={window.__FORGE_HEALTH__} />);
