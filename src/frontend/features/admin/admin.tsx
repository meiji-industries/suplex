import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { Spinner } from "../../components/ui/spinner.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { SettingsLayout } from "../settings/settings-layout.js";
import { readJson, withCompany, type ApiUser } from "../../lib/api.js";
import { useCallback, useEffect, useState, type ReactElement } from "react";
import type {
  ApiProfile,
  ApiCredential,
  ApiHermesAgent,
  ApiInvitation,
  ApiModel,
  ApiProject,
} from "../../shell/view-shared.js";
import { UsersSection } from "./users-section.js";
import { CompaniesSection } from "./companies-section.js";
import { InvitationsSection } from "./invitations-section.js";
import { ModelsSection } from "./models-section.js";
import { PasskeysSection } from "./passkeys-section.js";
import { InternalAgentsSection } from "./internal-agents-section.js";
import { InternalAgentDialog } from "./internal-agent-editor-dialog.js";
import { HermesAgentsSection } from "./hermes-agents-section.js";
import { HermesAvatarDialog } from "./hermes-avatar-dialog.js";
import { HermesNewAgentDialog } from "./hermes-new-agent-dialog.js";
import { HermesPairingCodeDialog } from "./hermes-pairing-code-dialog.js";
import { HermesProjectGrantsDialog } from "./hermes-project-grants-dialog.js";
import { createHermesActions } from "./hermes-actions.js";

export function AdminView(): ReactElement {
  const { user, companies, currentCompany, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [agents, setAgents] = useState<ApiProfile[]>([]);
  const [hermesAgents, setHermesAgents] = useState<ApiHermesAgent[]>([]);
  const [companyProjects, setCompanyProjects] = useState<ApiProject[]>([]);
  const [models, setModels] = useState<ApiModel[]>([]);
  const providerOptions = [...new Map(models.map((model) => [model.provider, { id: model.provider, label: model.providerLabel, status: model.providerStatus }])).values()];
  const [displayName, setDisplayName] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentRole, setAgentRole] = useState<"root" | "worker">("root");
  const [agentAvatarSeed, setAgentAvatarSeed] = useState("");
  const [agentModel, setAgentModel] = useState("gpt-5.6-sol");
  const [agentProvider, setAgentProvider] = useState<string>("openai");
  const [agentReasoning, setAgentReasoning] = useState("medium");
  const [agentPriority, setAgentPriority] = useState("default");
  const [agentOpen, setAgentOpen] = useState(false);
  const [editingAgentId, setEditingAgentId] = useState<string | null>(null);
  const [archiveTarget, setArchiveTarget] = useState<ApiProfile | null>(null);
  const [inviteToken, setInviteToken] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");
  const [initialReloading, setInitialReloading] = useState(true);

  // Hermes agent administration state
  const [newHermesOpen, setNewHermesOpen] = useState(false);
  const [hermesName, setHermesName] = useState("");
  const [hermesError, setHermesError] = useState("");
  const [hermesProjectIds, setHermesProjectIds] = useState<string[]>([]);
  const [hermesAvatarSeed, setHermesAvatarSeed] = useState("");
  const [hermesAvatarTarget, setHermesAvatarTarget] =
    useState<ApiHermesAgent | null>(null);
  const [pairingCodeModalOpen, setPairingCodeModalOpen] = useState(false);
  const [pairingCodeData, setPairingCodeData] = useState<{
    code: string;
    expiresAt: string;
    agentName: string;
  } | null>(null);
  const [hermesProfileName, setHermesProfileName] = useState("default");
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const [pairingInstructionsCopied, setPairingInstructionsCopied] =
    useState(false);
  const [editProjectsModalOpen, setEditProjectsModalOpen] = useState(false);
  const [editingHermesAgent, setEditingHermesAgent] =
    useState<ApiHermesAgent | null>(null);
  const [editingHermesProjectIds, setEditingHermesProjectIds] = useState<
    string[]
  >([]);

  const isAgents = window.location.pathname.endsWith("/agents");
  const isModels = window.location.pathname.endsWith("/models");
  const isCompanies = window.location.pathname.endsWith("/companies");
  const isInvitations = window.location.pathname.endsWith("/invitations");
  const isPasskeys = window.location.pathname.endsWith("/passkeys");

  const reload = useCallback(
    async (signal?: AbortSignal): Promise<void> => {
      const options = signal ? { signal } : {};
      const needsUsers =
        isCompanies || isPasskeys || (!isAgents && !isModels && !isInvitations);
      const needsCredentials =
        isPasskeys ||
        (!isAgents && !isModels && !isCompanies && !isInvitations);
      try {
        setError("");
        const [
          userList,
          invitationList,
          credentialList,
          agentList,
          hermesList,
          projectList,
          modelList,
        ] = await Promise.all([
          needsUsers
            ? readJson<{ users: ApiUser[] }>("/api/admin/users", options)
            : { users: [] },
          isInvitations
            ? readJson<{ invitations: ApiInvitation[] }>(
                "/api/admin/invitations",
                options,
              )
            : { invitations: [] },
          needsCredentials
            ? readJson<{ credentials: ApiCredential[] }>(
                "/api/admin/credentials",
                options,
              )
            : { credentials: [] },
          isAgents
            ? readJson<{ profiles: ApiProfile[] }>(
                "/api/profiles?includeArchived=true",
                options,
              )
            : { profiles: [] },
          isAgents
            ? readJson<{ agents: ApiHermesAgent[] }>(
                `/api/admin/hermes-agents${currentCompany ? `?companyId=${encodeURIComponent(currentCompany.id)}` : ""}`,
                options,
              ).catch(() => ({ agents: [] }))
            : { agents: [] },
          isAgents && currentCompany
            ? readJson<{ projects: ApiProject[] }>(
                `/api/companies/${encodeURIComponent(currentCompany.id)}/projects`,
                options,
              ).catch(() => ({ projects: [] }))
            : Promise.resolve({ projects: [] }),
          isAgents || isModels
            ? readJson<{ models: ApiModel[] }>(
                "/api/admin/models",
                options,
              ).catch(() => {
                if (signal?.aborted) return { models: [] };
                setError(
                   "Forge cannot read the model configuration. Check OpenCode, Claude Code, or Devin CLI on the Forge host.",
                );
                return { models: [] };
              })
            : { models: [] },
        ]);
        if (signal?.aborted) return;
        setUsers(userList.users);
        setInvitations(invitationList.invitations);
        setCredentials(credentialList.credentials);
        setAgents(agentList.profiles);
        setHermesAgents(hermesList.agents);
        setCompanyProjects(projectList.projects);
        const projectIds = new Set(
          projectList.projects.map((project) => project.id),
        );
        setHermesProjectIds((selected) =>
          selected.filter((projectId) => projectIds.has(projectId)),
        );
        setEditingHermesProjectIds((selected) =>
          selected.filter((projectId) => projectIds.has(projectId)),
        );
        setModels(modelList.models);
      } catch (reason) {
        if (signal?.aborted) return;
        if (
          reason instanceof Error &&
          reason.message === "Authentication required"
        )
          window.location.assign("/auth");
        else setError("Unable to load administration");
      }
    },
    [
      currentCompany,
      isAgents,
      isCompanies,
      isInvitations,
      isModels,
      isPasskeys,
    ],
  );

  useEffect(() => {
    if (loading || user?.role !== "admin") return;
    const controller = new AbortController();
    setInitialReloading(true);
    void reload(controller.signal).finally(() => {
      if (!controller.signal.aborted) setInitialReloading(false);
    });
    return () => {
      controller.abort();
    };
  }, [loading, reload, user?.role]);

  const invite = async (): Promise<void> => {
    try {
      const result = await readJson<{ token: string; expiresAt: string }>(
        "/api/admin/invitations",
        {
          method: "POST",
          body: JSON.stringify({ displayName: displayName || "Forge user" }),
        },
      );
      setInviteToken(result.token);
      setInviteExpiresAt(result.expiresAt);
      setCopied(false);
      setDisplayName("");
      await reload();
    } catch {
      setError("Unable to invite user");
    }
  };
  const copyInvitation = async (): Promise<void> => {
    if (!inviteToken) return;
    try {
      await navigator.clipboard.writeText(inviteToken);
      setCopied(true);
    } catch {
      setError("Unable to copy invitation");
    }
  };
  const openNewAgent = (): void => {
    setEditingAgentId(null);
    setAgentName("");
    setAgentRole("root");
    setAgentAvatarSeed(crypto.randomUUID().replaceAll("-", ""));
    setAgentProvider("openai");
    setAgentModel("gpt-5.6-sol");
    setAgentReasoning("medium");
    setAgentPriority("default");
    setAgentOpen(true);
  };
  const openEditAgent = (agent: ApiProfile): void => {
    setEditingAgentId(agent.id);
    setAgentName(agent.name);
    setAgentRole(agent.role);
    setAgentAvatarSeed(agent.avatarSeed);
    setAgentProvider(agent.provider);
    setAgentModel(agent.model);
    setAgentReasoning(agent.reasoningLevel);
    setAgentPriority(agent.serviceTier);
    setAgentOpen(true);
  };
  const saveAgent = async (): Promise<void> => {
    const editing = editingAgentId !== null;
    try {
      await readJson(
        editing
          ? `/api/admin/profiles/${encodeURIComponent(editingAgentId)}`
          : "/api/admin/profiles",
        {
          method: editing ? "PATCH" : "POST",
          body: JSON.stringify({
            name: agentName,
            role: agentRole,
            avatarSeed: agentAvatarSeed,
            provider: agentProvider,
            model: agentModel,
            reasoningLevel: agentReasoning,
            serviceTier: agentPriority,
          }),
        },
      );
      setAgentOpen(false);
      setEditingAgentId(null);
      await reload();
    } catch {
      setError(editing ? "Unable to update agent" : "Unable to add agent");
    }
  };
  const patchAgent = async (
    agent: ApiProfile,
    body: Record<string, unknown>,
    fallback: string,
  ): Promise<void> => {
    try {
      await readJson(`/api/admin/profiles/${encodeURIComponent(agent.id)}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      });
      setError("");
      await reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : fallback);
    }
  };
  const duplicateAgent = async (agent: ApiProfile): Promise<void> => {
    try {
      await readJson(
        `/api/admin/profiles/${encodeURIComponent(agent.id)}/duplicate`,
        { method: "POST", body: "{}" },
      );
      setError("");
      await reload();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Unable to duplicate agent",
      );
    }
  };

  const {
    openNewHermesAgent,
    createHermesAgent,
    reissueHermesPairing,
    rotateHermesAgent,
    revokeHermesAgent,
    openEditHermesProjects,
    saveHermesProjects,
    copyPairingCode,
    copyHermesSetupInstructions,
  } = createHermesActions({
    currentCompany,
    hermesName,
    hermesProjectIds,
    hermesAvatarSeed,
    editingHermesAgent,
    editingHermesProjectIds,
    pairingCodeData,
    hermesProfileName,
    pendingAction,
    reload,
    setNewHermesOpen,
    setHermesName,
    setHermesError,
    setHermesProjectIds,
    setHermesAvatarSeed,
    setPairingCodeData,
    setHermesProfileName,
    setPairingCodeCopied,
    setPairingInstructionsCopied,
    setPairingCodeModalOpen,
    setPendingAction,
    setEditingHermesAgent,
    setEditingHermesProjectIds,
    setEditProjectsModalOpen,
    setError,
  });

  const changeMembership = async (
    companyId: string,
    targetUserId: string,
    add: boolean,
  ): Promise<void> => {
    const action = `membership:${companyId}:${targetUserId}`;
    if (!add && pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      const init: RequestInit = { method: add ? "POST" : "DELETE" };
      if (add) init.body = JSON.stringify({ userId: targetUserId });
      await readJson(
        add
          ? `/api/admin/companies/${companyId}/members`
          : `/api/admin/companies/${companyId}/members/${targetUserId}`,
        init,
      );
      await reload();
      setPendingAction("");
    } catch {
      setError("Unable to change membership");
    }
  };
  const revokeUser = async (candidate: ApiUser): Promise<void> => {
    const action = `user:${candidate.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(`/api/admin/users/${candidate.id}/revoke`, {
        method: "POST",
        body: "{}",
      });
      setPendingAction("");
      await reload();
    } catch {
      setError("Unable to revoke user");
    }
  };
  const revokeCredential = async (credential: ApiCredential): Promise<void> => {
    const action = `credential:${credential.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(`/api/admin/credentials/${credential.id}/revoke`, {
        method: "POST",
        body: "{}",
      });
      setPendingAction("");
      await reload();
    } catch {
      setError("Unable to revoke passkey");
    }
  };

  const sortedAgents = [...agents].sort(
    (left, right) =>
      Number(Boolean(left.archivedAt)) - Number(Boolean(right.archivedAt)),
  );
  const viewTitle = isAgents
    ? "Agents"
    : isModels
      ? "Models"
      : isCompanies
        ? "Companies"
        : isInvitations
          ? "Invitations"
          : isPasskeys
            ? "Passkeys"
            : "Users";
  const activeHref = withCompany(window.location.pathname, currentCompany?.id);
  const backHref = withCompany("/projects", currentCompany?.id);

  if (loading || (user?.role === "admin" && initialReloading)) {
    return (
      <SettingsLayout
        title={viewTitle}
        companyId={currentCompany?.id ?? ""}
        backHref={backHref}
        activeHref={activeHref}
        contentClassName=""
      >
        <div
          className="space-y-2 p-4"
          aria-busy="true"
          aria-label="Loading administration"
        >
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner />
            <span>Loading…</span>
          </div>
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-3/4" />
        </div>
      </SettingsLayout>
    );
  }
  if (user?.role !== "admin") {
    return (
      <SettingsLayout
        title={viewTitle}
        companyId={currentCompany?.id ?? ""}
        backHref={backHref}
        activeHref={activeHref}
        contentClassName=""
      >
        <div className="p-4 text-xs text-muted-foreground">
          Administration is unavailable.
        </div>
      </SettingsLayout>
    );
  }

  return (
    <SettingsLayout
      title={viewTitle}
      companyId={currentCompany?.id ?? ""}
      backHref={backHref}
      activeHref={activeHref}
      contentClassName=""
    >
      <div>
        {!isAgents &&
        !isModels &&
        !isCompanies &&
        !isInvitations &&
        !isPasskeys ? (
          <UsersSection
            users={users}
            credentials={credentials}
            pendingAction={pendingAction}
            onRevokeUser={(candidate) => void revokeUser(candidate)}
            onClearPendingAction={() => setPendingAction("")}
          />
        ) : null}

        {isAgents ? (
          <div className="space-y-12">
            <InternalAgentsSection
              agents={agents}
              sortedAgents={sortedAgents}
              archiveTarget={archiveTarget}
              onArchiveTargetChange={setArchiveTarget}
              onOpenNewAgent={openNewAgent}
              onOpenEditAgent={openEditAgent}
              onPatchAgent={patchAgent}
              onDuplicateAgent={duplicateAgent}
            />
            <HermesAgentsSection
              agents={hermesAgents}
              projects={companyProjects}
              pendingAction={pendingAction}
              onOpenNewAgent={openNewHermesAgent}
              onReissuePairing={reissueHermesPairing}
              onRotateAgent={rotateHermesAgent}
              onEditProjects={openEditHermesProjects}
              onEditAvatar={setHermesAvatarTarget}
              onRevokeAgent={revokeHermesAgent}
              onClearPendingAction={() => setPendingAction("")}
            />
            <InternalAgentDialog
              open={agentOpen}
              editingAgentId={editingAgentId}
              agentName={agentName}
              agentRole={agentRole}
              agentAvatarSeed={agentAvatarSeed}
              agentModel={agentModel}
              agentProvider={agentProvider}
              agentReasoning={agentReasoning}
              agentPriority={agentPriority}
              models={models}
              providerOptions={providerOptions}
              onOpenChange={(open) => {
                setAgentOpen(open);
                if (!open) setEditingAgentId(null);
              }}
              onAgentNameChange={setAgentName}
              onAgentRoleChange={setAgentRole}
              onAgentAvatarSeedChange={setAgentAvatarSeed}
              onAgentModelChange={setAgentModel}
              onAgentProviderChange={setAgentProvider}
              onAgentReasoningChange={setAgentReasoning}
              onAgentPriorityChange={setAgentPriority}
              onSave={saveAgent}
            />
            <HermesAvatarDialog
              target={hermesAvatarTarget}
              onTargetChange={setHermesAvatarTarget}
            />
            <HermesNewAgentDialog
              open={newHermesOpen}
              name={hermesName}
              error={hermesError}
              projectIds={hermesProjectIds}
              projects={companyProjects}
              avatarSeed={hermesAvatarSeed}
              onOpenChange={setNewHermesOpen}
              onNameChange={(value) => {
                setHermesName(value);
                setHermesError("");
              }}
              onProjectIdsChange={setHermesProjectIds}
              onAvatarSeedChange={setHermesAvatarSeed}
              onCreate={createHermesAgent}
            />
            <HermesPairingCodeDialog
              open={pairingCodeModalOpen}
              data={pairingCodeData}
              profileName={hermesProfileName}
              codeCopied={pairingCodeCopied}
              instructionsCopied={pairingInstructionsCopied}
              onOpenChange={setPairingCodeModalOpen}
              onProfileNameChange={(value) => {
                setHermesProfileName(value);
                setPairingInstructionsCopied(false);
              }}
              onCopyCode={copyPairingCode}
              onCopyInstructions={copyHermesSetupInstructions}
            />
            <HermesProjectGrantsDialog
              open={editProjectsModalOpen}
              agent={editingHermesAgent}
              projectIds={editingHermesProjectIds}
              projects={companyProjects}
              onOpenChange={setEditProjectsModalOpen}
              onProjectIdsChange={setEditingHermesProjectIds}
              onSave={saveHermesProjects}
            />
          </div>
        ) : null}

        {isCompanies ? (
          <CompaniesSection
            companies={companies}
            users={users}
            pendingAction={pendingAction}
            onChangeMembership={(companyId, userId, add) =>
              void changeMembership(companyId, userId, add)
            }
            onClearPendingAction={() => setPendingAction("")}
          />
        ) : null}

        {isInvitations ? (
          <InvitationsSection
            invitations={invitations}
            inviteOpen={inviteOpen}
            inviteToken={inviteToken}
            inviteExpiresAt={inviteExpiresAt}
            copied={copied}
            displayName={displayName}
            onOpenChange={(open) => {
              setInviteOpen(open);
              if (!open) {
                setInviteToken("");
                setCopied(false);
              }
            }}
            onOpenInvite={() => {
              setInviteToken("");
              setCopied(false);
              setInviteOpen(true);
            }}
            onDisplayNameChange={setDisplayName}
            onInvite={() => void invite()}
            onCopyInvitation={() => void copyInvitation()}
          />
        ) : null}

        {isPasskeys ? (
          <PasskeysSection
            credentials={credentials}
            users={users}
            currentUserId={user.id}
            pendingAction={pendingAction}
            onRevokeCredential={(credential) =>
              void revokeCredential(credential)
            }
            onClearPendingAction={() => setPendingAction("")}
          />
        ) : null}

        {isModels ? (
          <ModelsSection models={models} onReload={() => void reload()} />
        ) : null}

        {error ? (
          <div className="px-4 py-3 text-xs text-destructive">
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          </div>
        ) : null}
      </div>
    </SettingsLayout>
  );
}
