import { ArrowLeft, ArrowRight, Copy, RefreshCw } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { CheckStatusIndicator, HealthCheckIcon, healthCheckPurpose, useSystemHealth } from "../../components/app/system-health.js";
import { EntityAvatar } from "../../components/app/entity-avatar.js";
import { StatusLight } from "../../components/app/status-light.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger } from "../../components/ui/sidebar.js";
import { Timeline, TimelineContent, TimelineHeader, TimelineIndicator, TimelineItem, TimelineSeparator, TimelineTitle } from "../../components/ui/timeline.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { CompanySwitcher } from "../../shell/company-switcher.js";
import { navigate } from "../../shell/navigation-state.js";
import { withCompany, readJson } from "../../lib/api.js";
import { CreateProjectDialog } from "../projects/create-project-dialog.js";
import { setupChecklist } from "../settings/setup.js";
import { ProviderLoginTerminal, useProviderLogin } from "../settings/provider-login.js";
import { ONBOARDING_STEPS, connectedProviders, defaultAgentModels, onboardingSettingsPath, stepComplete, useOnboardingData, type OnboardingData, type OnboardingStepId, type RoleModelChoice } from "./onboarding.js";

const providerCommands = { opencode: "FORGE_OPENCODE_COMMAND", devin: "FORGE_DEVIN_COMMAND", codex: "FORGE_CODEX_COMMAND", "claude-code": "FORGE_CLAUDE_COMMAND" } as const;
const reasoningLevels = ["low", "medium", "high", "xhigh", "max"] as const;

type AgentChoice = { profileId?: string | undefined; choice?: RoleModelChoice | undefined };

function stepFromUrl(state: OnboardingData["state"]): OnboardingStepId {
  const requested = new URLSearchParams(window.location.search).get("step");
  if (ONBOARDING_STEPS.some(step => step.id === requested)) return requested as OnboardingStepId;
  return ONBOARDING_STEPS.find(step => !stepComplete(state, step.id))?.id ?? "done";
}

function OnboardingSidebar({ companyId, current, state }: { companyId: string; current: OnboardingStepId; state: OnboardingData["state"] }): ReactElement {
  const currentIndex = ONBOARDING_STEPS.findIndex(step => step.id === current);
  return <Sidebar variant="inset" collapsible="offcanvas"><SidebarHeader><div className="flex items-center gap-2"><SidebarTrigger className="md:hidden" /><CompanySwitcher /></div></SidebarHeader><SidebarContent><Timeline value={currentIndex + 1}>{ONBOARDING_STEPS.map((step, index) => {
    const enabled = ONBOARDING_STEPS.slice(0, index).every(previous => stepComplete(state, previous.id));
    return <TimelineItem key={step.id} step={index + 1}><TimelineSeparator /><TimelineIndicator /><TimelineHeader><TimelineTitle><button type="button" disabled={!enabled} onClick={() => navigate(`${withCompany("/onboarding", companyId)}&step=${step.id}`)}>{step.label}</button></TimelineTitle></TimelineHeader><TimelineContent><p className="text-xs text-muted-foreground">{step.description}</p></TimelineContent></TimelineItem>;
  })}</Timeline></SidebarContent><SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton render={<a href={withCompany("/tasks", companyId)} />}><ArrowLeft />Back to app</SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter></Sidebar>;
}

export function OnboardingView(): ReactElement {
  const { currentCompany, renameCompany, setCompanyIssueCode, reloadCompanies } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const { state, reload } = useOnboardingData(currentCompany);
  const { refresh } = useSystemHealth();
  const connected = connectedProviders(state.providers);
  const current = stepFromUrl(state);
  const currentIndex = ONBOARDING_STEPS.findIndex(step => step.id === current);
  const [name, setName] = useState(currentCompany?.name || "My Company");
  const [code, setCode] = useState(currentCompany?.issueCode ?? "FORGE");
  const [error, setError] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const defaults = useMemo(() => defaultAgentModels(connected), [connected]);
  const profileFor = (role: "root" | "worker"): AgentChoice => {
    const profile = state.profiles.find(candidate => candidate.role === role && candidate.archivedAt === null);
    if (profile && connected.some(provider => provider.id === profile.provider)) return { profileId: profile.id, choice: { provider: profile.provider, model: profile.model, reasoningLevel: profile.reasoningLevel as RoleModelChoice["reasoningLevel"] } };
    return profile ? { profileId: profile.id, choice: role === "root" ? defaults?.coordinator : defaults?.worker } : { choice: role === "root" ? defaults?.coordinator : defaults?.worker };
  };
  const [coordinator, setCoordinator] = useState<AgentChoice>();
  const [worker, setWorker] = useState<AgentChoice>();
  useEffect(() => { setName(currentCompany?.name || "My Company"); setCode(currentCompany?.issueCode ?? "FORGE"); }, [currentCompany?.id]);
  useEffect(() => { setCoordinator(profileFor("root")); setWorker(profileFor("worker")); }, [state.profiles, connected.length]);
  const { login, loginPending, startLogin, closeLogin } = useProviderLogin({ reload });
  const go = (id: OnboardingStepId): void => navigate(`${withCompany("/onboarding", companyId)}&step=${id}`);
  const continueStep = async (): Promise<void> => {
    setError("");
    try {
      if (current === "company" && currentCompany) {
        if (!name.trim() || !code.trim()) return;
        if (name !== currentCompany.name) await renameCompany(currentCompany.id, name);
        if (code !== currentCompany.issueCode) await setCompanyIssueCode(currentCompany.id, code);
        await reloadCompanies();
      }
      if (current === "agents") {
        for (const agent of [coordinator, worker]) {
          if (!agent?.profileId || !agent.choice) continue;
          const profile = state.profiles.find(candidate => candidate.id === agent.profileId);
          if (profile && (profile.provider !== agent.choice.provider || profile.model !== agent.choice.model || profile.reasoningLevel !== agent.choice.reasoningLevel)) await readJson(`/api/admin/profiles/${encodeURIComponent(agent.profileId)}`, { method: "PATCH", body: JSON.stringify(agent.choice) });
        }
        await reload();
      }
      if (currentIndex < ONBOARDING_STEPS.length - 1) go(ONBOARDING_STEPS[currentIndex + 1]!.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Forge could not save the onboarding step."); }
  };
  const agentRow = (label: string, agent: AgentChoice | undefined, setAgent: (agent: AgentChoice) => void): ReactElement => <div className="grid gap-2 border-b py-3 sm:grid-cols-4 sm:items-center"><span className="text-[13px] font-medium">{label}</span>{agent?.choice ? <><Select value={agent.choice.provider} onValueChange={provider => { const selected = connected.find(item => item.id === provider); if (selected) setAgent({ ...agent, choice: { ...agent.choice!, provider: selected.id, model: selected.models[0]?.id ?? "" } }); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{connected.map(provider => <SelectItem key={provider.id} value={provider.id}>{provider.label}</SelectItem>)}</SelectContent></Select><Select value={agent.choice.model} onValueChange={model => setAgent({ ...agent, choice: { ...agent.choice!, model: model ?? "" } })}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{connected.find(provider => provider.id === agent.choice?.provider)?.models.map(model => <SelectItem key={model.id} value={model.id}>{model.label}</SelectItem>)}</SelectContent></Select><Select value={agent.choice.reasoningLevel} onValueChange={reasoningLevel => { if (reasoningLevel) setAgent({ ...agent, choice: { ...agent.choice!, reasoningLevel: reasoningLevel as RoleModelChoice["reasoningLevel"] } }); }}><SelectTrigger size="sm"><SelectValue /></SelectTrigger><SelectContent>{reasoningLevels.map(level => <SelectItem key={level} value={level}>{level}</SelectItem>)}</SelectContent></Select></> : <a className="text-xs text-primary underline sm:col-span-3" href={withCompany("/admin/agents", companyId)}>No {label} profile exists. Open Agents settings.</a>}</div>;
  const body = current === "company" ? <FieldGroup><Field><FieldLabel htmlFor="onboarding-name">Company name</FieldLabel><Input id="onboarding-name" value={name} onChange={event => setName(event.target.value)} /></Field><Field><FieldLabel htmlFor="onboarding-code">Company code</FieldLabel><Input id="onboarding-code" maxLength={10} pattern="[A-Z][A-Z0-9_-]*" value={code} onChange={event => setCode(event.target.value.toUpperCase())} /></Field></FieldGroup>
    : current === "tools" ? <div className="space-y-3">{setupChecklist({ checks: state.checks }).filter(check => check.id === "git" || check.id === "herdr-readiness").map(check => <div key={check.id} className="border-b pb-3"><div className="flex items-center gap-3"><HealthCheckIcon check={check} /><span className="flex-1"><span className="block text-[13px] font-medium">{check.label}</span><span className="text-xs text-muted-foreground">{healthCheckPurpose(check.id)}</span></span><CheckStatusIndicator check={check} /></div>{check.status !== "healthy" && check.remedy ? <div className="mt-2 flex gap-2">{check.remedyKind === "command" ? <><code className="min-w-0 flex-1 break-all text-xs">{check.remedy}</code><Button size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(check.remedy!)}><Copy />Copy</Button></> : <Button size="xs" variant="outline" nativeButton={false} render={<a href={check.remedy ?? "#"} target="_blank" rel="noreferrer" />}>Open the instructions</Button>}</div> : null}</div>)}<Button size="sm" variant="outline" onClick={() => void refresh()}><RefreshCw />Check again</Button></div>
    : current === "providers" ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2">{state.providers.map(provider => <Card key={provider.id} size="sm"><CardHeader><CardTitle>{provider.label}</CardTitle><CardAction>{provider.status === "missing" ? <><StatusLight level="red" label="Not installed" /><Badge variant="outline">Not installed</Badge></> : provider.connection.status === "connected" ? <><StatusLight level="green" label="Connected" /><Badge variant="secondary">Connected</Badge></> : <><StatusLight level="amber" label="Sign-in necessary" /><Badge variant="outline">Sign-in necessary</Badge></>}</CardAction></CardHeader><CardContent className="space-y-2 text-xs text-muted-foreground"><p>{provider.modelCount} models</p><p>{provider.connection.summary}</p>{provider.status === "missing" ? <p>Set <code>{providerCommands[provider.id]}</code> on the host.</p> : provider.connection.status !== "connected" ? <Button size="sm" variant="outline" disabled={loginPending !== null} onClick={() => void startLogin(`provider:${provider.id}`, provider.label, `/api/admin/providers/${provider.id}/login`).catch(reason => setError(reason instanceof Error ? reason.message : "Forge could not open a sign-in pane."))}>Sign in</Button> : null}</CardContent></Card>)}</div><Button size="sm" variant="outline" onClick={() => void reload()}><RefreshCw />Check again</Button></div>
    : current === "agents" ? <div>{agentRow("Coordinator", coordinator, setCoordinator)}{agentRow("Worker", worker, setWorker)}</div>
    : current === "projects" ? <div className="space-y-3"><NewButton onClick={() => setProjectsOpen(true)}>Add a project</NewButton>{state.projects.length ? <div>{state.projects.map(project => <div key={project.id} className="flex items-center gap-3 border-b py-2"><EntityAvatar kind="project" id={project.id} name={project.name} seed={project.name} size="sm" /><span className="min-w-0 flex-1 text-[13px]">{project.name}</span><span className="text-xs text-muted-foreground">{project.repository} · {project.baseBranch}</span></div>)}</div> : <div className="rounded-md border border-dashed p-6 text-center"><p className="text-[13px]">No projects yet.</p><p className="mt-1 text-xs text-muted-foreground">Forge needs one connected GitHub repository before you can create a task.</p></div>}<CreateProjectDialog open={projectsOpen} onOpenChange={setProjectsOpen} companyId={companyId} companyStatus={currentCompany?.status} onCreated={reload} reloadCompanies={reloadCompanies} /></div>
    : <ul className="space-y-1 text-xs text-muted-foreground"><li>{currentCompany?.name} · {currentCompany?.issueCode}</li><li>{connected.length} connected providers</li><li>Coordinator: {coordinator?.choice?.model ?? "Not configured"}</li><li>Worker: {worker?.choice?.model ?? "Not configured"}</li><li>{state.projects.length} projects</li></ul>;
  const continueDisabled = current === "company" ? !name.trim() || !code.trim() : current === "providers" ? connected.length === 0 : current === "projects" ? state.projects.length === 0 : false;
  const heading = current === "company" ? "Name the company" : current === "tools" ? "Check the host tools" : current === "providers" ? "Connect a provider" : current === "agents" ? "Select the agent models" : current === "projects" ? "Add a project" : "Onboarding complete";
  return <ApplicationFrame title="Onboarding" sidebar={<OnboardingSidebar companyId={companyId} current={current} state={state} />}><main className="flex min-w-0 flex-1 flex-col"><div className="max-w-2xl px-4 py-5 lg:px-6"><h1 className="text-base font-medium">{heading}</h1><p className="mt-1 text-xs text-muted-foreground">{ONBOARDING_STEPS[currentIndex]!.description}</p><div className="mt-5">{error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}{body}</div>{current === "done" ? <div className="mt-5 flex gap-2"><Button size="sm" nativeButton={false} render={<a href={withCompany("/tasks", companyId)} />}>Open the tasks</Button><Button size="sm" variant="outline" nativeButton={false} render={<a href={onboardingSettingsPath(companyId)} />}>Open the settings</Button></div> : null}</div>{current !== "done" ? <footer className="mt-auto flex items-center justify-between border-t px-4 py-4 lg:px-6">{currentIndex > 0 ? <Button size="sm" variant="outline" onClick={() => go(ONBOARDING_STEPS[currentIndex - 1]!.id)}>Back</Button> : <span />}<Button size="sm" disabled={continueDisabled} onClick={() => void continueStep()}>Continue<ArrowRight /></Button></footer> : null}</main><ProviderLoginTerminal login={login} onClose={() => void closeLogin()} /></ApplicationFrame>;
}
