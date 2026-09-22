import { useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity, ArrowLeft, ArrowRight, Bot, Building2, Check, CheckCircle2, ChevronRight, ChevronsUpDown,
  CircleAlert, CircleDashed, ClipboardList, Copy, Cpu, Database, ExternalLink, FileText,
  FolderGit2, GitBranch, HardDrive, Info, KeyRound, LayoutGrid, ListFilter,
  ListTodo, LockKeyhole, Mail, Monitor, Moon, Network, PanelLeft, Plus, RefreshCw,
  Server, Settings, ShieldCheck, Smartphone, Sun, Terminal, UserRound,
  Users, Wifi, XCircle, Package, type LucideIcon,
} from "lucide-react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "../../../src/frontend/components/ui/accordion.js";
import { Alert, AlertDescription, AlertTitle } from "../../../src/frontend/components/ui/alert.js";
import { Avatar, AvatarFallback } from "../../../src/frontend/components/ui/avatar.js";
import { Badge } from "../../../src/frontend/components/ui/badge.js";
import { Button } from "../../../src/frontend/components/ui/button.js";
import { Input } from "../../../src/frontend/components/ui/input.js";
import { Separator } from "../../../src/frontend/components/ui/separator.js";
import { Spinner } from "../../../src/frontend/components/ui/spinner.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../src/frontend/components/ui/tabs.js";
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../../../src/frontend/components/ui/timeline.js";
import "./mockup.css";

type CheckState = "healthy" | "unhealthy" | "warning";
type SampleCheck = {
  id: string;
  label: string;
  purpose: string;
  summary: string;
  status: CheckState;
  icon: LucideIcon;
  group: "Suplex services" | "Host tools" | "Provider access";
  details: Record<string, string | number | boolean>;
  command?: string;
};
type SetupStep = "auth" | "install" | "start" | "ready";
type Preset = "blocked" | "checking" | "ready";
const sampleHost = "suplex.tail1234.ts.net";
const sampleUser = "adam";
const setupHref = "02-setup.html";
const healthHref = "04-host-health.html";
const tasksHref = "03-in-app-banner.html";
const query = new URLSearchParams(location.search);

function setupChecks(step: SetupStep): SampleCheck[] {
  return [
    { id: "git", label: "Git", purpose: "Save code changes", summary: "Git is ready to manage your code.", status: "healthy", icon: GitBranch, group: "Host tools", details: { version: "2.47.1", command: "git" } },
    { id: "herdr-readiness", label: "Herdr", purpose: "Open the agent terminals", summary: step === "ready" ? "Herdr can open the agent terminals." : step === "start" ? "Suplex cannot reach Herdr. Start Herdr to open the agent terminals." : "Herdr is not installed.", status: step === "ready" ? "healthy" : "unhealthy", icon: LayoutGrid, group: "Host tools", details: step === "ready" ? { version: "0.9.0", server: "running" } : step === "start" ? { version: "0.9.0", server: "unreachable" } : { failure: "command-missing" }, ...(step === "ready" ? {} : { command: step === "start" ? "herdr" : "curl -fsSL https://herdr.dev/install.sh | sh" }) },
    { id: "provider:opencode", label: "OpenCode", purpose: "Run tasks with OpenCode", summary: step === "auth" ? "OpenCode is not signed in." : "OpenCode is signed in. Model access is not tested.", status: step === "auth" ? "unhealthy" : "healthy", icon: Terminal, group: "Provider access", details: { command: "opencode", state: step === "auth" ? "signed-out" : "signed-in", credentials: step === "auth" ? 0 : 1 }, ...(step === "auth" ? { command: "opencode auth login" } : {}) },
    { id: "provider:claude-code", label: "Claude Code", purpose: "Run tasks with Claude Code", summary: "Claude Code is signed in. Model access is not tested.", status: "healthy", icon: Bot, group: "Provider access", details: { command: "claude", state: "signed-in" } },
  ];
}

const optionalChecks: SampleCheck[] = [
  { id: "gh-auth", label: "GitHub CLI", purpose: "Publish pull requests", summary: "Sign in to GitHub before you publish a pull request.", status: "warning", icon: GitBranch, group: "Provider access", details: { command: "gh", authentication: "unavailable", failure: "unauthenticated" }, command: "gh auth login" },
  { id: "pnpm", label: "pnpm", purpose: "Update Suplex", summary: "pnpm is ready for Suplex updates.", status: "healthy", icon: Package, group: "Provider access", details: { version: "10.15.1" } },
];

const healthChecks: SampleCheck[] = [
  { id: "database", label: "SQLite database", purpose: "Store your tasks", summary: "Schema current · WAL enabled", status: "healthy", icon: Database, group: "Suplex services", details: { schemaState: "current", expectedMigrations: 41, appliedMigrations: 41, walMode: true } },
  { id: "artifact-root", label: "Artifact storage", purpose: "Store task files", summary: "412 GB free · Read and write access", status: "healthy", icon: HardDrive, group: "Suplex services", details: { writable: true, readable: true, freeBytes: 412_000_000_000 } },
  ...setupChecks("start"),
  ...optionalChecks,
  { id: "tailscale", label: "Tailscale", purpose: "Reach this host", summary: "Connected through Tailscale Serve", status: "healthy", icon: Network, group: "Provider access", details: { hostname: sampleHost, exposure: "serve" } },
  { id: "backup", label: "Backup verification", purpose: "Recover your data", summary: "Last backup verified 2 hours ago", status: "healthy", icon: ShieldCheck, group: "Provider access", details: { verifiedAt: "2026-09-07T07:10:00Z" } },
];

function StatusIcon({ status, icon: Icon }: { status: CheckState; icon?: LucideIcon }) {
  const Symbol = Icon ?? (status === "healthy" ? CheckCircle2 : status === "warning" ? CircleAlert : XCircle);
  return <span className="status-icon" data-status={status}><Symbol aria-hidden="true" /></span>;
}

function CheckBadge({ status }: { status: CheckState }) {
  return <Badge variant={status === "unhealthy" ? "destructive" : status === "warning" ? "outline" : "secondary"}>{status === "healthy" ? "Ready" : status === "warning" ? "Optional" : "Not ready"}</Badge>;
}

function Command({ command }: { command: string }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  async function copyCommand() {
    try {
      await navigator.clipboard.writeText(command);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  return <div className="command-block">
    <div className="command-context"><Terminal />Terminal on the Suplex host · {sampleUser}</div>
    <div className="command-line"><code>{command}</code><Button size="xs" variant="outline" onClick={() => void copyCommand()} aria-label="Copy the command">{copyState === "copied" ? <Check /> : <Copy />}{copyState === "copied" ? "Copied" : "Copy"}</Button></div>
    {copyState === "failed" && <div className="command-message" role="status">Suplex cannot copy the command. Select the command and copy it manually.</div>}
  </div>;
}

function TechnicalDetails({ check }: { check: SampleCheck }) {
  return <Accordion><AccordionItem value="technical"><AccordionTrigger>Technical details</AccordionTrigger><AccordionContent><dl className="technical-details">{Object.entries(check.details).map(([key, value]) => <div className="contents" key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl></AccordionContent></AccordionItem></Accordion>;
}

function HostStrip({ local = false }: { local?: boolean }) {
  return <div className="host-strip"><div className="host-symbol"><Server /></div><div><div className="host-address">{local ? "localhost:4111" : sampleHost}</div><div className="host-meta">Suplex host · macOS · User {sampleUser}</div></div><div className="host-status"><StatusIcon status="healthy" icon={local ? Monitor : LockKeyhole} /><span>{local ? "This computer" : "Tailscale · HTTPS"}</span></div></div>;
}

function Shell({ title, children, settings = false, sidebar = true, ready = false, actions }: { title: string; children: ReactNode; settings?: boolean; sidebar?: boolean; ready?: boolean; actions?: ReactNode }) {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [search, setSearch] = useState("");
  const groups = settings ? [
    { label: "Company", items: [{ label: "Profile", icon: UserRound }, { label: "Templates", icon: FileText }, { label: "Workspace", icon: Building2 }] },
    { label: "Administration", items: [{ label: "Users", icon: Users }, { label: "Invitations", icon: Mail }, { label: "Passkeys", icon: KeyRound }, { label: "Providers", icon: Cpu }, { label: "Agents", icon: Users }, { label: "Environment", icon: HardDrive }] },
    { label: "System", items: [{ label: "Host health", icon: ShieldCheck, href: healthHref }] },
  ] : [
    { label: "Workspace", items: [{ label: "Tasks", icon: ClipboardList, href: tasksHref }, { label: "Board", icon: LayoutGrid }, { label: "Projects", icon: FolderGit2 }] },
    { label: "Recent tasks", items: [{ label: "Dependency checks", icon: CircleDashed }, { label: "Passkey invitations", icon: KeyRound }, { label: "Worker context", icon: CheckCircle2 }] },
  ];
  return <div className={`app-shell${sidebar ? "" : " no-sidebar"}`}>
    {sidebar && <aside className="app-sidebar" data-open={navigationOpen} aria-label={settings ? "Settings navigation" : "Main navigation"}>
      <div className="workspace-name"><Avatar shape="square" size="sm"><AvatarFallback>M</AvatarFallback></Avatar><span>Meiji Industries</span><ChevronsUpDown size={13} /></div>
      {settings ? <><a className="nav-item" href={tasksHref}><ArrowLeft />Back to app</a><Input aria-label="Search settings" placeholder="Search the settings" value={search} onChange={(event) => setSearch(event.target.value)} /></> : <Button size="sm" disabled><Plus />Create a task</Button>}
      {groups.map((group) => <nav className="nav-group" key={group.label} aria-label={group.label}><div className="nav-caption">{group.label}</div>{group.items.filter((item) => item.label.toLowerCase().includes(search.toLowerCase())).map((item) => {
        const Icon = item.icon;
        return "href" in item ? <a key={item.label} className="nav-item" href={item.href} aria-current={item.label === title ? "page" : undefined}><Icon />{item.label}</a> : <span key={item.label} className="nav-item" aria-disabled="true"><Icon />{item.label}</span>;
      })}</nav>)}
      <div className="sidebar-footer"><a className="nav-item" href={healthHref}><StatusIcon status={ready ? "warning" : "unhealthy"} />{ready ? "Optional tool not ready" : "Host needs attention"}</a>{!settings && <a className="nav-item" href={healthHref}><Settings />Settings</a>}<Separator /><div className="workspace-name"><Avatar size="sm"><AvatarFallback>AM</AvatarFallback></Avatar><div>Adam Meghji<div className="user-caption">{sampleUser}</div></div></div></div>
    </aside>}
    <main className="app-main"><header className="app-header">{sidebar && <span className="mobile-nav"><Button size="icon-sm" variant="ghost" aria-label="Open navigation" aria-expanded={navigationOpen} onClick={() => setNavigationOpen(!navigationOpen)}><PanelLeft /></Button></span>}{!sidebar && <div className="host-symbol"><ListTodo /></div>}<h1>{title}</h1><div className="header-actions">{actions}</div></header>{children}</main>
  </div>;
}

function Setup({ preset, setPreset }: { preset: Preset; setPreset: (value: Preset) => void }) {
  const [step, setStep] = useState<SetupStep>(preset === "ready" ? "ready" : query.get("step") === "herdr" ? "start" : "auth");
  const [selected, setSelected] = useState(query.get("step") === "herdr" ? "herdr-readiness" : "provider:opencode");
  const checks = setupChecks(step);
  const healthyCount = checks.filter((check) => check.status === "healthy").length;
  const allChecks = [...checks, ...optionalChecks];
  const selectedCheck = allChecks.find((check) => check.id === selected) ?? checks[0];
  const busy = preset === "checking";
  function selectCheck(id: string, button: HTMLButtonElement) {
    setSelected(id);
    const preview = button.closest(".preview");
    const panel = preview?.querySelector<HTMLElement>(".repair-panel");
    if (preview && preview.clientWidth <= 640) requestAnimationFrame(() => { panel?.focus(); panel?.scrollIntoView({ block: "start" }); });
  }

  useEffect(() => {
    if (preset === "ready") { setStep("ready"); setSelected("herdr-readiness"); }
    if (preset === "blocked" && step === "ready") { setStep("auth"); setSelected("provider:opencode"); }
  }, [preset, step]);

  useEffect(() => {
    if (!busy) return;
    const timer = window.setTimeout(() => {
      const next = step === "auth" ? "install" : step === "install" ? "start" : "ready";
      setStep(next);
      setSelected("herdr-readiness");
      setPreset(next === "ready" ? "ready" : "blocked");
    }, 1100);
    return () => window.clearTimeout(timer);
  }, [busy, step, setPreset]);

  if (!selectedCheck) return null;
  const Icon = selectedCheck.icon;
  const ready = step === "ready";
  const checkAgain = () => setPreset("checking");
  const purpose = selectedCheck.id === "provider:opencode" ? "Sign in to OpenCode" : selectedCheck.id === "herdr-readiness" ? step === "start" ? "Start the agent terminals" : "Install the agent terminals" : selectedCheck.label;
  return <Shell title="Set up Suplex" actions={<Badge variant="outline">Host setup</Badge>}>
    <HostStrip />
    <section className="setup-progress" aria-label="Setup progress">
      <div className="section-label"><span>{ready ? "Suplex is ready" : busy ? "Suplex checks the host" : "Prepare your host"}</span><span className="muted" aria-live="polite">{healthyCount} of {checks.length} ready</span></div>
      <div className="progress-track" role="progressbar" aria-label="Checklist progress" aria-valuenow={healthyCount} aria-valuemin={0} aria-valuemax={checks.length}>{checks.map((check) => <span key={check.id} className="progress-segment" data-complete={check.status === "healthy"} data-current={check.id === selected && check.status !== "healthy"} />)}</div>
      <div className="progress-labels">{checks.map((check) => <span key={check.id}>{check.label}</span>)}</div>
    </section>
    <div className="setup-grid"><section className="setup-list" aria-label="Host checklist">
      <div className="section-label"><span>Host tools and providers</span><Badge variant="secondary">{checks.length}</Badge></div>
      {checks.map((check) => <button className="check-select" key={check.id} aria-pressed={selected === check.id} onClick={(event) => selectCheck(check.id, event.currentTarget)}><StatusIcon status={check.status} icon={check.icon} /><span><span className="check-label">{check.label}</span><span className="check-purpose block">{check.purpose}</span></span><CheckBadge status={check.status} /></button>)}
      <div className="mt-4"><Accordion><AccordionItem value="optional"><AccordionTrigger><span className="flex items-center gap-2">Optional tools<Badge variant="outline">{optionalChecks.length}</Badge></span></AccordionTrigger><AccordionContent><div className="mb-2 text-xs muted">You can set these up later.</div>{optionalChecks.map((check) => <button className="check-select" key={check.id} aria-pressed={selected === check.id} onClick={(event) => selectCheck(check.id, event.currentTarget)}><StatusIcon status={check.status} icon={check.icon} /><span><span className="check-label">{check.label}</span><span className="check-purpose block">{check.purpose}</span></span><ChevronRight size={14} /></button>)}</AccordionContent></AccordionItem></Accordion></div>
    </section><section className="repair-panel" aria-label="Selected check" aria-live="polite" tabIndex={-1}>
      <div className="repair-heading"><div className="repair-symbol"><StatusIcon status={selectedCheck.status} icon={selectedCheck.status === "healthy" ? CheckCircle2 : Icon} /></div><div><div className="mb-1"><CheckBadge status={selectedCheck.status} /></div><h2>{selectedCheck.status === "healthy" ? `${selectedCheck.label} is ready` : purpose}</h2></div></div>
      <p>{selectedCheck.summary}</p>
      {selectedCheck.command ? <><div className="repair-instructions"><Timeline value={1}>
        <TimelineItem step={1}><TimelineSeparator /><TimelineIndicator /><TimelineHeader><TimelineTitle>1. Open the Terminal on the host</TimelineTitle></TimelineHeader><TimelineContent>Use the account <strong>{sampleUser}</strong> on <strong>{sampleHost}</strong>.</TimelineContent></TimelineItem>
        <TimelineItem step={2}><TimelineSeparator /><TimelineIndicator /><TimelineHeader><TimelineTitle>2. {selectedCheck.id === "provider:opencode" || selectedCheck.id === "gh-auth" ? "Sign in with this command" : step === "start" ? "Start Herdr with this command" : "Install Herdr with this command"}</TimelineTitle></TimelineHeader><TimelineContent><Command key={selectedCheck.command} command={selectedCheck.command} /></TimelineContent></TimelineItem>
        <TimelineItem step={3}><TimelineIndicator /><TimelineHeader><TimelineTitle>3. Check the host again</TimelineTitle></TimelineHeader><TimelineContent>Return to Suplex after the command finishes.</TimelineContent></TimelineItem>
      </Timeline></div><div className="mt-5 mb-2"><Button size="sm" onClick={checkAgain} disabled={busy}>{busy ? <Spinner /> : <RefreshCw />}{busy ? "Check in progress" : "Check again"}</Button></div></> : <div className="my-5"><Alert><CheckCircle2 /><AlertTitle>{ready ? "All checks are ready" : "No action is necessary"}</AlertTitle><AlertDescription>{ready ? "Continue to your tasks. You can sign in to GitHub later." : "Select a tool that needs attention."}</AlertDescription></Alert></div>}
      <TechnicalDetails key={selectedCheck.id} check={selectedCheck} />
    </section></div>
    <footer className="setup-footer"><div className="footer-message" role="status">{busy ? <Spinner /> : <StatusIcon status={ready ? "healthy" : "unhealthy"} />}{busy ? "Suplex checks the sample host." : ready ? "All checks passed." : `${checks.length - healthyCount} ${checks.length - healthyCount === 1 ? "check needs" : "checks need"} attention.`}</div><div className="setup-footer-actions"><Button size="sm" variant="outline" onClick={checkAgain} disabled={busy} aria-label="Check all tools again"><RefreshCw />Check again</Button>{<Button size="sm" nativeButton={false} role="link" render={<a href={ready ? `${tasksHref}?state=ready` : tasksHref} />}>Continue<ArrowRight /></Button>}</div></footer>
  </Shell>;
}

function Health() {
  const [filter, setFilter] = useState("all");
  const [selected, setSelected] = useState("herdr-readiness");
  const [freshness, setFreshness] = useState<"current" | "checking" | "refreshed">("current");
  const issueCount = healthChecks.filter((check) => check.status !== "healthy").length;
  const healthyCount = healthChecks.length - issueCount;
  const selectedCheck = healthChecks.find((check) => check.id === selected);
  useEffect(() => {
    if (freshness !== "checking") return;
    const timer = window.setTimeout(() => setFreshness("refreshed"), 1100);
    return () => window.clearTimeout(timer);
  }, [freshness]);
  function checkList() {
    return <div className="health-workspace"><div>{["Suplex services", "Host tools", "Provider access"].map((group) => {
      const checks = healthChecks.filter((check) => check.group === group && (filter === "all" || check.status !== "healthy"));
      if (!checks.length) return null;
      return <section className="health-group" key={group} aria-label={group}><div className="health-group-label">{group}<span>{checks.length}</span></div>{checks.map((check) => <button key={check.id} className="health-row" aria-pressed={selected === check.id} onClick={(event) => {
        setSelected(check.id);
        const panel = event.currentTarget.closest(".health-workspace")?.querySelector<HTMLElement>(".health-inspector");
        const preview = event.currentTarget.closest(".preview");
        if (preview && preview.clientWidth <= 900) requestAnimationFrame(() => { panel?.focus(); panel?.scrollIntoView({ block: "start" }); });
      }}><StatusIcon status={check.status} icon={check.icon} /><span><span className="health-row-name block">{check.label}</span><span className="health-row-summary block">{check.id === "herdr-readiness" ? "Suplex cannot reach Herdr" : check.id === "gh-auth" ? "Sign-in not available" : check.purpose}</span></span><CheckBadge status={check.status} /><ChevronRight size={12} /></button>)}</section>;
    })}</div><aside className="health-inspector" aria-label="Check details" tabIndex={-1}>
      {selectedCheck && <><div className="flex items-center gap-2 mb-3"><StatusIcon status={selectedCheck.status} icon={selectedCheck.icon} /><h2>{selectedCheck.label}</h2></div><div className="mb-3"><CheckBadge status={selectedCheck.status} /></div><p>{selectedCheck.summary}</p>{selectedCheck.command && <><Command key={selectedCheck.command} command={selectedCheck.command} />{selectedCheck.id === "herdr-readiness" && <div className="my-3"><Button size="sm" variant="outline" nativeButton={false} role="link" render={<a href={`${setupHref}?step=herdr`} />}>Repair the host<ArrowRight /></Button></div>}</>}<TechnicalDetails key={selectedCheck.id} check={selectedCheck} /><Separator /></>}
      <div className="storage-summary"><div className="storage-heading"><HardDrive />Artifact storage</div><div className="storage-value">412 GB<span>free</span></div><meter aria-label="Free storage meets the 100 MB minimum" min={0} max={104_857_600} value={412_000_000_000} /><div className="text-xs muted">100 MB minimum met</div></div><Separator /><div className="storage-summary"><div className="storage-heading"><ShieldCheck />Backup verification</div><div className="flex items-center gap-2"><StatusIcon status="healthy" /><span>Verified 2 hours ago</span></div><div className="text-xs muted">Last verified sample backup</div></div>
    </aside></div>;
  }
  return <Shell title="Host health" settings actions={<Button size="sm" variant="outline" aria-label="Refresh" onClick={() => setFreshness("checking")} disabled={freshness === "checking"}>{freshness === "checking" ? <Spinner /> : <RefreshCw />}{freshness === "checking" ? "Check in progress" : "Check again"}</Button>}>
    <HostStrip /><div className="health-content"><Alert variant="destructive"><CircleAlert /><AlertTitle>Herdr needs attention</AlertTitle><AlertDescription>Herdr cannot open the agent terminals. <a href={`${setupHref}?step=herdr`}>Repair the host</a>.</AlertDescription></Alert>
      <div className="health-overview"><div><div className="health-count"><strong>{healthyCount}<span> / {healthChecks.length}</span></strong><span>checks healthy</span></div><div className="health-meter" role="img" aria-label={`${healthyCount} healthy checks, ${issueCount} issues`}>{healthChecks.map((check) => <span key={check.id} data-status={check.status} title={`${check.label}: ${check.status}`} />)}</div><div className="health-legend"><span className="legend-item"><StatusIcon status="healthy" />{healthyCount} healthy</span><span className="legend-item"><StatusIcon status="unhealthy" />{healthChecks.filter((check) => check.status === "unhealthy").length} blocked</span><span className="legend-item"><StatusIcon status="warning" />{healthChecks.filter((check) => check.status === "warning").length} optional</span></div></div><div className="last-check" role="status">{freshness === "checking" ? "Suplex checks the sample host." : freshness === "refreshed" ? "Sample checks refreshed just now" : "Last successful check 12 seconds ago"}</div></div>
      <Tabs value={filter} onValueChange={(value) => { setFilter(String(value)); if (value === "attention" && selectedCheck?.status === "healthy") setSelected("herdr-readiness"); }}><TabsList variant="line" aria-label="Filter checks"><TabsTrigger value="all">All checks<Badge variant="secondary">{healthChecks.length}</Badge></TabsTrigger><TabsTrigger value="attention">Attention<Badge variant="secondary">{issueCount}</Badge></TabsTrigger></TabsList><TabsContent value="all">{checkList()}</TabsContent><TabsContent value="attention">{checkList()}</TabsContent></Tabs>
    </div>
  </Shell>;
}

function Connection() {
  const [retry, setRetry] = useState<"idle" | "pending" | "failed">("idle");
  const [changeAddress, setChangeAddress] = useState(false);
  const [address, setAddress] = useState("http://localhost:4111");
  useEffect(() => {
    if (retry !== "pending") return;
    const timer = window.setTimeout(() => setRetry("failed"), 1100);
    return () => window.clearTimeout(timer);
  }, [retry]);
  return <Shell title="Connect to Suplex" sidebar={false} actions={<Badge variant="outline">Suplex.app</Badge>}><div className="connection-content">
    <div className="connection-diagram" aria-label="This Suplex window cannot reach the Suplex host"><div className="connection-node"><div className="node-icon"><Monitor /></div><strong>This window</strong><small>Suplex.app</small></div><div className="connection-break"><XCircle /></div><div className="connection-node"><div className="node-icon"><Server /></div><strong>Suplex host</strong><small>{address}</small></div></div>
    <Alert variant="destructive"><Wifi /><AlertTitle>Suplex is not available</AlertTitle><AlertDescription>{retry === "failed" ? "The sample host did not respond. Check that Suplex has started." : "This window cannot reach the Suplex host."}</AlertDescription></Alert>
    <h2>Start Suplex on the host</h2><p>Open the Terminal on the host. Run this command from the Suplex folder.</p><Command command="pnpm run suplex start" />
    <div className="connection-actions"><Button size="sm" disabled={retry === "pending"} onClick={() => setRetry("pending")}>{retry === "pending" ? <Spinner /> : <RefreshCw />}{retry === "pending" ? "Retry in progress" : "Retry"}</Button><Button size="sm" variant="outline" onClick={() => setChangeAddress(!changeAddress)}>Open a different Suplex</Button></div>
    {changeAddress && <div className="mb-5"><label htmlFor="suplex-address" className="block mb-2 text-xs">Suplex address</label><Input id="suplex-address" value={address} type="url" onChange={(event) => setAddress(event.target.value)} /><p>The preview uses this address in the connection diagram.</p></div>}
    <Separator /><div className="flex flex-wrap items-center justify-between gap-3 mt-4"><Button size="sm" variant="link" nativeButton={false} role="link" render={<a href="https://github.com/meiji-industries/suplex#readme" target="_blank" rel="noreferrer" />}>Open the install guide<ExternalLink /></Button><Button size="sm" variant="ghost" nativeButton={false} role="link" render={<a href={setupHref} />}>Review the next screen<ArrowRight /></Button></div>
  </div></Shell>;
}

const taskGroups = [
  { label: "In progress", icon: CircleDashed, tasks: [{ id: "FRG-142", title: "Add dependency checks with remedies", time: "12 min" }, { id: "FRG-141", title: "Cache the health reader for page loads", time: "38 min" }] },
  { label: "Your response", icon: CircleAlert, tasks: [{ id: "FRG-139", title: "Rotate the passkey invitation token", time: "1 h" }] },
  { label: "Done", icon: CheckCircle2, tasks: [{ id: "FRG-138", title: "Preserve Worker context across assignments", time: "Sep 6" }, { id: "FRG-137", title: "Generate pull request titles from the reviewed solution", time: "Sep 5" }] },
];

function Tasks() {
  const [taskFilter, setTaskFilter] = useState("all");
  const ready = query.get("state") === "ready";
  return <Shell title="Tasks" ready={ready} actions={<Button size="sm" disabled><Plus />Create a task</Button>}>
    {!ready && <div className="banner-wrap"><Alert variant="destructive"><Activity /><AlertTitle>Herdr stopped on your host</AlertTitle><AlertDescription>Suplex cannot open new agent terminals. Your task history is still available. <a href={`${setupHref}?step=herdr`}>Repair Herdr</a>.</AlertDescription></Alert></div>}
    <div className="task-toolbar"><Tabs value={taskFilter} onValueChange={(value) => setTaskFilter(String(value))}><TabsList variant="line" aria-label="Task filter"><TabsTrigger value="all">All tasks</TabsTrigger><TabsTrigger value="response">Your response<Badge variant="secondary">1</Badge></TabsTrigger></TabsList></Tabs><Button size="icon-sm" variant="ghost" disabled aria-label="Filter tasks"><ListFilter /></Button></div>
    {taskGroups.filter((group) => taskFilter === "all" || group.label === "Your response").map((group) => <section key={group.label} aria-label={group.label}><div className="task-group-title"><group.icon />{group.label}<Badge variant="secondary">{group.tasks.length}</Badge></div>{group.tasks.map((task) => <div className="task-row" key={task.id}><group.icon /><span className="task-key">{task.id}</span><span className="task-title">{task.title}</span><Badge variant="outline">suplex</Badge><span className="task-time">{task.time}</span><Avatar size="xs"><AvatarFallback>AM</AvatarFallback></Avatar></div>)}</section>)}
  </Shell>;
}

function Index() {
  const screens = [
    { href: "01-desktop-not-available.html", label: "01 · Connect to the host", detail: "See the connection problem. Start Suplex, then retry.", icon: Monitor },
    { href: setupHref, label: "02 · Set up Suplex", detail: "Complete the host checklist with one repair at a time.", icon: ListTodo },
    { href: tasksHref, label: "03 · Repair from your tasks", detail: "A stopped tool links directly to its repair.", icon: ClipboardList },
    { href: healthHref, label: "04 · Check host health", detail: "Review status, filter issues, and inspect a check.", icon: ShieldCheck },
  ];
  return <Shell title="Dependency setup" sidebar={false} actions={<Badge variant="outline">Design preview</Badge>}><div className="index-content"><div className="section-label"><span>Review the flow</span><span className="muted">4 screens</span></div><nav aria-label="Mockup screens">{screens.map((screen) => <a className="screen-link" href={screen.href} key={screen.href}><span className="screen-number"><screen.icon /></span><span><h2>{screen.label}</h2><p>{screen.detail}</p></span><ArrowRight size={16} /></a>)}</nav><div className="index-notes"><p>These interactive previews use Suplex's installed shadcn and ReUI components. All host data and check results are simulated.</p><div className="mt-3"><Accordion><AccordionItem value="review"><AccordionTrigger>Review controls and local preview</AccordionTrigger><AccordionContent><div className="grid gap-3 text-xs"><p>Use the toolbar to change the theme, preview width, and setup state. Check again advances the setup sample.</p><p>From the repository root, run <code>pnpm exec vite --host 127.0.0.1</code>. Open <code>/docs/mockups/dependency-setup/index.html</code> on the displayed local URL.</p><p>The preview needs Vite. Opening the HTML files directly does not load the components.</p><a href="../../plans/2026-09-07-dependency-setup.md">Open the dependency setup plan</a></div></AccordionContent></AccordionItem></Accordion></div></div></div></Shell>;
}

function App() {
  const [width, setWidth] = useState("desktop");
  const [dark, setDark] = useState(false);
  const [scenario, setScenario] = useState(0);
  const [preset, setPreset] = useState<Preset>(query.get("state") === "ready" ? "ready" : query.get("state") === "checking" ? "checking" : "blocked");
  const page = location.pathname.split("/").pop() ?? "index.html";
  const isSetup = page === setupHref;
  const isIndex = page === "index.html" || page === "";
  useEffect(() => { document.documentElement.classList.toggle("dark", dark); }, [dark]);
  return <>
    <div className="review-bar" aria-label="Design review controls">
      <div className="review-label">
        {!isIndex && <Button variant="ghost" size="icon-xs" aria-label="Open the flow index" nativeButton={false} role="link" render={<a href="index.html" />}><ArrowLeft /></Button>}
        <Badge variant="outline">Prototype</Badge><span className="muted">Simulated host data</span>
      </div>
      {isSetup && <div className="review-controls" aria-label="Setup state">
        {["blocked", "checking", "ready"].map((value) => <Button key={value} size="xs" variant={preset === value ? "secondary" : "ghost"} aria-pressed={preset === value} onClick={() => {
          if (value === "blocked" || value === "checking" || value === "ready") { setPreset(value); setScenario(scenario + 1); }
        }}>{value === "blocked" ? "Blocked" : value === "checking" ? "Check in progress" : "Ready"}</Button>)}
      </div>}
      <div className="review-controls" aria-label="Preview width">
        {[{ value: "desktop", label: "Desktop", icon: Monitor }, { value: "760", label: "760", icon: PanelLeft }, { value: "390", label: "390", icon: Smartphone }].map((option) => <Button key={option.value} size="xs" variant={width === option.value ? "secondary" : "ghost"} aria-pressed={width === option.value} onClick={() => setWidth(option.value)}><option.icon />{option.label}</Button>)}
      </div>
      <div className="review-controls" aria-label="Preview theme">
        <Button size="icon-xs" variant={dark ? "ghost" : "secondary"} aria-label="Light theme" aria-pressed={!dark} onClick={() => setDark(false)}><Sun /></Button>
        <Button size="icon-xs" variant={dark ? "secondary" : "ghost"} aria-label="Dark theme" aria-pressed={dark} onClick={() => setDark(true)}><Moon /></Button>
      </div>
    </div>
    <div className="review-stage"><div className="preview" data-width={width}>
      <div className="window-chrome" aria-hidden="true"><i className="window-dot" /><i className="window-dot" /><i className="window-dot" /><span className="window-title">Suplex</span></div>
      {isSetup ? <Setup key={scenario} preset={preset} setPreset={setPreset} /> : page === healthHref ? <Health /> : page === tasksHref ? <Tasks /> : page === "01-desktop-not-available.html" ? <Connection /> : <Index />}
      <div className="simulation-note"><Info size={12} /><span>Interactive preview · Commands are never run · Results use sample data</span></div>
    </div></div>
  </>;
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
