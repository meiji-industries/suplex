import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Field, FieldDescription, FieldGroup, FieldLabel } from ".././components/ui/field.js";
import { Input } from ".././components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from ".././components/ui/select.js";
import { Skeleton } from ".././components/ui/skeleton.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { SettingsLayout } from ".././components/app/settings-layout.js";
import { readJson, withCompany, type ApiUser } from ".././lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { adminDate, type ApiCredential, type ApiInvitation, type ApiModel, type ApiProfile } from "../lib/view-shared.js";

export function AdminView(): ReactElement {
  const { user, companies, currentCompany, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [profileName, setProfileName] = useState("");
  const [profileModel, setProfileModel] = useState("gpt-5.6-sol");
  const [profileReasoning, setProfileReasoning] = useState("medium");
  const [profilePriority, setProfilePriority] = useState("standard");
  const [profileCapacity, setProfileCapacity] = useState("");
  const [capacityLanes, setCapacityLanes] = useState<Array<{ profileId: string; activeCount: number; queuedCount: number }>>([]);
  const [capacityEdits, setCapacityEdits] = useState<Record<string, string>>({});
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [userList, invitationList, credentialList, profileList, modelList, laneList] = await Promise.all([
        readJson<{ users: ApiUser[] }>("/api/admin/users"),
        readJson<{ invitations: ApiInvitation[] }>("/api/admin/invitations"),
        readJson<{ credentials: ApiCredential[] }>("/api/admin/credentials"),
        readJson<{ profiles: ApiProfile[] }>("/api/profiles").catch(() => ({ profiles: [] })),
        readJson<{ models: ApiModel[] }>("/api/admin/models").catch(() => ({ models: [] })),
        readJson<{ lanes: Array<{ profileId: string; activeCount: number; queuedCount: number }> }>("/api/admin/capacity").catch(() => ({ lanes: [] })),
      ]);
      setUsers(userList.users);
      setInvitations(invitationList.invitations);
      setCredentials(credentialList.credentials);
      setProfiles(profileList.profiles);
      setModels(modelList.models);
      setCapacityLanes(laneList.lanes);
      const activeModels = modelList.models.filter((model) => model.status === "active");
      setProfileModel((current) => activeModels.some((model) => model.id === current) ? current : activeModels[0]?.id ?? "");
    } catch (reason) {
      if (reason instanceof Error && reason.message === "Authentication required") window.location.assign("/auth");
      else setError("Unable to load administration");
    }
  }, []);
  useEffect(() => { if (!loading && user?.role === "admin") void reload(); }, [loading, reload, user?.role]);

  const invite = async (): Promise<void> => {
    try {
      const result = await readJson<{ token: string; expiresAt: string }>("/api/admin/invitations", { method: "POST", body: JSON.stringify({ displayName: displayName || "Forge user" }) });
      setInviteToken(result.token);
      setInviteExpiresAt(result.expiresAt);
      setCopied(false);
      setDisplayName("");
      await reload();
    } catch { setError("Unable to invite user"); }
  };
  const copyInvitation = async (): Promise<void> => {
    if (!inviteToken) return;
    try {
      await navigator.clipboard.writeText(inviteToken);
      setCopied(true);
    } catch { setError("Unable to copy invitation"); }
  };
  const createProfile = async (): Promise<void> => {
    try { await readJson("/api/admin/profiles", { method: "POST", body: JSON.stringify({ name: profileName, model: profileModel, reasoningLevel: profileReasoning, servicePriority: profilePriority, capacity: profileCapacity.trim() === "" ? null : Number(profileCapacity) }) }); setProfileName(""); await reload(); } catch { setError("Unable to create profile"); }
  };
  const updateCapacity = async (profile: ApiProfile): Promise<void> => {
    const raw = capacityEdits[profile.id] ?? (profile.capacity === null ? "" : String(profile.capacity));
    try { await readJson(`/api/admin/profiles/${encodeURIComponent(profile.id)}/capacity`, { method: "PATCH", body: JSON.stringify({ capacity: raw.trim() === "" ? null : Number(raw) }) }); await reload(); } catch { setError("Unable to update capacity"); }
  };
  const createModel = async (): Promise<void> => {
    try {
      await readJson("/api/admin/models", { method: "POST", body: JSON.stringify({ id: modelId, displayName: modelName, description: "", sortOrder: 100 }) });
      setModelId(""); setModelName(""); await reload();
    } catch { setError("Unable to add model"); }
  };
  const toggleModel = async (model: ApiModel): Promise<void> => {
    try { await readJson(`/api/admin/models/${encodeURIComponent(model.id)}`, { method: "PATCH", body: JSON.stringify({ status: model.status === "active" ? "retired" : "active" }) }); await reload(); }
    catch { setError("Unable to update model"); }
  };
  const changeMembership = async (companyId: string, targetUserId: string, add: boolean): Promise<void> => {
    const action = `membership:${companyId}:${targetUserId}`;
    if (!add && pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      const init: RequestInit = { method: add ? "POST" : "DELETE" };
      if (add) init.body = JSON.stringify({ userId: targetUserId });
      await readJson(add ? `/api/admin/companies/${companyId}/members` : `/api/admin/companies/${companyId}/members/${targetUserId}`, init);
      await reload();
      setPendingAction("");
    } catch { setError("Unable to change membership"); }
  };
  const revokeUser = async (candidate: ApiUser): Promise<void> => {
    const action = `user:${candidate.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(`/api/admin/users/${candidate.id}/revoke`, { method: "POST", body: "{}" });
      setPendingAction("");
      await reload();
    } catch { setError("Unable to revoke user"); }
  };
  const revokeCredential = async (credential: ApiCredential): Promise<void> => {
    const action = `credential:${credential.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(`/api/admin/credentials/${credential.id}/revoke`, { method: "POST", body: "{}" });
      setPendingAction("");
      await reload();
    } catch { setError("Unable to revoke passkey"); }
  };
  const signOut = async (): Promise<void> => { await readJson("/api/auth/sign-out", { method: "POST", body: "{}" }); window.localStorage.removeItem("forge.activeCompanyId"); window.location.assign("/auth"); };
  const isProfiles = window.location.pathname.endsWith("/profiles");
  const activeHref = withCompany(window.location.pathname, currentCompany?.id);
  const backHref = withCompany("/projects", currentCompany?.id);

  if (loading) {
    return (
      <SettingsLayout title={isProfiles ? "Profiles" : "Users"} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading administration"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div>
      </SettingsLayout>
    );
  }
  if (user?.role !== "admin") {
    return (
      <SettingsLayout title={isProfiles ? "Profiles" : "Users"} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="p-4 text-xs text-muted-foreground">Administration is unavailable.</div>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout title={isProfiles ? "Profiles" : "Users"} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
      <div>{!isProfiles ? (<>
        <section className="flex flex-wrap items-center justify-between gap-3 px-3 py-3 sm:px-4"><span className="text-xs text-muted-foreground">{user?.displayName ?? ""} · {user?.role ?? ""}</span><Button variant="ghost" size="sm" onClick={() => void signOut()}>Sign out</Button></section>
        <section className="grid gap-px sm:grid-cols-2">
          <div className="bg-background p-4">
            <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Users</span><span className="text-[11px] text-muted-foreground">{users.length}</span></div>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="invite-display-name">Display name</FieldLabel>
                <Input id="invite-display-name" placeholder="Forge user" value={displayName} onChange={(event) => setDisplayName(event.target.value)} />
              </Field>
              <Button size="sm" onClick={() => void invite()}>Invite</Button>
            </FieldGroup>
            {inviteToken ? <div className="bg-muted/30 p-2"><div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground"><span>Invitation · shown once</span><span>Expires {adminDate(inviteExpiresAt)}</span></div><code className="block break-all text-[11px]">{inviteToken}</code><Button className="mt-2" variant="outline" size="sm" onClick={() => void copyInvitation()}>{copied ? "Copied" : "Copy invitation"}</Button></div> : null}
            <div className="mt-3">{users.map((candidate) => <div className="flex min-h-8 items-center justify-between gap-2 text-xs" key={candidate.id}><span className="min-w-0 truncate">{candidate.displayName} <span className="text-muted-foreground">{candidate.status}</span></span>{candidate.role !== "admin" && candidate.status === "active" ? <span className="flex shrink-0 items-center gap-1">{pendingAction === `user:${candidate.id}` ? <span className="text-[11px] text-muted-foreground">Confirm</span> : null}<Button variant="ghost" size="sm" onClick={() => void revokeUser(candidate)}>{pendingAction === `user:${candidate.id}` ? "Confirm revoke" : "Revoke"}</Button>{pendingAction === `user:${candidate.id}` ? <Button variant="ghost" size="sm" onClick={() => setPendingAction("")}>Cancel</Button> : null}</span> : null}</div>)}</div>
          </div>
          <div className="bg-background p-4">
            <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Companies</span><span className="text-[11px] text-muted-foreground">{companies.length}</span></div>
            <div>{companies.map((company) => <div className="py-2 text-xs" key={company.id}><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 truncate"><span>{company.name}</span> <span className="text-muted-foreground">{company.status}</span></span><a className="flex h-7 items-center px-2 text-xs text-muted-foreground hover:text-foreground" href={withCompany(`/companies/${encodeURIComponent(company.id)}/settings`, company.id)}>Settings</a></div><div className="flex flex-wrap gap-1.5">{users.filter((candidate) => candidate.role === "member" && candidate.status === "active").map((candidate) => { const assigned = candidate.companyIds.includes(company.id); const action = `membership:${company.id}:${candidate.id}`; return <span className="flex items-center gap-1" key={candidate.id}><Button variant={assigned ? "secondary" : "outline"} size="sm" onClick={() => void changeMembership(company.id, candidate.id, !assigned)}>{assigned ? "− " : "+ "}{candidate.displayName}</Button>{pendingAction === action ? <><span className="text-[11px] text-muted-foreground">Confirm remove</span><Button variant="ghost" size="sm" onClick={() => setPendingAction("")}>Cancel</Button></> : null}</span>; })}</div></div>)}</div>
          </div>
        </section></>) : null}
        {!isProfiles ? <section className="grid gap-px sm:grid-cols-2">
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Invitations</span><span className="text-[11px] text-muted-foreground">{invitations.length}</span></div><div>{invitations.map((invitation) => <div className="py-2 text-xs" key={invitation.id}><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate">{invitation.displayName}</span><span className="shrink-0 text-muted-foreground">{invitation.status}</span></div><div className="mt-1 text-[11px] text-muted-foreground">{invitation.kind} · expires {adminDate(invitation.expiresAt)}</div></div>)}</div></div>
          <div className="bg-background p-4"><div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Passkeys</span><span className="text-[11px] text-muted-foreground">{credentials.filter((credential) => !credential.revokedAt).length} active</span></div><div>{credentials.map((credential) => { const candidate = users.find((entry) => entry.id === credential.userId); const action = `credential:${credential.id}`; return <div className="flex min-h-8 items-center justify-between gap-2 text-xs" key={credential.id}><span className="min-w-0 truncate">{candidate?.displayName ?? "User"}<span className="ml-2 text-muted-foreground">{credential.revokedAt ? "revoked" : `created ${adminDate(credential.createdAt)}`}</span></span>{!credential.revokedAt && credential.userId !== user.id ? <span className="flex shrink-0 items-center gap-1">{pendingAction === action ? <span className="text-[11px] text-muted-foreground">Confirm</span> : null}<Button variant="ghost" size="sm" onClick={() => void revokeCredential(credential)}>{pendingAction === action ? "Confirm revoke" : "Revoke"}</Button>{pendingAction === action ? <Button variant="ghost" size="sm" onClick={() => setPendingAction("")}>Cancel</Button> : null}</span> : null}</div>; })}</div></div>
        </section> : null}
        {isProfiles ? (<>
          <section className="bg-background p-4">
            <div className="mb-3 flex items-center justify-between"><span className="text-xs font-semibold">Codex profiles</span><span className="text-[11px] text-muted-foreground">{profiles.length} configured</span></div>
            <FieldGroup>
              <Field><FieldLabel htmlFor="profile-name">Profile name</FieldLabel><Input id="profile-name" value={profileName} onChange={(event) => setProfileName(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="profile-model">Model</FieldLabel><Select value={profileModel || null} onValueChange={(value) => setProfileModel(value ?? "")}><SelectTrigger id="profile-model"><SelectValue placeholder="Select a model" /></SelectTrigger><SelectContent>{models.filter((model) => model.status === "active").map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName} · {model.id}</SelectItem>)}</SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="profile-reasoning">Reasoning level</FieldLabel><Select value={profileReasoning} onValueChange={(value) => setProfileReasoning(value ?? "medium")}><SelectTrigger id="profile-reasoning"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="profile-priority">Service priority</FieldLabel><Select value={profilePriority} onValueChange={(value) => setProfilePriority(value ?? "standard")}><SelectTrigger id="profile-priority"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="standard">Standard</SelectItem><SelectItem value="priority">Priority</SelectItem></SelectContent></Select></Field>
              <Field><FieldLabel htmlFor="profile-capacity">Capacity override</FieldLabel><Input id="profile-capacity" inputMode="numeric" placeholder="Default" value={profileCapacity} onChange={(event) => setProfileCapacity(event.target.value)} /><FieldDescription>Blank inherits the host default.</FieldDescription></Field>
              <Button size="sm" onClick={() => void createProfile()} disabled={!profileName.trim() || !profileModel}>Create profile</Button>
            </FieldGroup>
            <div className="text-xs">{profiles.map((profile) => { const lane = capacityLanes.find((item) => item.profileId === profile.id); const edit = capacityEdits[profile.id] ?? (profile.capacity === null ? "" : String(profile.capacity)); return <div className="flex min-h-9 flex-wrap items-center justify-between gap-2" key={profile.id}><span className="font-medium">{profile.name}</span><span className="flex items-center gap-2 text-[11px] text-muted-foreground"><span>{profile.capacity === null ? `Default · ${profile.effectiveCapacity} slots effective` : `Override · ${profile.capacity} slots`} · {lane?.activeCount ?? 0} active / {lane?.queuedCount ?? 0} queued</span><Input aria-label={`${profile.name} capacity`} inputMode="numeric" placeholder="Default" value={edit} onChange={(event) => setCapacityEdits((current) => ({ ...current, [profile.id]: event.target.value }))} /><Button size="sm" variant="ghost" onClick={() => void updateCapacity(profile)}>Save</Button></span></div>; })}</div>
          </section>
          <section className="bg-background p-4">
            <div className="mb-1 flex items-center justify-between"><span className="text-xs font-semibold">Model catalog</span><span className="text-[11px] text-muted-foreground">Database backed</span></div>
            <p className="mb-3 text-[11px] text-muted-foreground">Models available when creating Codex profiles. Retiring a model preserves existing profiles.</p>
            <FieldGroup>
              <Field><FieldLabel htmlFor="model-id">Model ID</FieldLabel><Input id="model-id" placeholder="gpt-5-codex" value={modelId} onChange={(event) => setModelId(event.target.value)} /></Field>
              <Field><FieldLabel htmlFor="model-display-name">Display name</FieldLabel><Input id="model-display-name" value={modelName} onChange={(event) => setModelName(event.target.value)} /></Field>
              <Button variant="outline" size="sm" onClick={() => void createModel()} disabled={!modelId.trim() || !modelName.trim()}>Add model</Button>
            </FieldGroup>
            <div>{models.map((model) => <div className="flex min-h-10 items-center justify-between gap-3 text-xs" key={model.id}><div className="min-w-0"><div className="font-medium">{model.displayName} <code className="ml-1 text-[11px] font-normal text-muted-foreground">{model.id}</code></div><div className="truncate text-[11px] text-muted-foreground">{model.description || "No description"}</div></div><Button variant="ghost" size="sm" onClick={() => void toggleModel(model)}>{model.status === "active" ? "Retire" : "Restore"}</Button></div>)}</div>
          </section>
        </>) : null}
        {error ? <div className="px-4 py-3 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      </div>
    </SettingsLayout>
  );
}
