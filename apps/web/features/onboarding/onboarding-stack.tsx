import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";

import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { ProviderIcon } from "../../components/app/provider-icons.js";
import { PROVIDER_INSTALLATIONS } from "../../components/app/provider-installation.js";
import { HerdrInstallButton, useSystemHealth } from "../../components/app/system-health.js";
import { ToolIcon, type ToolIconId } from "../../components/app/tool-icons.js";
import type { HealthCheck } from "../../contracts/health.js";
import { Server } from "lucide-react";
import type { CliProviderSummary, EndpointProviderSummary } from "../../contracts/providers.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { thisComputer } from "../../shell/desktop-platform.js";
import { CHECK_STATUS_LABELS, LOCAL_ENDPOINT_TITLE, useLocalEndpointForm } from "../settings/local-endpoint-form.js";
import { OnboardingFrame, PrimaryButton } from "./onboarding-frame.js";
import { connectedProviders, ONBOARDING_TOOL_CHECKS, toolsReady, type OnboardingData } from "./onboarding.js";
import type { StepProps } from "./onboarding-wizard.js";

const TOOL_TEXT: Record<(typeof ONBOARDING_TOOL_CHECKS)[number], { name: string; purpose: string }> = {
  git: { name: "Git", purpose: "Source control" },
  "gh-auth": { name: "GitHub App", purpose: "Branches, pull requests and merges" },
  "gh-cli": { name: "GitHub CLI", purpose: "Lets agents read pull requests and checks" },
  "herdr-readiness": { name: "Herdr", purpose: "Runs your agents in the background, so you can step in anytime" },
};

/** Rows show their result one after another, as the board does, even when the results are already known. */
function useReveal(count: number, interval = 450): number {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown >= count) return;
    const timer = window.setTimeout(() => setShown(value => value + 1), shown === 0 ? 350 : interval);
    return () => window.clearTimeout(timer);
  }, [shown, count, interval]);
  return shown;
}

function Checking(): ReactElement {
  return <span className="pill p-mute"><svg className="spin" width="11" height="11" viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" strokeDasharray="2 1.6" /></svg>Checking</span>;
}

function Done({ label = "Done" }: { label?: string }): ReactElement {
  return <span className="pill p-ok">✓ {label}</span>;
}

function Row({ icon, name, detail, status, children }: { icon: ReactNode; name: string; detail: ReactNode; status: ReactNode; children?: ReactNode }): ReactElement {
  return <div className="sr">
    <span className="ic">{icon}</span>
    <div style={{ flex: 1, minWidth: 0 }}><b>{name}</b><div className="d">{detail}</div></div>
    {status}
    {children}
  </div>;
}

function CopyCommand({ command }: { command: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return <div className="cmd">
    <code>{command}</code>
    <button className="btn2" type="button" style={{ height: 28, fontSize: 12, padding: "0 12px" }} onClick={() => void copyToClipboard(command, "Copied the command to clipboard").then(setCopied)}>{copied ? "Copied" : "Copy"}</button>
  </div>;
}

function ToolRow({ id, check, revealed, canManage, onConnected }: { id: (typeof ONBOARDING_TOOL_CHECKS)[number]; check: HealthCheck | undefined; revealed: boolean; canManage: boolean; onConnected: () => Promise<void> }): ReactElement {
  const text = TOOL_TEXT[id];
  const healthy = check?.status === "healthy";
  const login = typeof check?.details.logins === "string" && check.details.logins ? check.details.logins : undefined;
  const detail = !check || !revealed ? text.purpose
    : healthy ? `${text.purpose} · ${id === "git" ? "available" : login ? `signed in as ${login}` : id === "herdr-readiness" ? "ready" : "signed in"}`
    : `${text.purpose} · ${check.summary}`;
  const action = !check || !revealed || healthy ? null
    : id === "gh-auth" && check.details.method === "device" && canManage ? <GithubDeviceSignIn primary onConnected={onConnected} />
    : id === "herdr-readiness" && check.status === "unhealthy" && canManage ? <HerdrInstallButton />
    : null;
  return <Row icon={<ToolIcon tool={id as ToolIconId} />} name={text.name} detail={detail} status={!check || !revealed ? <Checking /> : healthy ? <Done /> : action ?? <span className="pill p-ans">Needs setup</span>}>
    {check && revealed && !healthy && check.remedy && !action ? check.remedyKind === "link"
      ? <div className="cmd"><code>{check.remedy}</code><a className="btn2" style={{ height: 28, fontSize: 12, padding: "0 12px" }} href={check.remedy} target="_blank" rel="noreferrer">Open</a></div>
      : <CopyCommand command={check.remedy} /> : null}
  </Row>;
}

const ENDPOINT_ICON = <Server size={16} aria-hidden="true" />;
const SMALL_BUTTON = { height: 30, fontSize: 12, padding: "0 12px" } as const;

function EndpointRow({ provider, revealed }: { provider: EndpointProviderSummary; revealed: boolean }): ReactElement {
  const detail = `${provider.endpoint.modelId} · ${provider.endpoint.baseUrl}`;
  if (!revealed) return <Row icon={ENDPOINT_ICON} name={provider.label} detail="Suplex checks this endpoint" status={<Checking />} />;
  if (provider.connection.status === "connected") return <Row icon={ENDPOINT_ICON} name={provider.label} detail={`${detail} · model listed`} status={<Done label="Connected" />} />;
  return <Row icon={ENDPOINT_ICON} name={provider.label} detail={`${detail} · ${provider.connection.summary}`} status={<span className="pill p-ans">Not connected</span>} />;
}

/** Adds an OpenAI-compatible server, such as llama-server or MLX, inline in the step. */
function AddEndpointRow({ onAdded }: { onAdded: () => Promise<void> }): ReactElement {
  const [open, setOpen] = useState(false);
  const form = useLocalEndpointForm(onAdded);
  const { fields, check, busy } = form;
  const disabled = busy !== null;
  return <Row icon={ENDPOINT_ICON} name={LOCAL_ENDPOINT_TITLE} detail="llama-server, MLX, Ollama, or another OpenAI-compatible server" status={<button className="pill p-mute" type="button" aria-expanded={open} style={{ cursor: "pointer" }} onClick={() => setOpen(value => !value)}>Add {open ? "↑" : "↓"}</button>}>
    {open ? <form className="grp" aria-label={LOCAL_ENDPOINT_TITLE} style={{ flexBasis: "100%", marginLeft: 44 }} onSubmit={event => { event.preventDefault(); void form.add().then(added => { if (added) setOpen(false); }); }}>
      <div className="fr"><label htmlFor="onb-endpoint-url">Base URL</label><input id="onb-endpoint-url" className="input" required autoComplete="off" placeholder="http://127.0.0.1:8080/v1" disabled={disabled} value={fields.baseUrl} onChange={event => form.change({ baseUrl: event.target.value })} /></div>
      <div className="fr"><label htmlFor="onb-endpoint-key">API key (optional)</label><input id="onb-endpoint-key" className="input" type="password" autoComplete="off" disabled={disabled} value={fields.apiKey} onChange={event => form.change({ apiKey: event.target.value })} /></div>
      <div className="fr"><label htmlFor="onb-endpoint-model">Model id</label><input id="onb-endpoint-model" className="input" required autoComplete="off" placeholder="qwen3-coder" disabled={disabled} value={fields.modelId} onChange={event => form.change({ modelId: event.target.value })} /></div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", justifyContent: "flex-end", gap: 10, paddingTop: 10 }}>
        {check ? <span role="status" style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
          <span className={`pill ${check.status === "model-listed" ? "p-ok" : check.status === "reachable" ? "p-ans" : "p-mute"}`}>{CHECK_STATUS_LABELS[check.status]}</span>
          <span className="d" style={{ marginTop: 0 }}>{check.summary}</span>
        </span> : null}
        <button className="btn2" type="button" style={SMALL_BUTTON} disabled={!form.valid || disabled} onClick={() => void form.runCheck()}>Check</button>
        <button className="btn2" type="submit" style={SMALL_BUTTON} disabled={!form.valid || disabled}>Add</button>
      </div>
      {form.error ? <p className="error" role="alert">{form.error}</p> : null}
    </form> : null}
  </Row>;
}

function ProviderRow({ provider, revealed, busy, onSignIn }: { provider: CliProviderSummary; revealed: boolean; busy: boolean; onSignIn: () => void }): ReactElement {
  const [open, setOpen] = useState(false);
  const [later, setLater] = useState(false);
  const icon = <ProviderIcon provider={provider.id} />;
  if (!revealed) return <Row icon={icon} name={provider.label} detail="Checking this subscription" status={<Checking />} />;
  if (provider.status === "configured" && provider.connection.status === "connected") {
    const models = `${provider.modelCount} ${provider.modelCount === 1 ? "model" : "models"} available`;
    return <Row icon={icon} name={provider.label} detail={`${provider.connection.account ? `Signed in as ${provider.connection.account}` : "Signed in"} · ${models}`} status={<Done label="Connected" />} />;
  }
  if (later) return <Row icon={icon} name={provider.label} detail="Add it later in Settings" status={<button className="back" type="button" style={{ fontSize: 13, padding: "0 10px" }} onClick={() => setLater(false)}>Undo</button>} />;
  const laterButton = <button className="back" type="button" style={{ fontSize: 13, padding: "0 10px" }} onClick={() => { setLater(true); setOpen(false); }}>Add later</button>;
  if (provider.status === "missing") return <Row icon={icon} name={provider.label} detail="Not installed" status={<>{laterButton}<button className="pill p-mute" type="button" aria-expanded={open} style={{ cursor: "pointer" }} onClick={() => setOpen(value => !value)}>Install {open ? "↑" : "↓"}</button></>}>
    {open ? <CopyCommand command={PROVIDER_INSTALLATIONS[provider.id].command} /> : null}
  </Row>;
  return <Row icon={icon} name={provider.label} detail={provider.connection.summary || "Not signed in"} status={<>{laterButton}<button className="btn2" type="button" style={{ height: 30, fontSize: 12, padding: "0 12px" }} disabled={busy} onClick={onSignIn}>Sign in</button></>} />;
}

export function StackStep({ onBack, onNext, data, startLogin, loginPending }: StepProps & { data: OnboardingData; startLogin: (key: string, label: string, url: string) => Promise<void>; loginPending: string | null }): ReactElement {
  const { user } = useCompanyContext();
  const { snapshot, refresh, refreshing } = useSystemHealth();
  const { state, loading, reload } = data;
  const [error, setError] = useState("");
  const checks = snapshot?.checks ?? state.checks;
  const connected = connectedProviders(state.providers);
  const ready = toolsReady(checks) && connected.length > 0;
  // Tools first, then the agents, one row at a time.
  const shown = useReveal(ONBOARDING_TOOL_CHECKS.length + Math.max(state.providers.length, 1));
  const computer = thisComputer().replace("This ", "");
  const signIn = (provider: CliProviderSummary): void => {
    setError("");
    void startLogin(`provider:${provider.id}`, provider.label, `/api/admin/providers/${provider.id}/login`).catch(reason => setError(reason instanceof Error ? reason.message : "Suplex could not open a sign-in pane."));
  };
  const checkAgain = (): void => { void refresh(); void reload(); };
  // Stable, so the GitHub sign-in poll is not rescheduled on every render.
  const onConnected = useCallback(async (): Promise<void> => { await refresh(); await reload(); }, [refresh, reload]);

  return <OnboardingFrame step="stack" onBack={onBack} bodyClassName="s-stack" action={<PrimaryButton disabled={!ready} onClick={onNext}>Continue</PrimaryButton>}>
    <div className="stk">
      <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 24, flexWrap: "wrap" }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <h1 className="h2">Your stack.</h1>
          <p className="sub" style={{ textAlign: "left", maxWidth: 620 }}>Suplex runs on this {computer} and uses the tools and subscriptions you already have. We never mark up tokens.</p>
        </div>
        <button className="btn2" type="button" style={{ height: 36, fontSize: 13 }} disabled={refreshing || loading} onClick={checkAgain}>↻ {refreshing || loading ? "Checking…" : "Check again"}</button>
      </div>
      <div className="mono dimmer" style={{ fontSize: 10, marginTop: 6 }}>On this {computer}</div>
      <div className="lst" aria-label="Tools">
        {ONBOARDING_TOOL_CHECKS.map((id, index) => <ToolRow key={id} id={id} check={checks.find(check => check.id === id)} revealed={shown > index} canManage={user?.role === "admin"} onConnected={onConnected} />)}
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 }}>
        <span className="mono dimmer" style={{ fontSize: 10 }}>Your agents</span>
        {connected.length ? null : <span className="mono dimmer" style={{ fontSize: 10 }}>You need one to start</span>}
      </div>
      <div className="lst" aria-label="Agent subscriptions" aria-busy={loading && state.providers.length === 0}>
        {state.providers.length === 0 ? <Row icon={<span />} name="Agent subscriptions" detail="Checking the subscriptions on this computer" status={<Checking />} />
          : state.providers.map((provider, index) => provider.kind === "local-endpoint"
            ? <EndpointRow key={provider.id} provider={provider} revealed={shown > ONBOARDING_TOOL_CHECKS.length + index} />
            : <ProviderRow key={provider.id} provider={provider} revealed={shown > ONBOARDING_TOOL_CHECKS.length + index} busy={loginPending !== null} onSignIn={() => signIn(provider)} />)}
        {state.providers.length > 0 && user?.role === "admin" ? <AddEndpointRow onAdded={reload} /> : null}
      </div>
      {connected.length && shown > ONBOARDING_TOOL_CHECKS.length ? <div className="row onb-fade-in" role="status" style={{ fontSize: 13.5, color: "#cfcfcf" }}>
        <span className="dot" style={{ background: "#22c55e" }} />Ready to go. {connected.map(provider => provider.label).join(", ")} {connected.length === 1 ? "is" : "are"} connected. Add more agents any time in Settings.
      </div> : null}
      {error || data.error ? <p className="error" role="alert">{error || data.error}</p> : null}
    </div>
  </OnboardingFrame>;
}
