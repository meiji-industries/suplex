import { ArrowRight, Check, CheckCircle2, Copy, RefreshCw, Server, Terminal } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";

import type { HealthCheck } from "../../contracts/health.js";
import type { HealthCheckId } from "../../contracts/health-checks.js";
import type { ProfileResponse, ProjectResponse } from "../../contracts/projects.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { CheckStatusIndicator, connectionRoute, HealthCheckIcon, healthCheckPurpose, healthFreshnessLabel, HealthTechnicalDetails, useSystemHealth, type HealthContextSelector } from "../../components/app/system-health.js";
import { Alert, AlertDescription, AlertTitle } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../../components/ui/timeline.js";
import { readJsonUnchecked } from "../../lib/api.js";

function repairTitle(check: HealthCheck): string {
  if (check.status === "healthy") return `${check.label} is ready`;
  if (check.details.state === "signed-out") return `Sign in to ${check.label}`;
  if (check.details.failure === "api-unreachable") return "Start Herdr";
  if (check.details.failure === "protocol-incompatible") return "Restart Herdr";
  if (check.summary.endsWith("is not installed")) return `Install ${check.label}`;
  return check.label;
}

/** The checks setup shows: host tools plus the providers of the selected context. */
export function setupChecklist(snapshot: { checks: readonly HealthCheck[] } | undefined): HealthCheck[] {
  return snapshot?.checks.filter((check) => check.id === "git" || check.id === "herdr-readiness" || check.provider !== undefined) ?? [];
}

/** The provider context to probe: the project when given, otherwise the selected profile. */
export function setupContext(projectId: string | undefined, project: unknown, activeProfileId: string | undefined): HealthContextSelector {
  if (projectId !== undefined) return project ? { projectId } : project === null && activeProfileId ? { profileIds: [activeProfileId] } : undefined;
  return activeProfileId ? { profileIds: [activeProfileId] } : undefined;
}

export function ProviderContextBar({ projectId, project, profiles, activeProfileId, onSelectProfile }: {
  projectId: string | undefined;
  project: ProjectResponse | null | undefined;
  profiles: ProfileResponse[] | undefined;
  activeProfileId: string | undefined;
  onSelectProfile: (id: string) => void;
}): ReactElement {
  return <div className="flex flex-wrap items-center gap-3 border-b px-4 py-3 lg:px-6">
    <span className="text-xs font-medium">Provider context</span>
    {projectId !== undefined && project === undefined ? <span className="text-xs text-muted-foreground">Suplex reads the project.</span> : null}
    {projectId !== undefined && project ? <span className="text-xs text-muted-foreground">Project {project.name}</span> : null}
    {projectId === undefined || project === null ? profiles === undefined ? <span className="text-xs text-muted-foreground">Suplex reads the profiles.</span> : profiles.length === 0 ? (
      <>
        <span className="text-xs text-muted-foreground">No profiles. Suplex checks Git and Herdr.</span>
        <Button size="xs" variant="outline" nativeButton={false} render={<a href="/admin/profiles" />}>Open profile settings</Button>
      </>
    ) : (
      <Select value={activeProfileId} onValueChange={(value) => onSelectProfile(value ?? "")}>
        <SelectTrigger size="sm" aria-label="Profile"><SelectValue placeholder="Select a profile" /></SelectTrigger>
        <SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent>
      </Select>
    ) : null}
  </div>;
}

/** Setup never gates: Continue always leads to the task list. */
export function SetupFooter({ status, refreshing, onCheckAgain }: { status: string; refreshing: boolean; onCheckAgain: () => void }): ReactElement {
  return <footer className="flex flex-wrap items-center justify-between gap-4 border-t px-4 py-4 lg:px-6"><p role="status" className="flex max-w-xl items-center gap-2 text-xs text-muted-foreground">{refreshing ? <Spinner /> : null}{status}</p><div className="ml-auto flex items-center gap-2"><Button size="sm" variant="outline" aria-label="Check all tools again" onClick={onCheckAgain} disabled={refreshing}><RefreshCw />Check again</Button><Button size="sm" nativeButton={false} render={<a href="/tasks" />}>Continue<ArrowRight /></Button></div></footer>;
}

export function SetupView(): ReactElement {
  const { snapshot, freshness, lastSuccessfulCheckAt, refreshing, refresh, watch } = useSystemHealth();
  const [selectedId, setSelectedId] = useState<HealthCheckId>();
  const [copyFeedback, setCopyFeedback] = useState<{ id: HealthCheckId; remedy: string; status: "copied" | "failed" }>();
  const panel = useRef<HTMLElement>(null);
  const projectId = useMemo(() => new URLSearchParams(window.location.search).get("projectId") ?? undefined, []);
  const [profiles, setProfiles] = useState<ProfileResponse[] | undefined>();
  const [project, setProject] = useState<ProjectResponse | null | undefined>();
  const [selectedProfileId, setSelectedProfileId] = useState<string>();

  useEffect(() => {
    void readJsonUnchecked<{ profiles: ProfileResponse[] }>("/api/profiles").then((result) => setProfiles(result.profiles)).catch(() => setProfiles([]));
  }, []);
  useEffect(() => {
    if (projectId === undefined) return;
    void readJsonUnchecked<ProjectResponse>(`/api/projects/${encodeURIComponent(projectId)}`).then(setProject).catch(() => setProject(null));
  }, [projectId]);

  const activeProfileId = selectedProfileId ?? profiles?.[0]?.id;
  const context = useMemo<HealthContextSelector>(() => setupContext(projectId, project, activeProfileId), [projectId, project, activeProfileId]);

  useEffect(() => watch(), [watch]);
  useEffect(() => {
    void refresh(context);
  }, [refresh, context]);

  const checks = useMemo(() => setupChecklist(snapshot), [snapshot]);
  const needsAttention = checks.filter((check) => check.status !== "healthy");
  const selectedCheck = checks.find((check) => check.id === selectedId) ?? needsAttention[0] ?? checks[0];
  const copyState = copyFeedback?.id === selectedCheck?.id && copyFeedback?.remedy === selectedCheck?.remedy ? copyFeedback?.status : "idle";
  const hostAddress = snapshot?.reachableAddress ?? window.location.origin;
  const status = refreshing || freshness === "checking"
    ? "Suplex checks the host."
    : freshness === "stale"
      ? "Suplex could not check the host. Select Check again."
      : needsAttention.length === 0
        ? "All checks are healthy."
        : `${needsAttention.length} ${needsAttention.length === 1 ? "check needs" : "checks need"} attention.`;

  useEffect(() => {
    if (copyFeedback?.status !== "copied") return;
    const timer = window.setTimeout(() => setCopyFeedback(undefined), 1500);
    return () => window.clearTimeout(timer);
  }, [copyFeedback]);

  function selectCheck(id: HealthCheckId): void {
    setSelectedId(id);
    if (window.matchMedia("(max-width: 767px)").matches) {
      requestAnimationFrame(() => { panel.current?.focus(); panel.current?.scrollIntoView({ block: "start" }); });
    }
  }

  return <ApplicationFrame title="Set up Suplex" headerRight={<Badge variant="outline">Host setup</Badge>}>
    <div className="flex flex-wrap items-center gap-3 border-b px-4 py-4 lg:px-6">
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/40"><Server className="size-4" /></div>
      <div className="min-w-0 flex-1"><p className="break-all text-sm font-medium">{hostAddress}</p><p className="text-xs text-muted-foreground">Suplex host · {connectionRoute(hostAddress)}</p></div>
      <span className="w-full text-xs text-muted-foreground sm:w-auto" data-health-freshness={freshness}>{healthFreshnessLabel(freshness, lastSuccessfulCheckAt)}</span>
    </div>
    <ProviderContextBar projectId={projectId} project={project} profiles={profiles} activeProfileId={activeProfileId} onSelectProfile={(id) => setSelectedProfileId(id || undefined)} />
    <div className="grid min-w-0 flex-1 md:grid-cols-[minmax(260px,0.8fr)_minmax(0,1.2fr)]">
      <section aria-label="Host checklist" className="min-w-0 border-b bg-muted/10 p-4 md:border-r md:border-b-0 lg:p-6">
        <div className="mb-3 flex items-center justify-between text-xs"><h2 className="font-medium">Host tools and providers</h2><Badge variant="secondary">{checks.length}</Badge></div>
        <div className="space-y-1">{checks.map(check => <button key={check.id} type="button" aria-pressed={selectedCheck?.id === check.id} onClick={() => selectCheck(check.id)} className="flex w-full items-center gap-3 rounded-md border border-transparent p-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring aria-pressed:border-border aria-pressed:bg-muted/60"><HealthCheckIcon check={check} /><span className="min-w-0 flex-1"><span className="block text-sm font-medium">{check.label}</span><span className="block text-xs text-muted-foreground">{healthCheckPurpose(check.id)}</span></span><CheckStatusIndicator check={check} /></button>)}</div>
        {checks.length === 0 ? <p className="text-xs text-muted-foreground">No checks are available.</p> : null}
      </section>
      <section ref={panel} aria-label="Selected check" tabIndex={-1} className="min-w-0 p-4 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring lg:p-6">
        {selectedCheck ? <>
          <div className="mb-4 flex items-center gap-3"><div className="flex size-10 shrink-0 items-center justify-center rounded-md border bg-muted/40"><HealthCheckIcon check={selectedCheck} /></div><div><CheckStatusIndicator check={selectedCheck} /><h2 className="mt-1.5 text-base font-medium">{repairTitle(selectedCheck)}</h2></div></div>
          <p className="mb-1 text-sm font-medium">{healthCheckPurpose(selectedCheck.id)}</p><p className="text-xs text-muted-foreground">{selectedCheck.summary}</p>
          {selectedCheck.remedy && selectedCheck.remedyKind === "link" ? <div className="my-5 space-y-3"><Alert><CheckCircle2 /><AlertTitle>Repair {selectedCheck.label}</AlertTitle><AlertDescription>Open the instructions. Follow them on the Suplex host. Then check again.</AlertDescription></Alert><div className="flex flex-wrap items-center gap-2"><Button size="sm" variant="outline" nativeButton={false} render={<a href={selectedCheck.remedy} target="_blank" rel="noreferrer" />}>Open the instructions</Button><Button size="sm" onClick={() => void refresh(context)} disabled={refreshing}><RefreshCw />Check again</Button></div></div> : selectedCheck.remedy ? <div className="mt-6"><Timeline value={1}>
            <TimelineItem step={1}><TimelineSeparator /><TimelineIndicator /><TimelineHeader><TimelineTitle>1. Open the Terminal on the host</TimelineTitle></TimelineHeader><TimelineContent><p className="break-all text-xs">Use the host at {hostAddress}.</p></TimelineContent></TimelineItem>
            <TimelineItem step={2}><TimelineSeparator /><TimelineIndicator /><TimelineHeader><TimelineTitle>2. Run this command</TimelineTitle></TimelineHeader><TimelineContent><div className="mt-2 space-y-2 rounded-md border bg-muted/20 p-3"><p className="flex items-center gap-1.5 text-xs text-muted-foreground"><Terminal className="size-3.5" />Run on the Suplex host</p><div className="flex flex-wrap items-center gap-2"><code className="min-w-0 flex-1 break-all text-xs text-foreground">{selectedCheck.remedy}</code><Button size="xs" variant="outline" aria-label="Copy the command" onClick={async () => { const remedy = selectedCheck.remedy ?? ""; try { await navigator.clipboard.writeText(remedy); setCopyFeedback({ id: selectedCheck.id, remedy, status: "copied" }); } catch { setCopyFeedback({ id: selectedCheck.id, remedy, status: "failed" }); } }}>{copyState === "copied" ? <Check /> : <Copy />}{copyState === "copied" ? "Copied" : "Copy"}</Button></div>{copyState === "failed" ? <p role="status" className="text-xs text-destructive">Suplex cannot copy the command. Select the command and copy it manually.</p> : null}</div></TimelineContent></TimelineItem>
            <TimelineItem step={3}><TimelineIndicator /><TimelineHeader><TimelineTitle>3. Check the host again</TimelineTitle></TimelineHeader><TimelineContent><p className="text-xs">Return to Suplex after the command finishes.</p><div className="mt-3"><Button size="sm" onClick={() => void refresh(context)} disabled={refreshing}>{refreshing ? <Spinner /> : <RefreshCw />}{refreshing ? "Check in progress" : "Check again"}</Button></div></TimelineContent></TimelineItem>
          </Timeline></div> : <div className="my-5"><Alert><CheckCircle2 /><AlertTitle>{selectedCheck.status === "healthy" ? "No action is necessary" : "Check the host again"}</AlertTitle><AlertDescription>{selectedCheck.status === "healthy" ? "Select a tool that needs attention." : "Suplex did not receive repair instructions for this check."}</AlertDescription></Alert></div>}
          <div className="mt-3"><HealthTechnicalDetails key={selectedCheck.id} check={selectedCheck} /></div>
        </> : <p className="text-sm text-muted-foreground">{freshness === "checking" ? "Suplex checks the host." : "No host tools are available. Check again."}</p>}
      </section>
    </div>
    <SetupFooter status={status} refreshing={refreshing} onCheckAgain={() => void refresh(context)} />
  </ApplicationFrame>;
}
