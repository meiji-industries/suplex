import { ArrowLeft, Check, Copy, PartyPopper, RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { CheckStatusIndicator, healthCheckPurpose, useSystemHealth } from "../../components/app/system-health.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { ProviderIcon } from "../../components/app/provider-icons.js";
import { ToolIcon } from "../../components/app/tool-icons.js";
import { AvatarEditor } from "../../components/app/entity-avatar.js";
import { StatusLight } from "../../components/app/status-light.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Field, FieldDescription, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { NewButton } from "../../components/ui/new-button.js";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../../components/ui/sidebar.js";
import { Stepper, StepperIndicator, StepperItem, StepperNav, StepperSeparator, StepperTitle, StepperTrigger } from "../../components/ui/stepper.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { CompanySwitcher } from "../../shell/company-switcher.js";
import { navigate } from "../../shell/navigation-state.js";
import { withCompany } from "../../lib/api.js";
import { InternalAgentsManager } from "../admin/internal-agents-manager.js";
import { AgentCard, isDefaultAgent } from "../admin/internal-agents-section.js";
import { ProjectCards } from "../projects/project-cards.js";
import { CreateProjectDialog } from "../projects/create-project-dialog.js";
import { RecentRepositories } from "../projects/recent-repositories.js";
import { ProviderLoginTerminal, useProviderLogin } from "../settings/provider-login.js";
import { ONBOARDING_TOOL_CHECKS, ONBOARDING_STEPS, connectedProviders, stepComplete, useOnboardingData, type OnboardingData, type OnboardingStepId } from "./onboarding.js";
import { LoadingState } from "../../components/app/loading-state.js";
import type { ApiProfile } from "../../shell/view-shared.js";
import { ProviderInstallationInstructions } from "../../components/app/provider-installation.js";
import { requestNewTask } from "../../shell/global-new-task-dialog.js";


/** The seeded Coordinator and Worker. If one is missing or archived, show every active agent. */
function defaultTeam(profiles: readonly ApiProfile[]): readonly ApiProfile[] {
  const active = profiles.filter(profile => !profile.archivedAt);
  const defaults = active.filter(isDefaultAgent);
  return defaults.length === 2 ? defaults : active;
}

function stepFromUrl(state: OnboardingData["state"]): OnboardingStepId {
  const requested = new URLSearchParams(window.location.search).get("step");
  if (ONBOARDING_STEPS.some(step => step.id === requested)) return requested as OnboardingStepId;
  return ONBOARDING_STEPS.find(step => !stepComplete(state, step.id))?.id ?? "done";
}

function OnboardingSidebar({ companyId, current, state }: { companyId: string; current: OnboardingStepId; state: OnboardingData["state"] }): ReactElement {
  const currentIndex = ONBOARDING_STEPS.findIndex(step => step.id === current);
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader className="titlebar-drag titlebar-top">
        <div className="flex items-center gap-1">
          <div className="min-w-0 flex-1"><CompanySwitcher /></div>
          <span className="md:hidden"><SidebarTrigger aria-label="Close navigation" title="Close navigation" /></span>
        </div>
      </SidebarHeader>
      <SidebarContent>
        <div className="my-auto px-6 py-8">
          <Stepper orientation="vertical" value={currentIndex + 1} aria-label="Onboarding steps" onValueChange={value => {
            const step = ONBOARDING_STEPS[value - 1];
            if (step) { navigate(withCompany(`/onboarding?step=${step.id}`, companyId)); setOpenMobile(false); }
          }}>
            <StepperNav>
              {ONBOARDING_STEPS.map((step, index) => (
                <StepperItem key={step.id} step={index + 1} disabled={!ONBOARDING_STEPS.slice(0, index).every(previous => stepComplete(state, previous.id))}>
                  <StepperTrigger aria-controls={`stepper-panel-${index + 1}`} aria-current={step.id === current ? "step" : undefined}>
                    <span className="grid w-52 grid-cols-[1.5rem_1fr] items-start gap-3 text-left">
                      <StepperIndicator>{index + 1}</StepperIndicator>
                      <span className="pt-1"><StepperTitle>{step.label}</StepperTitle></span>
                    </span>
                  </StepperTrigger>
                  {index < ONBOARDING_STEPS.length - 1 ? <div className="flex w-6 self-start justify-center"><StepperSeparator /></div> : null}
                </StepperItem>
              ))}
            </StepperNav>
          </Stepper>
        </div>
      </SidebarContent>
      <SidebarFooter><SidebarMenu><SidebarMenuItem><SidebarMenuButton render={<a href="/today" />}><ArrowLeft />Back to app</SidebarMenuButton></SidebarMenuItem></SidebarMenu></SidebarFooter>
    </Sidebar>
  );
}

export function OnboardingView(): ReactElement {
  const { currentCompany, user, renameCompany, setCompanyIssueCode, reloadCompanies } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const { state, reload, loading, error: loadError } = useOnboardingData(currentCompany);
  const { refresh, freshness, refreshing } = useSystemHealth();
  const connected = connectedProviders(state.providers);
  const current = stepFromUrl(state);
  const currentIndex = ONBOARDING_STEPS.findIndex(step => step.id === current);
  const [name, setName] = useState(currentCompany?.name || "My Company");
  const [code, setCode] = useState(currentCompany?.issueCode ?? "SUPLEX");
  const [error, setError] = useState("");
  const [projectsOpen, setProjectsOpen] = useState(false);
  const [customizeAgents, setCustomizeAgents] = useState(false);
  useEffect(() => { setName(currentCompany?.name || "My Company"); setCode(currentCompany?.issueCode ?? "SUPLEX"); }, [currentCompany?.id]);
  const { login, loginPending, startLogin, closeLogin } = useProviderLogin({ reload });
  const go = (id: OnboardingStepId): void => navigate(withCompany(`/onboarding?step=${id}`, companyId));
  const continueStep = async (): Promise<void> => {
    setError("");
    try {
      if (current === "company" && currentCompany) {
        if (!name.trim() || !code.trim()) return;
        if (name !== currentCompany.name) await renameCompany(currentCompany.id, name);
        if (code !== currentCompany.issueCode) await setCompanyIssueCode(currentCompany.id, code);
        await reloadCompanies();
      }
      if (currentIndex < ONBOARDING_STEPS.length - 1) go(ONBOARDING_STEPS[currentIndex + 1]!.id);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Suplex could not save the onboarding step."); }
  };
  const body = current === "company" ? <FieldGroup>
    <Field><FieldLabel htmlFor="onboarding-name">Company name</FieldLabel><Input id="onboarding-name" value={name} onChange={event => setName(event.target.value)} /></Field>
    {currentCompany ? <Field><FieldLabel>Avatar</FieldLabel><AvatarEditor kind="company" id={currentCompany.id} name={currentCompany.name} seed={currentCompany.name} /></Field> : null}
    <Field><FieldLabel htmlFor="onboarding-code">Company code</FieldLabel><Input id="onboarding-code" maxLength={10} pattern="[A-Z][A-Z0-9]{1,9}" value={code} onChange={event => setCode(event.target.value.toUpperCase())} /></Field>
  </FieldGroup>
    : current === "tools" ? <div className="space-y-3" aria-busy={freshness === "checking" && state.checks.length === 0}>
      {ONBOARDING_TOOL_CHECKS.map(id => {
        const check = state.checks.find(check => check.id === id);
        const loading = !check && freshness === "checking";
        return <div key={id} className="border-b pb-3">
          <div className="flex items-center gap-3">
            {check || !loading ? <ToolIcon tool={id} /> : <Skeleton className="size-4 shrink-0" />}
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium">{id === "git" ? "Git" : id === "gh-auth" ? "GitHub" : "Herdr"}</span>{" "}
              <span className="text-xs text-muted-foreground">{id === "git" ? "for source control" : id === "gh-auth" ? "for branches, pull requests, and merges" : "runs your agents in the background"}</span>
              <div className="text-xs text-muted-foreground">
                {loading ? <div aria-label="Check in progress">
                  {id !== "herdr-readiness" ? <Skeleton className="h-4 w-32" /> : null}
                  {id === "gh-auth" ? <Skeleton className="h-4 w-44" /> : null}
                </div> : !check ? "Check not available. Select Check again." : id === "gh-auth" && check.details.method === "device" ? check.status === "healthy" ? <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />{check.details.logins ? `Signed in as ${check.details.logins}` : "GitHub is connected"}</span> : check.summary : id === "gh-auth" ? check.status === "healthy" ? <>
                  <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />CLI tools installed</span>
                  <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />{check.details.logins ? `Signed in as ${check.details.logins}` : "Signed in"}</span>
                </> : check.summary : id === "herdr-readiness" ? null : check.status === "healthy" ? <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />{id === "git" && check.details.engine === "libgit2" ? "Git is available" : "CLI tools installed"}</span> : healthCheckPurpose(id)}
              </div>
            </div>
            {check ? <CheckStatusIndicator check={check} healthyLabel="Done" /> : loading ? <Skeleton className="h-5 w-16 shrink-0" /> : <Badge variant="outline">Not available</Badge>}
          </div>
          {check && check.status !== "healthy" && check.remedy ? <div className="mt-2 flex gap-2">
            {check.remedyKind === "command" ? <><code className="min-w-0 flex-1 break-all text-xs">{check.remedy}</code><Button size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(check.remedy!)}><Copy />Copy</Button></> : <Button size="xs" variant="outline" nativeButton={false} render={<a href={check.remedy ?? "#"} target="_blank" rel="noreferrer" />}>Open the instructions</Button>}
          </div> : null}
          {id === "gh-auth" && check?.details.method === "device" && check.status !== "healthy" && user?.role === "admin" ? <div className="mt-2"><GithubDeviceSignIn onConnected={async () => { await refresh(); await reload(); }} /></div> : null}
        </div>;
      })}
    </div>
    : current === "providers" ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2" aria-busy={loading} aria-label="Providers">{loading && state.providers.length === 0 ? [0, 1, 2, 3].map(index => <Card key={index} size="sm" aria-label="Provider check in progress"><CardHeader><CardTitle><Skeleton className="h-5 w-20" /></CardTitle><CardAction><Skeleton className="h-5 w-20" /></CardAction></CardHeader><CardContent><Skeleton className="h-4 w-16" /><div className="space-y-1"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /></div><Skeleton className="h-8 w-full" /></CardContent></Card>) : state.providers.map(provider => <Card key={provider.id} size="sm"><CardHeader><CardTitle><span className="flex items-center gap-2"><ProviderIcon provider={provider.id} />{provider.label}</span></CardTitle><CardAction>{provider.status === "missing" ? <><StatusLight level="red" label="Not installed" /><Badge variant="outline">Not installed</Badge></> : provider.connection.status === "connected" ? <><StatusLight level="green" label="Connected" /><Badge variant="secondary">Connected</Badge></> : <><StatusLight level="amber" label="Needs auth" /><Badge variant="outline">Needs auth</Badge></>}</CardAction></CardHeader><CardContent className="space-y-2 text-xs text-muted-foreground"><div><Tooltip><TooltipTrigger><span className="cursor-help underline decoration-dashed underline-offset-4">{provider.modelCount} models available</span></TooltipTrigger><TooltipContent side="bottom" align="start"><ul className="max-h-60 overflow-y-auto font-mono text-xs">{provider.models.length ? provider.models.map(model => <li key={model.id} className="break-all">{model.id}</li>) : <li>No models available</li>}</ul></TooltipContent></Tooltip></div>{provider.connection.status === "connected" ? <p className="flex items-start gap-1"><Check aria-hidden="true" className="mt-0.5 size-3 shrink-0" /><span className="min-w-0 break-words">{provider.connection.account ? `Signed in as ${provider.connection.account}` : "Signed in"}</span></p> : provider.id === "opencode" && provider.connection.status === "not-connected" && provider.status !== "missing" ? null : <p>{provider.connection.summary}</p>}{provider.status === "missing" ? <ProviderInstallationInstructions provider={provider.id} checkLabel="Check again" /> : provider.connection.status !== "connected" ? <Button size="sm" disabled={loginPending !== null} onClick={() => void startLogin(`provider:${provider.id}`, provider.label, `/api/admin/providers/${provider.id}/login`).catch(reason => setError(reason instanceof Error ? reason.message : "Suplex could not open a sign-in pane."))}>Sign in</Button> : null}</CardContent></Card>)}</div></div>
    : current === "agents" ? loading && state.profiles.length === 0 ? <LoadingState /> : customizeAgents ? <InternalAgentsManager agents={state.profiles} onSaved={reload} /> : <div className="grid gap-3 sm:grid-cols-2" aria-label="Your team">{defaultTeam(state.profiles).map(agent => <AgentCard key={agent.id} agent={agent} />)}</div>
    : current === "projects" ? <div className="space-y-3">{state.projects.length ? <div className="grid gap-3"><ProjectCards projects={state.projects} agents={state.profiles} /></div> : null}<RecentRepositories companyId={companyId} projects={state.projects} canSignInToGitHub={user?.role === "admin"} onAdded={() => setProjectsOpen(false)} onCreated={reload} fallback={state.projects.length ? null : <div className="rounded-md border border-dashed p-6 text-center"><p className="text-sm">No projects yet.</p><p className="mt-1 text-xs text-muted-foreground">Suplex needs one connected GitHub repository before you can create a task.</p></div>} /><div className="grid"><NewButton onClick={() => setProjectsOpen(true)}>Add a project</NewButton></div><CreateProjectDialog open={projectsOpen} onOpenChange={setProjectsOpen} companyId={companyId} companyStatus={currentCompany?.status} canSignInToGitHub={user?.role === "admin"} onCreated={reload} reloadCompanies={reloadCompanies} /></div>
    : <div className="flex flex-1 flex-col items-center justify-center gap-4 text-center" aria-live="polite">
      <PartyPopper aria-hidden="true" className="size-12 text-amber-500" />
      <h2 className="text-xl font-semibold">You are all set!</h2>
      <p className="text-sm text-muted-foreground">Create your first task and put your agents to work.</p>
    </div>;
  const continueDisabled = current === "company" ? !name.trim() || !code.trim() : current === "providers" ? connected.length === 0 : current === "projects" ? state.projects.length === 0 : false;
  const heading = current === "company" ? "Set up your company" : current === "tools" ? "Check the host tools" : current === "providers" ? "Connect your accounts" : current === "agents" ? "Your team" : current === "projects" ? "Add a project" : "Onboarding complete";
  const description = current === "company" ? "What is your startup, agency, or company called?"
    : current === "tools" ? "Suplex uses tools on your machine to get work done for you"
    : current === "providers" ? "Connect your existing subscriptions and models to your new Suplex agents"
    : current === "agents" ? "The Coordinator plans each task. The Worker builds the changes."
    : current === "projects" ? "Connect a GitHub repository for your first task."
    : "Review the setup, then open the tasks.";
  const checking = current === "tools" ? refreshing : loading;
  const visibleError = error || loadError || (current === "tools" && freshness === "stale" ? "Suplex could not check the host. Select Check again." : "");
  return (
    <ApplicationFrame title="Onboarding" sidebar={<OnboardingSidebar companyId={companyId} current={current} state={state} />}>
      <div className="flex min-w-0 flex-1 p-3 sm:p-6">
        <section id={`stepper-panel-${currentIndex + 1}`} role="tabpanel" aria-labelledby={`stepper-tab-${currentIndex + 1}`} className="flex min-w-0 flex-1 px-5 py-8 sm:px-10 sm:py-14 lg:py-20">
          <div className={`mx-auto flex w-full flex-col gap-8 lg:min-h-[32rem] ${current === "agents" ? "max-w-6xl" : current === "providers" ? "max-w-xl" : "max-w-md"}`}>
            {current !== "done" ? <div className="space-y-2" aria-live="polite">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">{heading}</h2>
                <Button size="icon-sm" variant="ghost" aria-label={checking ? "Check in progress" : "Check again"} title={checking ? "Check in progress" : "Check again"} disabled={checking} onClick={() => void (current === "tools" ? refresh() : reload())}>
                  {checking ? <Spinner /> : <RefreshCw />}
                </Button>
              </div>
              <FieldDescription>{description}</FieldDescription>
            </div> : null}
            {visibleError ? <Alert variant="destructive"><AlertDescription>{visibleError}</AlertDescription></Alert> : null}
            {body}
            <footer className="mt-auto grid gap-2 pt-8">
              {current === "done" ? <>
                <Button onClick={() => requestNewTask()}>Create your first task</Button>
                <Button variant="outline" nativeButton={false} render={<a href="/today" />}>Today</Button>
              </> : <>
                <Button disabled={continueDisabled} onClick={() => void continueStep()}>Continue</Button>
                {current === "agents" && !customizeAgents ? <Button variant="outline" onClick={() => setCustomizeAgents(true)}>Customize</Button> : null}
              </>}
            </footer>
          </div>
        </section>
      </div>
      <ProviderLoginTerminal login={login} onClose={() => void closeLogin()} />
    </ApplicationFrame>
  );
}
