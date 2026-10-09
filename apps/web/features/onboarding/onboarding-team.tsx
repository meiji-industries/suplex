import { useState, type ReactElement } from "react";

import type { ProviderSummary } from "../../contracts/providers.js";
import { InternalAgentsManager } from "../admin/internal-agents-manager.js";
import { updateAgentProfile, type AgentProfileChanges } from "../admin/lib/agent-api.js";
import { Fit, OnboardingFrame, PrimaryButton } from "./onboarding-frame.js";
import { connectedProviders, stepComplete, type ApiProfile, type OnboardingData } from "./onboarding.js";
import type { StepProps } from "./onboarding-wizard.js";

const EFFORTS = [["low", "Low"], ["medium", "Medium"], ["high", "High"], ["xhigh", "XHigh"], ["max", "Max"]] as const;
const FACE = <svg width="16" height="16" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 5h2M9 5h2M4 10h6" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" /></svg>;
const CHEVRON = <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#a3a3a3" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>;

type Slot = { id: string; role: "root" | "worker"; label: string; badge: string; description: string; color: string; optional: boolean };
const SLOTS: readonly Slot[] = [
  { id: "profile_native_root", role: "root", label: "Coordinator", badge: "Default", description: "Plans each task and reviews the Worker’s changes.", color: "#6b6bf0", optional: false },
  { id: "profile_native_worker", role: "worker", label: "Worker", badge: "Default", description: "Builds the changes for each task.", color: "#3b82f6", optional: false },
  { id: "profile_native_independent", role: "root", label: "Optional", badge: "Second opinion", description: "Gives a second plan, reviews changes and rates pull requests.", color: "#0ea5b7", optional: true },
];

/** The built-in agent for a slot, else the first live agent that fits it and no earlier slot took. The optional slot takes any role. */
function slotAgents(profiles: readonly ApiProfile[]): (ApiProfile | undefined)[] {
  const live = profiles.filter(profile => profile.archivedAt === null);
  const taken = new Set<string>();
  return SLOTS.map(slot => {
    const agent = live.find(profile => profile.id === slot.id) ?? live.find(profile => (slot.optional || profile.role === slot.role) && !taken.has(profile.id) && !SLOTS.some(other => other.id === profile.id));
    if (agent) taken.add(agent.id);
    return agent;
  });
}

function AgentCard({ slot, agent, providers, left, onChange, busy }: { slot: Slot; agent: ApiProfile; providers: readonly ProviderSummary[]; left: number; onChange: (agent: ApiProfile, body: AgentProfileChanges) => void; busy: boolean }): ReactElement {
  const provider = providers.find(candidate => candidate.id === agent.provider);
  const available = providers.some(candidate => candidate.id === agent.provider && candidate.models.some(model => model.id === agent.model));
  const selectId = `onb-model-${agent.id}`;
  return <div className="ag" style={{ left, ...(slot.optional ? { borderStyle: "dashed", borderColor: "#333" } : {}) }}>
    <div className="row">
      <span className="bot" style={{ width: 30, height: 30, borderRadius: 8, background: slot.color }}>{FACE}</span>
      <span className="nm" style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name}</span>
    </div>
    <div className="row"><span className="dim t13">{slot.label}</span><span className="pill p-mute">{slot.badge}</span></div>
    <div className="ds">{slot.description}</div>
    {slot.role === "root" && !slot.optional ? <div data-anim="review-tick" className="row t12" style={{ color: "#5fd08a" }}><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m5 12 5 5 9-10" /></svg>Review passed</div> : null}
    {slot.role === "worker" ? <div className="row" aria-hidden="true"><div className="track"><i data-anim="build-bar" style={{ width: "72%" }} /></div><span className="mono dimmer" style={{ fontSize: 10 }}>Building</span></div> : null}
    <div className="pl"><label htmlFor={selectId}>Model · {provider?.label ?? agent.provider}</label><span className="pe">Effort</span></div>
    <div className="pick">
      <span className="sel" style={available ? undefined : { borderColor: "#80612a" }}>
        <select id={selectId} className="mdl" disabled={busy} value={available ? `${agent.provider}\n${agent.model}` : ""} onChange={event => { const [nextProvider, model] = event.target.value.split("\n"); if (nextProvider && model) onChange(agent, { provider: nextProvider as ApiProfile["provider"], model }); }}>
          {available ? null : <option value="" disabled>Pick a model</option>}
          {providers.map(candidate => <optgroup key={candidate.id} label={candidate.label}>{candidate.models.map(model => <option key={model.id} value={`${candidate.id}\n${model.id}`}>{model.id}</option>)}</optgroup>)}
        </select>
        {CHEVRON}
      </span>
      <span className="sel eff">
        <select aria-label={`${agent.name} effort`} className="mdl" disabled={busy} value={agent.reasoningLevel} onChange={event => onChange(agent, { reasoningLevel: event.target.value as ApiProfile["reasoningLevel"] })}>
          {EFFORTS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        {CHEVRON}
      </span>
    </div>
  </div>;
}

export function TeamStep({ onBack, onNext, data }: StepProps & { data: OnboardingData }): ReactElement {
  const { state, reload } = data;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const providers = connectedProviders(state.providers);
  const agents = slotAgents(state.profiles);
  const change = (agent: ApiProfile, body: AgentProfileChanges): void => {
    setBusy(true);
    setError("");
    void updateAgentProfile(agent.id, body)
      .then(() => reload())
      .catch(reason => setError(reason instanceof Error ? reason.message : "Suplex could not update the agent."))
      .finally(() => setBusy(false));
  };

  return <OnboardingFrame step="team" onBack={onBack} action={<PrimaryButton disabled={!stepComplete(state, "team")} onClick={onNext}>Continue</PrimaryButton>}>
    {/* Adding an agent opens the same dialog as Settings, so the flow stays here. */}
    <InternalAgentsManager agents={state.profiles} onSaved={reload} renderCards={openNewAgent => <>
      <Fit gap={44}>
        <div className="copy">
          <h1 className="h1">Meet your team.</h1>
          <p className="sub">Your Coordinator plans and reviews. Your Worker builds. Pick any model from the subscriptions you connected, and swap any time.</p>
        </div>
        <div className="m23">
          <div className="team">
            <svg className="abs" style={{ left: 0, top: 0 }} width="1000" height="368" viewBox="0 0 1000 368" aria-hidden="true">
              <path data-anim="handoff-1" d="M156 44 C156 2, 500 2, 500 44" fill="none" stroke="#8b5cf6" strokeWidth="1.5" strokeDasharray="4 4" />
              <path d="M495 36 l5 8 5-8z" fill="#8b5cf6" />
              <path data-anim="handoff-2" d="M500 308 C500 356, 156 356, 156 308" fill="none" stroke="#2dd4bf" strokeWidth="1.5" strokeDasharray="4 4" />
              <path d="M151 316 l5 -8 5 8z" fill="#2dd4bf" />
            </svg>
            <span data-anim="chip-plan" className="abs pill" aria-hidden="true" style={{ left: 286, top: 2, color: "#c8c6ff", background: "#1f1d45", borderColor: "#4a46a8" }}>plan.md</span>
            <span data-anim="chip-diff" className="abs pill" aria-hidden="true" style={{ left: 276, top: 334, color: "#8fe9de", background: "#0f2f2f", borderColor: "#2c7373" }}>diff +48 −6</span>
            {SLOTS.map((slot, index) => {
              const agent = agents[index];
              const left = index * 344;
              return agent ? <AgentCard key={slot.id} slot={slot} agent={agent} providers={providers} left={left} onChange={change} busy={busy} />
                : <div key={slot.id} className="ag" style={{ left, borderStyle: "dashed", borderColor: "#333", alignItems: "center", justifyContent: "center", color: "#8a8a8a", fontSize: 13.5, textAlign: "center" }}>{slot.optional ? "Add an Alt Coordinator for a second opinion." : `Add a ${slot.label} to continue.`}</div>;
            })}
          </div>
        </div>
        <div className="row" style={{ flexDirection: "column", gap: 8, marginTop: -20 }}>
          <button className="back" type="button" style={{ fontSize: 14, color: "#cfcfcf" }} onClick={openNewAgent}>+ Add agent</button>
          {error || data.error ? <p className="error" role="alert">{error || data.error}</p> : null}
        </div>
      </Fit>
    </>} />
  </OnboardingFrame>;
}
