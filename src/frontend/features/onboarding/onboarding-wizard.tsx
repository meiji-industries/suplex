import { copyToClipboard } from "../../lib/clipboard.js";
import { ProfileFields } from "../profiles/profile-fields.js";
import { SettingsSection, SettingRow } from "../settings/settings-layout.js";
import { getAccount } from "../account/lib/account-api.js";
import { useProfileDraft } from "../profiles/lib/profile-draft.js";
import { ProjectsContent } from "../projects/projects-content.js";
import { ArrowLeft, Check, Copy, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState, type ReactElement } from "react";

import { CheckStatusIndicator, healthCheckPurpose, HealthRow, HerdrInstallButton, useSystemHealth } from "../../components/app/system-health.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { ProviderIcon } from "../../components/app/provider-icons.js";
import { ToolIcon } from "../../components/app/tool-icons.js";
import { AvatarEditor } from "../../components/app/entity-avatar.js";
import { StatusLight } from "../../components/app/status-light.js";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { FieldDescription } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenu, SidebarMenuButton, SidebarMenuItem, SidebarTrigger, useSidebar } from "../../components/ui/sidebar.js";
import { Stepper, StepperIndicator, StepperItem, StepperNav, StepperSeparator, StepperTitle, StepperTrigger } from "../../components/ui/stepper.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { CompanySwitcher } from "../../shell/company-switcher.js";
import { useExperiments } from "../../shell/experiments-api.js";
import { navigate } from "../../shell/navigation-state.js";
import { isApiError, withCompany } from "../../lib/api.js";
import { InternalAgentsManager } from "../admin/internal-agents-manager.js";
import { AgentCard } from "../admin/internal-agents-section.js";
import { AddCard } from "../../components/app/add-card.js";
import { MovesIllustration } from "../moves/moves-illustration.js";
import { ProviderLoginTerminal, useProviderLogin } from "../settings/provider-login.js";
import { ONBOARDING_TOOL_CHECKS, ONBOARDING_STEPS, connectedProviders, stepComplete, useOnboardingData, type OnboardingData, type OnboardingStepId } from "./onboarding.js";
import { LoadingState } from "../../components/app/loading-state.js";
import { ProviderInstallationInstructions } from "../../components/app/provider-installation.js";
import { newTaskRequestPath } from "../../shell/global-new-task-dialog.js";
import { getBillingSummary, startCheckout, startTrial } from "../settings/lib/billing-api.js";
import type { BillingSummary } from "../../contracts/billing.js";
import { OnboardingPlanPicker, type OnboardingPlan } from "./onboarding-plan.js";



function stepFromUrl(state: OnboardingData["state"]): OnboardingStepId {
  const requested = new URLSearchParams(window.location.search).get("step");
  if (ONBOARDING_STEPS.some(step => step.id === requested)) return requested as OnboardingStepId;
  return ONBOARDING_STEPS.find(step => step.id === "plan" || !stepComplete(state, step.id))?.id ?? "plan";
}

function OnboardingSidebar({ companyId, current, state }: { companyId: string; current: OnboardingStepId; state: OnboardingData["state"] }): ReactElement {
  const currentIndex = ONBOARDING_STEPS.findIndex(step => step.id === current);
  const { setOpenMobile } = useSidebar();
  return (
    <Sidebar variant="inset" collapsible="offcanvas">
      <SidebarHeader data-tauri-drag-region="deep" className="titlebar-top">
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
  const { currentCompany, user, updateProfile, renameCompany, setCompanyIssueCode, reloadCompanies } = useCompanyContext();
  const todayPage = useExperiments()?.todayPage ?? false;
  const companyId = currentCompany?.id ?? "";
  const { state, reload, loading, error: loadError } = useOnboardingData(currentCompany);
  const { snapshot, refresh, freshness, refreshing } = useSystemHealth();
  const githubCheck = snapshot?.checks.find(check => check.id === "gh-auth");
  const connected = connectedProviders(state.providers);
  const current = stepFromUrl(state);
  const currentIndex = ONBOARDING_STEPS.findIndex(step => step.id === current);
  const defaultCompanyName = currentCompany?.name === "My Company" && !currentCompany.issueCode ? "" : currentCompany?.name ?? "";
  const [name, setName] = useState(defaultCompanyName);
  const [code, setCode] = useState(currentCompany?.issueCode ?? "SUPLEX");
  const [error, setError] = useState("");
  const [email, setEmail] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [planChoice, setPlanChoice] = useState<{ companyId: string; plan: OnboardingPlan }>();
  const plan = state.projects.length >= 3 ? "pro" : planChoice?.companyId === companyId ? planChoice.plan : "free";
  const checkoutKey = useRef<string | undefined>(undefined);
  const [billing, setBilling] = useState<BillingSummary>();
  useEffect(() => { if (current === "plan") void getBillingSummary().then(setBilling).catch(() => setBilling(undefined)); }, [current]);
  // Pro starts with the trial when the Suplex account has one; otherwise Stripe Checkout opens.
  const needsCheckout = current === "plan" && plan === "pro" && billing?.plan !== "pro" && billing?.trialAvailable !== true;
  useEffect(() => { if (user?.id === "user_development") void getAccount().then(result => setEmail(result.account?.email)).catch(() => undefined); }, [user?.id]);
  const { profile, changeProfile } = useProfileDraft(user, email);
  useEffect(() => { setName(defaultCompanyName); setCode(currentCompany?.issueCode ?? "SUPLEX"); }, [currentCompany?.id]);
  const { login, loginPending, startLogin, closeLogin } = useProviderLogin({ reload });
  const go = (id: OnboardingStepId): void => navigate(withCompany(`/onboarding?step=${id}`, companyId));
  const continueStep = async (): Promise<void> => {
    if (saving) return;
    setError("");
    setSaving(true);
    const checkoutTab = needsCheckout ? window.open("", "_blank") : null;
    if (checkoutTab) checkoutTab.opener = null;
    try {
      if (current === "company" && currentCompany) {
        if (!name.trim() || !code.trim() || !profile.displayName.trim() || !profile.username.trim()) return;
        await updateProfile({ ...profile, displayName: profile.displayName.trim(), username: profile.username.trim(), title: profile.title.trim() });
        if (name !== currentCompany.name) await renameCompany(currentCompany.id, name);
        if (code !== currentCompany.issueCode) await setCompanyIssueCode(currentCompany.id, code);
        await reloadCompanies();
      }
      if (current === "plan" && plan === "pro" && billing?.plan !== "pro") {
        if (!needsCheckout) {
          await startTrial();
        } else {
          checkoutKey.current ??= crypto.randomUUID();
          const result = await startCheckout(checkoutKey.current);
          if (result.status === "redirect" || (result.status === "payment_required" && result.url)) {
            const url = result.url!;
            if (checkoutTab) checkoutTab.location.href = url;
            else { window.location.assign(url); return; }
          } else if (result.status === "payment_required") {
            throw new Error("Open Settings > Billing to complete the payment.");
          } else {
            checkoutTab?.close();
          }
        }
      }
      if (currentIndex < ONBOARDING_STEPS.length - 1) go(ONBOARDING_STEPS[currentIndex + 1]!.id);
    } catch (reason) {
      checkoutTab?.close();
      if (isApiError(reason) && reason.code === "billing_operation_not_applied") checkoutKey.current = undefined;
      setError(reason instanceof Error ? reason.message : "Suplex could not save the onboarding step.");
    }
    finally { setSaving(false); }
  };
  const avatarName = name.trim() || currentCompany?.name || "";
  const body = current === "company" ? <div>
    <SettingsSection title="Profile">
      {user ? <ProfileFields userId={user.id} email={email} value={profile} onChange={changeProfile} disabled={saving} /> : <LoadingState />}
    </SettingsSection>
    <SettingsSection title="Company">
      <SettingRow label="Company picture">
        {currentCompany ? <AvatarEditor compact kind="company" id={currentCompany.id} name={avatarName} seed={avatarName} /> : null}
      </SettingRow>
      <SettingRow label="Company name" htmlFor="onboarding-name">
        <div className="w-full sm:w-60"><Input size="sm" id="onboarding-name" disabled={saving} value={name} onChange={event => setName(event.target.value)} /></div>
      </SettingRow>
      <SettingRow label="Company code" htmlFor="onboarding-code">
        <div className="w-full sm:w-60"><Input size="sm" id="onboarding-code" disabled={saving} maxLength={10} pattern="[A-Z][A-Z0-9]{1,9}" value={code} onChange={event => setCode(event.target.value.toUpperCase())} /></div>
      </SettingRow>
    </SettingsSection>
  </div>
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
                </> : check.summary : id === "herdr-readiness" ? null : check.status === "healthy" ? <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />{id === "git" ? "Git is available" : "CLI tools installed"}</span> : healthCheckPurpose(id)}
              </div>
            </div>
            {check ? <CheckStatusIndicator check={check} healthyLabel="Done" /> : loading ? <Skeleton className="h-5 w-16 shrink-0" /> : <Badge variant="outline">Not available</Badge>}
          </div>
          {id === "herdr-readiness" && check && check.status === "unhealthy" && user?.role === "admin" ? <div className="mt-2"><HerdrInstallButton /></div>
            : check && check.status !== "healthy" && check.remedy ? <div className="mt-2 flex gap-2">
            {check.remedyKind === "link" ? <Button size="xs" variant="outline" nativeButton={false} render={<a href={check.remedy} target="_blank" rel="noreferrer" />}>Open the instructions</Button> : <><code className="min-w-0 flex-1 break-all text-xs">{check.remedy}</code><Button size="xs" variant="outline" onClick={() => void copyToClipboard(check.remedy!, "Copied the setup command to clipboard")}><Copy />Copy</Button></>}
          </div> : null}
          {id === "gh-auth" && check?.details.method === "device" && check.status !== "healthy" && user?.role === "admin" ? <div className="mt-2"><GithubDeviceSignIn onConnected={async () => { await refresh(); await reload(); }} /></div> : null}
        </div>;
      })}
    </div>
    : current === "providers" ? <div className="space-y-3"><div className="grid gap-3 sm:grid-cols-2" aria-busy={loading} aria-label="Providers">{loading && state.providers.length === 0 ? [0, 1, 2, 3].map(index => <Card key={index} size="sm" aria-label="Provider check in progress"><CardHeader><CardTitle><Skeleton className="h-5 w-20" /></CardTitle><CardAction><Skeleton className="h-5 w-20" /></CardAction></CardHeader><CardContent><Skeleton className="h-4 w-16" /><div className="space-y-1"><Skeleton className="h-4 w-full" /><Skeleton className="h-4 w-3/4" /></div><Skeleton className="h-8 w-full" /></CardContent></Card>) : state.providers.map(provider => <Card highlighted key={provider.id} size="sm"><CardHeader><CardTitle><span className="flex items-center gap-2.5 text-base"><ProviderIcon provider={provider.id} size="md" />{provider.label}</span></CardTitle><CardAction>{provider.status === "missing" ? <><StatusLight level="red" label="Not installed" /><Badge variant="outline">Not installed</Badge></> : provider.connection.status === "connected" ? <><StatusLight level="green" label="Connected" /><Badge variant="secondary">Connected</Badge></> : <><StatusLight level="amber" label="Needs auth" /><Badge variant="outline">Needs auth</Badge></>}</CardAction></CardHeader><CardContent><div className="flex flex-col text-xs text-muted-foreground [&>*]:border-t [&>*]:border-border/50 [&>*]:py-4 [&>*:last-child]:pb-0">{provider.connection.status === "connected" ? <div><Tooltip><TooltipTrigger><span className="cursor-help underline decoration-dashed underline-offset-4">{provider.modelCount} models available</span></TooltipTrigger><TooltipContent side="bottom" align="start"><ul className="max-h-60 overflow-y-auto font-mono text-xs">{provider.models.length ? provider.models.map(model => <li key={model.id} className="break-all">{model.id}</li>) : <li>No models available</li>}</ul></TooltipContent></Tooltip></div> : null}{provider.connection.status === "connected" ? <p className="flex items-start gap-1"><Check aria-hidden="true" className="mt-0.5 size-3 shrink-0" /><span className="min-w-0 break-words">{provider.connection.account ? `Signed in as ${provider.connection.account}` : "Signed in"}</span></p> : provider.id === "opencode" && provider.connection.status === "not-connected" && provider.status !== "missing" ? null : <p>{provider.connection.summary}</p>}{provider.status === "missing" ? <ProviderInstallationInstructions provider={provider.id} checkLabel="Check again" /> : provider.connection.status !== "connected" ? <div className="grid"><Button size="sm" disabled={loginPending !== null} onClick={() => void startLogin(`provider:${provider.id}`, provider.label, `/api/admin/providers/${provider.id}/login`).catch(reason => setError(reason instanceof Error ? reason.message : "Suplex could not open a sign-in pane."))}>Sign in</Button></div> : null}</div></CardContent></Card>)}</div></div>
    : current === "agents" ? loading && state.profiles.length === 0 ? <LoadingState /> : <InternalAgentsManager agents={state.profiles} onSaved={reload} renderCards={openNewAgent => <div className="grid gap-3 sm:grid-cols-2" aria-label="Your team">{state.profiles.filter(agent => !agent.archivedAt).map(agent => <AgentCard key={agent.id} agent={agent} />)}<AddCard label="Add agent" onClick={openNewAgent} /></div>} />
    : current === "projects" ? <div>
      {githubCheck ? <div className="border-b" aria-label="GitHub sign-in"><HealthRow check={githubCheck} compact flush /></div> : null}
      <ProjectsContent currentCompany={currentCompany} projects={state.projects} agents={state.profiles} loading={loading} projectsLoading={loading && state.projects.length === 0} loadError={error || loadError} canSignInToGitHub={user?.role === "admin"} reload={reload} reloadCompanies={reloadCompanies} />
    </div>
    : current === "plan" ? loading ? <LoadingState /> : <OnboardingPlanPicker value={plan} onChange={plan => setPlanChoice({ companyId, plan })} projectCount={state.projects.length} trialAvailable={billing?.trialAvailable === true} disabled={saving} />
    : <div className="flex flex-1 flex-col items-center justify-center gap-6 text-center">
      <MovesIllustration />
      <div className="space-y-4" aria-live="polite">
        <h2 className="text-balance text-2xl font-extralight tracking-tight sm:text-3xl">
          <span className="block">Your agents do the work.</span>{" "}
          <span className="block text-primary">Suplex runs the workflow.</span>
        </h2>
        <p className="font-mono text-xs tracking-widest text-muted-foreground">PLAN. BUILD. REVIEW. SHIP.</p>
      </div>
    </div>;
  const continueDisabled = saving || (current === "company" ? !user || !name.trim() || !code.trim() || !profile.displayName.trim() || !profile.username.trim() : current === "providers" ? connected.length === 0 : current === "projects" ? state.projects.length === 0 : current === "plan" ? loading || !companyId || Boolean(loadError) : false);
  const heading = current === "company" ? "Add your details" : current === "tools" ? "Check the host tools" : current === "providers" ? "Connect your accounts" : current === "agents" ? "Your team" : current === "projects" ? "Add a project" : current === "plan" ? "Select your plan" : "Onboarding complete";
  const description = current === "company" ? "Review your details, then add your company."
    : current === "tools" ? "Suplex uses tools on your machine to get work done for you"
    : current === "providers" ? "Connect your existing subscriptions and models to your new Suplex agents"
    : current === "agents" ? "The Coordinator plans each task. The Worker builds the changes."
    : current === "projects" ? "Connect a GitHub repository for your first task."
    : current === "plan" ? ""
    : "Review the setup, then open the tasks.";
  const checking = current === "tools" ? refreshing : loading;
  const visibleError = error || loadError || (current === "tools" && freshness === "stale" ? "Suplex could not check the host. Select Check again." : "");
  return (
    <ApplicationFrame title="Onboarding" viewportBound sidebar={<OnboardingSidebar companyId={companyId} current={current} state={state} />}>
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className={current === "projects" ? "flex min-h-0 min-w-0 flex-1 overflow-y-auto px-4 pb-8 lg:px-6" : "flex min-h-0 min-w-0 flex-1 overflow-y-auto p-3 sm:p-6"}>
        <section id={`stepper-panel-${currentIndex + 1}`} role="tabpanel" aria-labelledby={`stepper-tab-${currentIndex + 1}`} className={current === "projects" ? "flex min-w-0 flex-1" : "flex min-w-0 flex-1 px-5 py-8 sm:px-10 sm:py-14 lg:py-20"}>
          <div className="mx-auto flex w-full max-w-[53rem] flex-col gap-8 lg:min-h-[32rem]">
            {current !== "done" && current !== "projects" ? <div className="space-y-2" aria-live="polite">
              <div className="flex items-center justify-between gap-3">
                <h2 className="text-xl font-semibold">{heading}</h2>
                {current !== "company" && (current !== "plan" || loadError) ? <Button size="icon-sm" variant="ghost" aria-label={checking ? "Check in progress" : "Check again"} title={checking ? "Check in progress" : "Check again"} disabled={checking} onClick={() => void (current === "tools" ? refresh() : reload())}>
                  {checking ? <Spinner /> : <RefreshCw />}
                </Button> : null}
              </div>
              {description ? <FieldDescription>{description}</FieldDescription> : null}
            </div> : null}
            {visibleError && current !== "projects" ? <Alert variant="destructive"><AlertDescription>{visibleError}</AlertDescription></Alert> : null}
            {body}
          </div>
        </section>
      </div>
            <footer className="shrink-0 border-t bg-background px-4 py-3 sm:px-6">
              <div className="mx-auto grid w-full max-w-[53rem] gap-2">
              {current === "done" ? <>
                <Button onClick={() => navigate(newTaskRequestPath)}>Create your first task</Button>
                {todayPage ? <Button variant="outline" nativeButton={false} render={<a href="/today" />}>Today</Button> : null}
              </> : <>
                <Button variant={continueDisabled ? "secondary" : "default"} disabled={continueDisabled} onClick={() => void continueStep()}>Continue</Button>
              </>}
              </div>
            </footer>
      </div>
      <ProviderLoginTerminal login={login} onClose={() => void closeLogin()} />
    </ApplicationFrame>
  );
}
