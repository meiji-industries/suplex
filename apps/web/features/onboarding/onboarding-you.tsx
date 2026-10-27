import { RefreshCw } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { AvatarEditor } from "../../components/app/entity-avatar.js";
import type { BillingSummary } from "../../contracts/billing.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { EMAIL_UPDATES_LABEL, EMAIL_UPDATES_NOTE, getAccount, getEmailUpdates, setEmailUpdates } from "../account/lib/account-api.js";
import { useProfileDraft } from "../profiles/lib/profile-draft.js";
import { getBillingSummary } from "../settings/lib/billing-api.js";
import { OnboardingFrame, PrimaryButton } from "./onboarding-frame.js";
import { startTrialIfAvailable, type OnboardingData } from "./onboarding.js";
import type { StepProps } from "./onboarding-wizard.js";

/** "Pro trial · 14 days" while a trial is available or running, else the plan. */
export function planLabel(billing: BillingSummary | undefined, now = Date.now()): string | undefined {
  if (!billing) return undefined;
  if (billing.subscriptionStatus === "trialing" && billing.accessUntil) {
    const days = Math.max(1, Math.ceil((Date.parse(billing.accessUntil) - now) / 86_400_000));
    return `Pro trial · ${days} ${days === 1 ? "day" : "days"}`;
  }
  if (billing.plan === "pro") return "Pro";
  if (billing.plan === "team") return "Team";
  return billing.trialAvailable ? "Pro trial · 14 days" : "Free";
}

function initials(name: string): string {
  return name.trim().replace(/[^\p{L}\p{N}]/gu, "").slice(0, 2).toUpperCase();
}

export function YouStep({ onBack, onNext }: StepProps & { data: OnboardingData }): ReactElement {
  const { currentCompany, user, updateProfile, renameCompany, setCompanyIssueCode, reloadCompanies } = useCompanyContext();
  const [email, setEmail] = useState<string>();
  useEffect(() => { void getAccount().then(result => setEmail(result.account?.email)).catch(() => undefined); }, []);
  const { profile, changeProfile } = useProfileDraft(user, email);
  // A new install names its company "My Company" with no code: start empty so the person names it.
  const fresh = currentCompany?.name === "My Company" && !currentCompany.issueCode;
  const [name, setName] = useState(fresh ? "" : currentCompany?.name ?? "");
  const [code, setCode] = useState(currentCompany?.issueCode ?? "");
  const [codeEdited, setCodeEdited] = useState(Boolean(currentCompany?.issueCode));
  // Unchecked until the person checks it. `undefined` hides the choice: this host has no linked Suplex account.
  const [emailUpdates, setEmailUpdatesChoice] = useState<{ saved: boolean; checked: boolean }>();
  useEffect(() => { void getEmailUpdates().then(result => { if (result.available) setEmailUpdatesChoice({ saved: result.subscribed, checked: result.subscribed }); }).catch(() => undefined); }, []);
  const [billing, setBilling] = useState<BillingSummary>();
  useEffect(() => { void getBillingSummary().then(setBilling).catch(() => undefined); }, []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const companyCode = codeEdited ? code : name.toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^[0-9]+/, "").slice(0, 10);
  const validCode = /^[A-Z][A-Z0-9]{1,9}$/.test(companyCode);
  const ready = Boolean(user && profile.displayName.trim() && name.trim() && validCode);
  const plan = planLabel(billing);

  const save = async (): Promise<void> => {
    if (!ready || saving || !currentCompany) return;
    setSaving(true);
    setError("");
    try {
      const displayName = profile.displayName.trim();
      // The board asks for no username; keep the one on file, else derive one from the name.
      const username = profile.username.trim() || displayName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "me";
      await updateProfile({ ...profile, displayName, username, title: profile.title.trim() });
      if (name.trim() !== currentCompany.name) await renameCompany(currentCompany.id, name.trim());
      if (companyCode !== currentCompany.issueCode) await setCompanyIssueCode(currentCompany.id, companyCode);
      await reloadCompanies();
      if (emailUpdates && emailUpdates.checked !== emailUpdates.saved) {
        const result = await setEmailUpdates(emailUpdates.checked, "onboarding").catch(() => { throw new Error("Suplex could not save your email choice. Retry."); });
        setEmailUpdatesChoice({ saved: result.subscribed, checked: result.subscribed });
      }
      // The preview promised the trial: start it now, before any Free limit can stop a later step.
      await startTrialIfAvailable().catch(() => false);
      onNext();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Suplex could not save your details.");
    } finally {
      setSaving(false);
    }
  };

  return <OnboardingFrame step="you" onBack={onBack} bodyClassName="s-split" action={<PrimaryButton type="submit" form="onb-you" disabled={!ready || saving}>{saving ? "Saving…" : "Continue"}</PrimaryButton>}>
    <form id="onb-you" onSubmit={event => { event.preventDefault(); void save(); }}>
      <div className="row" style={{ flexDirection: "column", alignItems: "stretch", gap: 10 }}>
        <h1 className="h2">Let’s set you up.</h1>
        <p className="sub">Your details, then the first client or business you’re building for.</p>
      </div>
      <div className="mono dimmer" style={{ fontSize: 10 }}>Profile</div>
      <div className="grp">
        <div className="fr"><span className="lbl">Picture</span><div className="row" style={{ justifyContent: "flex-end" }}><button className="icon-btn" type="button" aria-label="Regenerate avatar" title="Regenerate avatar" disabled={saving} onClick={() => changeProfile({ avatarSeed: crypto.randomUUID() })}><RefreshCw aria-hidden="true" /></button>{user ? <AvatarEditor compact kind="user" id={user.id} name={profile.displayName || user.displayName} seed={profile.avatarSeed || profile.username} /> : null}</div></div>
        <div className="fr"><label htmlFor="onb-name">Full name</label><input id="onb-name" className="input" required autoComplete="name" maxLength={120} disabled={saving} value={profile.displayName} onChange={event => changeProfile({ displayName: event.target.value })} /></div>
        <div className="fr"><label htmlFor="onb-email">Email</label><input id="onb-email" className="input" type="email" disabled value={email ?? ""} placeholder="Not available" /></div>
        {emailUpdates ? <div className="fr"><span className="lbl">Updates</span><label className="check"><input type="checkbox" checked={emailUpdates.checked} disabled={saving} onChange={event => setEmailUpdatesChoice({ ...emailUpdates, checked: event.target.checked })} /><span>{EMAIL_UPDATES_LABEL}<span className="dimmer"> {EMAIL_UPDATES_NOTE}</span></span></label></div> : null}
        <div className="fr"><label htmlFor="onb-title">Title</label><input id="onb-title" className="input" autoComplete="organization-title" maxLength={120} placeholder="Founder, lead developer…" disabled={saving} value={profile.title} onChange={event => changeProfile({ title: event.target.value })} /></div>
      </div>
      <div className="mono dimmer" style={{ fontSize: 10 }}>Your first company</div>
      <div className="grp">
        <div className="fr"><label htmlFor="onb-company">Company name</label><input id="onb-company" className="input" required maxLength={80} disabled={saving} value={name} onChange={event => setName(event.target.value)} /></div>
        <div className="fr"><label htmlFor="onb-code">Company code</label><input id="onb-code" className="input" required maxLength={10} pattern="[A-Z][A-Z0-9]{1,9}" aria-invalid={companyCode !== "" && !validCode} disabled={saving} value={companyCode} onChange={event => { setCodeEdited(true); setCode(event.target.value.toUpperCase()); }} /></div>
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: "#a3a3a3" }}>A Company is a client or business. Each one gets its own projects, agents and credentials. Add more any time.</p>
      {error ? <p className="error" role="alert">{error}</p> : null}
    </form>
    <div className="panel preview" aria-label="Preview of your workspace">
      <div className="mono dimmer" style={{ fontSize: 10 }}>Preview · Your workspace</div>
      <div style={{ display: "flex", alignItems: "center", gap: 12, height: 56, padding: "0 14px", borderRadius: 12, background: "#1a1a1a", border: "1px solid #2a2a2a" }}>
        <span style={{ width: 32, height: 32, borderRadius: 8, background: "#d8f65c", color: "#141a00", display: "grid", placeItems: "center", fontSize: 12, fontWeight: 500, flex: "none" }}>{initials(name) || "?"}</span>
        <span style={{ flex: 1, minWidth: 0, fontSize: 17, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: name.trim() ? undefined : "#6b6b6b" }}>{name.trim() || "Your company"}</span>
        {plan ? <span className="pill p-mute onb-fade-in">{plan}</span> : null}
      </div>
      <div aria-hidden="true" style={{ display: "flex", flexDirection: "column", gap: 10, opacity: 0.5 }}>
        <div style={{ height: 40, borderRadius: 999, background: "#d8f65c", opacity: 0.35 }} />
        {[60, 48, 54, 40, 50].map((width, index) => <div key={width} style={{ height: 12, width: `${width}%`, background: "#222", borderRadius: 6, marginTop: index === 0 ? 10 : 0 }} />)}
      </div>
      <div style={{ flex: 1 }} />
      <div className="mono dimmer" style={{ fontSize: 10 }}>Projects, agents and credentials live inside this Company.</div>
    </div>
  </OnboardingFrame>;
}
