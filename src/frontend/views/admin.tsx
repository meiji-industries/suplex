import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from ".././components/ui/dialog.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from ".././components/ui/dropdown-menu.js";
import { Field, FieldDescription, FieldGroup, FieldLabel } from ".././components/ui/field.js";
import { Input } from ".././components/ui/input.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from ".././components/ui/select.js";
import { Skeleton } from ".././components/ui/skeleton.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { SettingsLayout } from ".././components/app/settings-layout.js";
import { SettingsDataTable, SettingsTableCell, SettingsTableEmpty, SettingsTableGroup, SettingsTableRow, SettingsToolbar, SettingsToolbarAction, type SettingsTableColumn } from ".././components/app/settings-table.js";
import { ProfileAvatar } from ".././components/app/profile-avatar.js";
import { readJson, withCompany, type ApiUser } from ".././lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { adminDate, type ApiCredential, type ApiInvitation, type ApiModel, type ApiProfile } from "../lib/view-shared.js";
import { Ellipsis, Pencil, Save } from "lucide-react";

const USER_COLUMNS: SettingsTableColumn[] = [
  { key: "indent", width: 60 },
  { key: "name", label: "Name ↓", width: 177 },
  { key: "username", label: "Username", width: 118 },
  { key: "role", label: "Role", width: 140 },
  { key: "companies", label: "Companies", width: 82 },
  { key: "passkeys", label: "Passkeys", width: 82 },
  { key: "status", label: "Status", width: 82 },
  { key: "menu", width: 28 },
  { key: "end", width: 32 },
];

const PROFILE_COLUMNS: SettingsTableColumn[] = [
  { key: "indent", width: 60 },
  { key: "name", label: "Name ↓", width: 240 },
  { key: "model", label: "Model", width: 200 },
  { key: "reasoning", label: "Reasoning", width: 75 },
  { key: "priority", label: "Priority", width: 102 },
  { key: "capacity", label: "Capacity", width: 102 },
  { key: "save", width: 28 },
  { key: "end", width: 32 },
];
const AGENT_COLUMNS: SettingsTableColumn[] = [
  { key: "indent", width: 60 },
  { key: "name", label: "Name ↓", width: 240 },
  { key: "role", label: "Role", width: 140 },
  { key: "profile", label: "Profile", width: 220 },
  { key: "end", width: 32 },
];

const USER_GROUPS: Array<{ label: string; status: ApiUser["status"] }> = [
  { label: "Active", status: "active" },
  { label: "Pending", status: "pending" },
  { label: "Revoked", status: "revoked" },
];

export function AdminView(): ReactElement {
  const { user, companies, currentCompany, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [profiles, setProfiles] = useState<ApiProfile[]>([]);
  const [agents, setAgents] = useState<import("../lib/view-shared.js").ApiAgent[]>([]);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [profileName, setProfileName] = useState("");
  const [profileModel, setProfileModel] = useState("gpt-5.6-sol");
  const [profileReasoning, setProfileReasoning] = useState("medium");
  const [profilePriority, setProfilePriority] = useState("standard");
  const [profileCapacity, setProfileCapacity] = useState("");
  const [profileOpen, setProfileOpen] = useState(false);
  const [editingProfileId, setEditingProfileId] = useState<string | null>(null);
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState<"analyst" | "implementer" | "reviewer">("analyst");
  const [agentAvatarSeed, setAgentAvatarSeed] = useState("");
  const [agentProfileId, setAgentProfileId] = useState("");
  const [agentOpen, setAgentOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [capacityLanes, setCapacityLanes] = useState<Array<{ profileId: string; activeCount: number; queuedCount: number }>>([]);
  const [capacityEdits, setCapacityEdits] = useState<Record<string, string>>({});
  const [modelId, setModelId] = useState("");
  const [modelName, setModelName] = useState("");
  const [modelOpen, setModelOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [userList, invitationList, credentialList, profileList, agentList, modelList, laneList] = await Promise.all([
        readJson<{ users: ApiUser[] }>("/api/admin/users"),
        readJson<{ invitations: ApiInvitation[] }>("/api/admin/invitations"),
        readJson<{ credentials: ApiCredential[] }>("/api/admin/credentials"),
        readJson<{ profiles: ApiProfile[] }>("/api/profiles").catch(() => ({ profiles: [] })),
        readJson<{ agents: import("../lib/view-shared.js").ApiAgent[] }>("/api/agents").catch(() => ({ agents: [] })),
        readJson<{ models: ApiModel[] }>("/api/admin/models").catch(() => ({ models: [] })),
        readJson<{ lanes: Array<{ profileId: string; activeCount: number; queuedCount: number }> }>("/api/admin/capacity").catch(() => ({ lanes: [] })),
      ]);
      setUsers(userList.users);
      setInvitations(invitationList.invitations);
      setCredentials(credentialList.credentials);
      setProfiles(profileList.profiles);
      setAgents(agentList.agents);
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
  const openNewProfile = (): void => {
    setEditingProfileId(null); setProfileName(""); setProfileReasoning("medium"); setProfilePriority("standard"); setProfileCapacity(""); setProfileOpen(true);
  };
  const openEditProfile = (profile: ApiProfile): void => {
    setEditingProfileId(profile.id); setProfileName(profile.name); setProfileModel(profile.model); setProfileReasoning(profile.reasoningLevel); setProfilePriority(profile.servicePriority); setProfileCapacity(profile.capacity === null ? "" : String(profile.capacity)); setProfileOpen(true);
  };
  const saveProfile = async (): Promise<void> => {
    const editing = editingProfileId !== null;
    try {
      await readJson(editing ? `/api/admin/profiles/${encodeURIComponent(editingProfileId)}` : "/api/admin/profiles", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ name: profileName, model: profileModel, reasoningLevel: profileReasoning, servicePriority: profilePriority, capacity: profileCapacity.trim() === "" ? null : Number(profileCapacity) }) });
      setProfileName(""); setProfileCapacity(""); setEditingProfileId(null); setProfileOpen(false); await reload();
    } catch { setError(editing ? "Unable to update profile" : "Unable to create profile"); }
  };
  const openNewAgent = (): void => { setEditingAgentId(null); setAgentName(""); setAgentRole("analyst"); setAgentAvatarSeed(crypto.randomUUID().replaceAll("-", "")); setAgentProfileId(profiles[0]?.id ?? ""); setAgentOpen(true); };
  const openEditAgent = (agent: import("../lib/view-shared.js").ApiAgent): void => { setEditingAgentId(agent.id); setAgentName(agent.name); setAgentRole(agent.role); setAgentAvatarSeed(agent.avatarSeed); setAgentProfileId(agent.profileId); setAgentOpen(true); };
  const saveAgent = async (): Promise<void> => {
    const editing = editingAgentId !== null;
    try {
      await readJson(editing ? `/api/admin/agents/${encodeURIComponent(editingAgentId)}` : "/api/admin/agents", { method: editing ? "PATCH" : "POST", body: JSON.stringify({ name: agentName, role: agentRole, avatarSeed: agentAvatarSeed, profileId: agentProfileId }) });
      setAgentOpen(false); setEditingAgentId(null); await reload();
    } catch { setError(editing ? "Unable to update agent" : "Unable to create agent"); }
  };
  const updateCapacity = async (profile: ApiProfile): Promise<void> => {
    const raw = capacityEdits[profile.id] ?? (profile.capacity === null ? "" : String(profile.capacity));
    try { await readJson(`/api/admin/profiles/${encodeURIComponent(profile.id)}/capacity`, { method: "PATCH", body: JSON.stringify({ capacity: raw.trim() === "" ? null : Number(raw) }) }); await reload(); } catch { setError("Unable to update capacity"); }
  };
  const createModel = async (): Promise<void> => {
    try {
      await readJson("/api/admin/models", { method: "POST", body: JSON.stringify({ id: modelId, displayName: modelName, description: "", sortOrder: 100 }) });
      setModelId(""); setModelName(""); setModelOpen(false); await reload();
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
  const isProfiles = window.location.pathname.endsWith("/profiles");
  const isAgents = window.location.pathname.endsWith("/agents");
  const isModels = window.location.pathname.endsWith("/models");
  const isCompanies = window.location.pathname.endsWith("/companies");
  const isInvitations = window.location.pathname.endsWith("/invitations");
  const isPasskeys = window.location.pathname.endsWith("/passkeys");
  const viewTitle = isProfiles ? "Profiles" : isAgents ? "Agents" : isModels ? "Models" : isCompanies ? "Companies" : isInvitations ? "Invitations" : isPasskeys ? "Passkeys" : "Users";
  const activeHref = withCompany(window.location.pathname, currentCompany?.id);
  const backHref = withCompany("/projects", currentCompany?.id);

  if (loading) {
    return (
      <SettingsLayout title={viewTitle} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="space-y-2 p-4" aria-busy="true" aria-label="Loading administration"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div>
      </SettingsLayout>
    );
  }
  if (user?.role !== "admin") {
    return (
      <SettingsLayout title={viewTitle} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
        <div className="p-4 text-xs text-muted-foreground">Administration is unavailable.</div>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout title={viewTitle} companyId={currentCompany?.id ?? ""} backHref={backHref} activeHref={activeHref} contentClassName="">
      <div>{!isProfiles && !isAgents && !isModels && !isCompanies && !isInvitations && !isPasskeys ? (<>
        <section>
          <SettingsToolbar searchLabel="Search users" searchPlaceholder="Search by name or username" filterLabel="All" actions={<SettingsToolbarAction disabled>Export CSV</SettingsToolbarAction>} />
          <SettingsDataTable label="Users" columns={USER_COLUMNS} className="mt-5">
            {USER_GROUPS.map((group) => { const groupUsers = users.filter((candidate) => candidate.status === group.status); if (groupUsers.length === 0) return null; return <SettingsTableGroup columnCount={USER_COLUMNS.length} count={groupUsers.length} key={group.status} label={group.label}>{groupUsers.map((candidate) => { const action = `user:${candidate.id}`; const passkeyCount = credentials.filter((credential) => credential.userId === candidate.id && !credential.revokedAt).length; return <SettingsTableRow key={candidate.id} size="member"><SettingsTableCell className="p-0" /><SettingsTableCell><span className="flex min-w-0 items-center gap-2"><ProfileAvatar name={candidate.displayName} seed={candidate.avatarSeed} collection="pixel-art-neutral" /><span className="truncate">{candidate.displayName}</span></span></SettingsTableCell><SettingsTableCell className="truncate text-muted-foreground">@{candidate.username}</SettingsTableCell><SettingsTableCell><span className="rounded bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary">{candidate.role}</span></SettingsTableCell><SettingsTableCell className="text-muted-foreground">{candidate.companyIds.length}</SettingsTableCell><SettingsTableCell className="text-muted-foreground">{passkeyCount}</SettingsTableCell><SettingsTableCell><span className="flex items-center gap-1.5 text-muted-foreground"><span className={candidate.status === "active" ? "size-1.5 rounded-full bg-emerald-500" : candidate.status === "pending" ? "size-1.5 rounded-full bg-amber-500" : "size-1.5 rounded-full bg-muted-foreground"} />{candidate.status}</span></SettingsTableCell><SettingsTableCell className="p-0">{candidate.role !== "admin" && candidate.status === "active" ? <DropdownMenu><DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label={`${candidate.displayName} actions`} title={`${candidate.displayName} actions`} />}><Ellipsis /></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem variant="destructive" onClick={() => void revokeUser(candidate)}>{pendingAction === action ? "Confirm revoke" : "Revoke user"}</DropdownMenuItem>{pendingAction === action ? <DropdownMenuItem onClick={() => setPendingAction("")}>Cancel</DropdownMenuItem> : null}</DropdownMenuContent></DropdownMenu> : null}</SettingsTableCell><SettingsTableCell className="p-0" /></SettingsTableRow>; })}</SettingsTableGroup>; })}
            {users.length === 0 ? <SettingsTableEmpty columnCount={USER_COLUMNS.length}>No users configured.</SettingsTableEmpty> : null}
          </SettingsDataTable>
        </section>
        </>) : null}
        {isProfiles ? (<>
          <section>
            <SettingsToolbar searchLabel="Filter profiles by name" searchPlaceholder="Filter by name…" filterLabel="All models" searchWidth="compact" actions={<SettingsToolbarAction tone="primary" onClick={openNewProfile}>New profile</SettingsToolbarAction>} />
            <SettingsDataTable label="Profiles" columns={PROFILE_COLUMNS} className="mt-10">
              <tbody>{profiles.map((profile) => { const lane = capacityLanes.find((item) => item.profileId === profile.id); const edit = capacityEdits[profile.id] ?? (profile.capacity === null ? "" : String(profile.capacity)); const saved = profile.capacity === null ? "" : String(profile.capacity); const formId = `capacity-${profile.id}`; return <SettingsTableRow aria-label={`Edit ${profile.name}`} key={profile.id} onClick={(event) => { if (!(event.target as HTMLElement).closest("button, input")) openEditProfile(profile); }} onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openEditProfile(profile); } }} tabIndex={0}><SettingsTableCell className="p-0" /><SettingsTableCell><span className="flex min-w-0 items-center gap-3"><span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-semibold">{profile.name[0]?.toUpperCase()}</span><span className="min-w-0"><span className="block truncate">{profile.name}</span><span className="block truncate text-[10px] leading-3 text-muted-foreground">{profile.capacity === null ? `Default · ${profile.effectiveCapacity} slots effective` : `Override · ${profile.capacity} slots`} · {lane?.activeCount ?? 0} active / {lane?.queuedCount ?? 0} queued</span></span></span></SettingsTableCell><SettingsTableCell className="truncate">{profile.model}</SettingsTableCell><SettingsTableCell className="truncate text-muted-foreground">{profile.reasoningLevel}</SettingsTableCell><SettingsTableCell className="truncate text-muted-foreground">{profile.servicePriority}</SettingsTableCell><SettingsTableCell><form id={formId} onSubmit={(event) => { event.preventDefault(); void updateCapacity(profile); }}><input aria-label={`${profile.name} capacity`} className="h-7 w-[86px] rounded-md border-[0.5px] border-border bg-transparent px-2 text-[12px] outline-none focus:border-ring" inputMode="numeric" placeholder="Default" value={edit} onChange={(event) => setCapacityEdits((current) => ({ ...current, [profile.id]: event.target.value }))} /></form></SettingsTableCell><SettingsTableCell className="p-0"><button aria-label="Save" className="flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-black/5 hover:text-foreground disabled:opacity-30" disabled={edit === saved} form={formId} title="Save capacity" type="submit"><Save className="size-3.5" /></button></SettingsTableCell><SettingsTableCell className="p-0"><Button variant="ghost" size="icon-xs" aria-label={`Edit ${profile.name}`} title={`Edit ${profile.name}`} onClick={() => openEditProfile(profile)}><Pencil /></Button></SettingsTableCell></SettingsTableRow>; })}</tbody>
              {profiles.length === 0 ? <SettingsTableEmpty columnCount={PROFILE_COLUMNS.length}>No profiles configured.</SettingsTableEmpty> : null}
            </SettingsDataTable>
          </section>
          <Dialog open={profileOpen} onOpenChange={(open) => { setProfileOpen(open); if (!open) setEditingProfileId(null); }}><DialogContent><DialogHeader><DialogTitle>{editingProfileId ? "Edit profile" : "New profile"}</DialogTitle><DialogDescription>Configure a reusable Codex execution profile.</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); void saveProfile(); }}><FieldGroup><Field><FieldLabel htmlFor="profile-name">Profile name</FieldLabel><Input id="profile-name" autoFocus value={profileName} onChange={(event) => setProfileName(event.target.value)} /></Field><Field><FieldLabel htmlFor="profile-model">Model</FieldLabel><Select value={profileModel || null} onValueChange={(value) => setProfileModel(value ?? "")}><SelectTrigger id="profile-model"><SelectValue placeholder="Select a model" /></SelectTrigger><SelectContent>{models.filter((model) => model.status === "active").map((model) => <SelectItem key={model.id} value={model.id}>{model.displayName} · {model.id}</SelectItem>)}</SelectContent></Select></Field><Field><FieldLabel htmlFor="profile-reasoning">Reasoning level</FieldLabel><Select value={profileReasoning} onValueChange={(value) => setProfileReasoning(value ?? "medium")}><SelectTrigger id="profile-reasoning"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="low">Low</SelectItem><SelectItem value="medium">Medium</SelectItem><SelectItem value="high">High</SelectItem></SelectContent></Select></Field><Field><FieldLabel htmlFor="profile-priority">Service priority</FieldLabel><Select value={profilePriority} onValueChange={(value) => setProfilePriority(value ?? "standard")}><SelectTrigger id="profile-priority"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="standard">Standard</SelectItem><SelectItem value="priority">Priority</SelectItem></SelectContent></Select></Field><Field><FieldLabel htmlFor="profile-capacity">Capacity override</FieldLabel><Input id="profile-capacity" inputMode="numeric" placeholder="Default" value={profileCapacity} onChange={(event) => setProfileCapacity(event.target.value)} /><FieldDescription>Blank inherits the host default.</FieldDescription></Field><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm" disabled={!profileName.trim() || !profileModel}>{editingProfileId ? "Save changes" : "Create profile"}</Button></DialogFooter></FieldGroup></form></DialogContent></Dialog>
        </>) : null}
        {isAgents ? (<>
          <section>
            <SettingsToolbar searchLabel="Filter agents by name" searchPlaceholder="Filter by name…" filterLabel="All roles" searchWidth="compact" actions={<SettingsToolbarAction tone="primary" onClick={openNewAgent}>New agent</SettingsToolbarAction>} />
            <SettingsDataTable label="Agents" columns={AGENT_COLUMNS} className="mt-10"><tbody>{agents.map((agent) => <SettingsTableRow aria-label={`Edit ${agent.name}`} key={agent.id} onClick={() => openEditAgent(agent)} tabIndex={0}><SettingsTableCell className="p-0" /><SettingsTableCell><span className="flex items-center gap-3"><ProfileAvatar name={agent.name} seed={agent.avatarSeed} /><span>{agent.name}</span></span></SettingsTableCell><SettingsTableCell className="capitalize">{agent.role}</SettingsTableCell><SettingsTableCell className="truncate">{profiles.find((profile) => profile.id === agent.profileId)?.name ?? agent.profileId}</SettingsTableCell><SettingsTableCell className="p-0"><Button variant="ghost" size="icon-xs" aria-label={`Edit ${agent.name}`} title={`Edit ${agent.name}`} onClick={() => openEditAgent(agent)}><Pencil /></Button></SettingsTableCell></SettingsTableRow>)}</tbody>{agents.length === 0 ? <SettingsTableEmpty columnCount={AGENT_COLUMNS.length}>No agents configured.</SettingsTableEmpty> : null}</SettingsDataTable>
          </section>
          <Dialog open={agentOpen} onOpenChange={(open) => { setAgentOpen(open); if (!open) setEditingAgentId(null); }}><DialogContent><DialogHeader><DialogTitle>{editingAgentId ? "Edit agent" : "New agent"}</DialogTitle><DialogDescription>Assign a stable role identity to an execution profile.</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); void saveAgent(); }}><FieldGroup><Field><FieldLabel>Avatar</FieldLabel><span className="flex items-center gap-3"><ProfileAvatar name={agentName || "Agent"} seed={agentAvatarSeed} /><Button type="button" variant="outline" size="sm" onClick={() => setAgentAvatarSeed(crypto.randomUUID().replaceAll("-", ""))}>Randomize</Button></span></Field><Field><FieldLabel htmlFor="agent-name">Agent name</FieldLabel><Input id="agent-name" autoFocus value={agentName} onChange={(event) => setAgentName(event.target.value)} /></Field><Field><FieldLabel htmlFor="agent-role">Role</FieldLabel><Select value={agentRole} onValueChange={(value) => setAgentRole((value ?? "analyst") as typeof agentRole)}><SelectTrigger id="agent-role"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="analyst">Analyst</SelectItem><SelectItem value="implementer">Implementer</SelectItem><SelectItem value="reviewer">Reviewer</SelectItem></SelectContent></Select></Field><Field><FieldLabel htmlFor="agent-profile">Execution profile</FieldLabel><Select value={agentProfileId || null} onValueChange={(value) => setAgentProfileId(value ?? "")}><SelectTrigger id="agent-profile"><SelectValue placeholder="Select a profile" /></SelectTrigger><SelectContent>{profiles.map((profile) => <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>)}</SelectContent></Select></Field><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm" disabled={!agentName.trim() || !agentProfileId}>{editingAgentId ? "Save changes" : "Create agent"}</Button></DialogFooter></FieldGroup></form></DialogContent></Dialog>
        </>) : null}
        {isCompanies ? (<>
          <section><div className="flex h-8 items-center justify-between gap-3"><div className="flex items-baseline gap-2"><h2 className="text-base font-medium">Companies</h2><span className="text-[11px] text-muted-foreground">{companies.length}</span></div></div><div className="mt-5">{companies.map((company) => <div className="rounded-lg px-1 py-2.5 text-xs hover:bg-black/[0.025]" key={company.id}><div className="mb-2 flex flex-wrap items-center justify-between gap-2"><span className="min-w-0 truncate"><span className="font-medium">{company.name}</span> <span className="text-muted-foreground">· {company.status}</span></span><a className="flex h-7 items-center px-2 text-xs text-muted-foreground hover:text-foreground" href={withCompany(`/companies/${encodeURIComponent(company.id)}/settings`, company.id)}>Settings</a></div><div className="flex flex-wrap gap-1.5">{users.filter((candidate) => candidate.role === "member" && candidate.status === "active").map((candidate) => { const assigned = candidate.companyIds.includes(company.id); const action = `membership:${company.id}:${candidate.id}`; return <span className="flex items-center gap-1" key={candidate.id}><Button variant={assigned ? "secondary" : "outline"} size="sm" onClick={() => void changeMembership(company.id, candidate.id, !assigned)}>{assigned ? "− " : "+ "}{candidate.displayName}</Button>{pendingAction === action ? <><span className="text-[11px] text-muted-foreground">Confirm remove</span><Button variant="outline" size="sm" onClick={() => setPendingAction("")}>Cancel</Button></> : null}</span>; })}</div></div>)}</div></section>
        </>) : null}
        {isInvitations ? (<>
          <section>
            <SettingsToolbar searchLabel="Search invitations" searchPlaceholder="Search invitations…" filterLabel="All" searchWidth="compact" actions={<SettingsToolbarAction tone="primary" onClick={() => { setInviteToken(""); setCopied(false); setInviteOpen(true); }}>Invite</SettingsToolbarAction>} />
            <div className="mt-10"><div className="flex h-8 items-center justify-between"><div className="flex items-baseline gap-2"><h2 className="text-base font-medium">Invitations</h2><span className="text-[11px] text-muted-foreground">{invitations.length}</span></div></div><div className="mt-5">{invitations.map((invitation) => <div className="rounded-lg px-1 py-2.5 text-xs hover:bg-black/[0.025]" key={invitation.id}><div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate font-medium">{invitation.displayName}</span><span className="shrink-0 text-muted-foreground">{invitation.status}</span></div><div className="mt-1 text-[11px] text-muted-foreground">{invitation.kind} · expires {adminDate(invitation.expiresAt)}</div></div>)}</div></div>
          </section>
          <Dialog open={inviteOpen} onOpenChange={(open) => { setInviteOpen(open); if (!open) { setInviteToken(""); setCopied(false); } }}><DialogContent><DialogHeader><DialogTitle>{inviteToken ? "Invitation ready" : "Invite user"}</DialogTitle><DialogDescription>{inviteToken ? `Shown once · expires ${adminDate(inviteExpiresAt)}` : "Create an invitation for a Forge user."}</DialogDescription></DialogHeader>{inviteToken ? <><code className="break-all text-xs">{inviteToken}</code><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Close</DialogClose><Button type="button" size="sm" onClick={() => void copyInvitation()}>{copied ? "Copied" : "Copy invitation"}</Button></DialogFooter></> : <form onSubmit={(event) => { event.preventDefault(); void invite(); }}><FieldGroup><Field><FieldLabel htmlFor="invite-display-name">Display name</FieldLabel><Input id="invite-display-name" autoFocus placeholder="Forge user" value={displayName} onChange={(event) => setDisplayName(event.target.value)} /></Field><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm">Invite</Button></DialogFooter></FieldGroup></form>}</DialogContent></Dialog>
        </>) : null}
        {isPasskeys ? (<>
          <section>
            <SettingsToolbar searchLabel="Search passkeys" searchPlaceholder="Search passkeys…" filterLabel="All" searchWidth="compact" actions={null} />
            <div className="mt-10"><div className="flex h-8 items-center justify-between"><div className="flex items-baseline gap-2"><h2 className="text-base font-medium">Passkeys</h2><span className="text-[11px] text-muted-foreground">{credentials.filter((credential) => !credential.revokedAt).length} active</span></div></div><div className="mt-5">{credentials.map((credential) => { const candidate = users.find((entry) => entry.id === credential.userId); const action = `credential:${credential.id}`; return <div className="flex min-h-11 items-center justify-between gap-2 rounded-lg px-1 text-xs hover:bg-black/[0.025]" key={credential.id}><span className="min-w-0 truncate">{candidate?.displayName ?? "User"}<span className="ml-2 text-muted-foreground">{credential.revokedAt ? "revoked" : `created ${adminDate(credential.createdAt)}`}</span></span>{!credential.revokedAt && credential.userId !== user.id ? <span className="flex shrink-0 items-center gap-1">{pendingAction === action ? <span className="text-[11px] text-muted-foreground">Confirm</span> : null}<Button variant="ghost" size="sm" onClick={() => void revokeCredential(credential)}>{pendingAction === action ? "Confirm revoke" : "Revoke"}</Button>{pendingAction === action ? <Button variant="outline" size="sm" onClick={() => setPendingAction("")}>Cancel</Button> : null}</span> : null}</div>; })}</div></div>
          </section>
        </>) : null}
        {isModels ? (<>
          <section>
            <div className="flex h-8 items-center justify-between gap-3"><div className="flex items-baseline gap-2"><h2 className="text-base font-medium">Model catalog</h2><span className="text-[11px] text-muted-foreground">{models.filter((model) => model.status === "active").length} active</span></div><Button variant="outline" size="sm" onClick={() => setModelOpen(true)}>Add model</Button></div>
            <div className="mt-5">{models.map((model) => <div className="flex h-11 items-center justify-between gap-3 rounded-lg px-1 text-[13px] hover:bg-black/[0.025]" key={model.id}><div className="min-w-0"><div className="truncate">{model.displayName} <code className="ml-1 text-[11px] text-muted-foreground">{model.id}</code></div><div className="truncate text-[10px] leading-3 text-muted-foreground">{model.status}{model.description ? ` · ${model.description}` : ""}</div></div><Button variant="ghost" size="sm" onClick={() => void toggleModel(model)}>{model.status === "active" ? "Retire" : "Restore"}</Button></div>)}</div>
          </section>
          <Dialog open={modelOpen} onOpenChange={setModelOpen}><DialogContent><DialogHeader><DialogTitle>Add model</DialogTitle><DialogDescription>Make a model available to new profiles.</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); void createModel(); }}><FieldGroup><Field><FieldLabel htmlFor="model-id">Model ID</FieldLabel><Input id="model-id" autoFocus placeholder="gpt-5-codex" value={modelId} onChange={(event) => setModelId(event.target.value)} /></Field><Field><FieldLabel htmlFor="model-display-name">Display name</FieldLabel><Input id="model-display-name" value={modelName} onChange={(event) => setModelName(event.target.value)} /></Field><DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm" />}>Cancel</DialogClose><Button type="submit" size="sm" disabled={!modelId.trim() || !modelName.trim()}>Add model</Button></DialogFooter></FieldGroup></form></DialogContent></Dialog>
        </>) : null}
        {error ? <div className="px-4 py-3 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      </div>
    </SettingsLayout>
  );
}
