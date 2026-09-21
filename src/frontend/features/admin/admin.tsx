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
  ApiExternalAgent,
  ApiInvitation,
  ApiModel,
  ApiProject,
} from "../../shell/view-shared.js";
import { UsersSection } from "./users-section.js";
import { CompaniesSection } from "./companies-section.js";
import { InvitationsSection } from "./invitations-section.js";
import { ModelsSection } from "./models-section.js";
import { PasskeysSection } from "./passkeys-section.js";
import { InternalAgentsManager } from "./internal-agents-manager.js";
import { ExternalAgentsSection } from "./external-agents-section.js";
import { ExternalAgentConnectionGuide } from "./external-agent-connection-guide.js";
import { ExternalAgentAvatarDialog } from "./external-agent-avatar-dialog.js";
import { ExternalAgentNewAgentDialog } from "./external-agent-new-dialog.js";
import { ExternalAgentPairingCodeDialog } from "./external-agent-pairing-code-dialog.js";
import { ExternalAgentProjectGrantsDialog } from "./external-agent-project-grants-dialog.js";
import { createExternalAgentActions } from "./external-agent-actions.js";

export function AdminView(): ReactElement {
  const { user, companies, currentCompany, loading } = useCompanyContext();
  const [users, setUsers] = useState<ApiUser[]>([]);
  const [invitations, setInvitations] = useState<ApiInvitation[]>([]);
  const [credentials, setCredentials] = useState<ApiCredential[]>([]);
  const [agents, setAgents] = useState<ApiProfile[]>([]);
  const [externalAgents, setExternalAgents] = useState<ApiExternalAgent[]>([]);
  const [companyProjects, setCompanyProjects] = useState<ApiProject[]>([]);
  const [models, setModels] = useState<ApiModel[]>([]);
  const [displayName, setDisplayName] = useState("");
  const [inviteOpen, setInviteOpen] = useState(false);
  const [inviteToken, setInviteToken] = useState("");
  const [inviteExpiresAt, setInviteExpiresAt] = useState("");
  const [copied, setCopied] = useState(false);
  const [pendingAction, setPendingAction] = useState("");
  const [error, setError] = useState("");
  const [initialReloading, setInitialReloading] = useState(true);

  // External agent administration state
  const [newExternalAgentOpen, setNewExternalAgentOpen] = useState(false);
  const [externalAgentName, setExternalAgentName] = useState("");
  const [externalAgentError, setExternalAgentError] = useState("");
  const [externalAgentProjectIds, setExternalAgentProjectIds] = useState<string[]>([]);
  const [externalAgentAvatarSeed, setExternalAgentAvatarSeed] = useState("");
  const [externalAgentAvatarTarget, setExternalAgentAvatarTarget] =
    useState<ApiExternalAgent | null>(null);
  const [pairingCodeModalOpen, setPairingCodeModalOpen] = useState(false);
  const [pairingCodeData, setPairingCodeData] = useState<{
    code: string;
    expiresAt: string;
    agentName: string;
  } | null>(null);
  const [externalAgentProfileName, setExternalAgentProfileName] = useState("default");
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const [pairingInstructionsCopied, setPairingInstructionsCopied] =
    useState(false);
  const [editProjectsModalOpen, setEditProjectsModalOpen] = useState(false);
  const [editingExternalAgent, setEditingExternalAgent] =
    useState<ApiExternalAgent | null>(null);
  const [editingExternalAgentProjectIds, setEditingExternalAgentProjectIds] = useState<
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
          externalAgentList,
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
            ? readJson<{ agents: ApiExternalAgent[] }>(
                `/api/admin/external-agents${currentCompany ? `?companyId=${encodeURIComponent(currentCompany.id)}` : ""}`,
                options,
              ).catch(() => ({ agents: [] }))
            : { agents: [] },
          isAgents && currentCompany
            ? readJson<{ projects: ApiProject[] }>(
                `/api/companies/${encodeURIComponent(currentCompany.id)}/projects`,
                options,
              ).catch(() => ({ projects: [] }))
            : Promise.resolve({ projects: [] }),
          isModels
            ? readJson<{ models: ApiModel[] }>(
                "/api/admin/models",
                options,
              ).catch(() => {
                if (signal?.aborted) return { models: [] };
                setError(
                   "Forge cannot read the model configuration. Check OpenCode, Claude Code, Devin CLI, or Codex CLI on the Forge host.",
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
        setExternalAgents(externalAgentList.agents);
        setCompanyProjects(projectList.projects);
        const projectIds = new Set(
          projectList.projects.map((project) => project.id),
        );
        setExternalAgentProjectIds((selected) =>
          selected.filter((projectId) => projectIds.has(projectId)),
        );
        setEditingExternalAgentProjectIds((selected) =>
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
  const {
    openNewExternalAgent,
    createExternalAgent,
    reissueExternalAgentPairing,
    rotateExternalAgent,
    revokeExternalAgent,
    openEditExternalAgentProjects,
    saveExternalAgentProjects,
    copyPairingCode,
    copyExternalAgentSetupInstructions,
  } = createExternalAgentActions({
    currentCompany,
    externalAgentName,
    externalAgentProjectIds,
    externalAgentAvatarSeed,
    editingExternalAgent,
    editingExternalAgentProjectIds,
    pairingCodeData,
    externalAgentProfileName,
    pendingAction,
    reload,
    setNewExternalAgentOpen,
    setExternalAgentName,
    setExternalAgentError,
    setExternalAgentProjectIds,
    setExternalAgentAvatarSeed,
    setPairingCodeData,
    setExternalAgentProfileName,
    setPairingCodeCopied,
    setPairingInstructionsCopied,
    setPairingCodeModalOpen,
    setPendingAction,
    setEditingExternalAgent,
    setEditingExternalAgentProjectIds,
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
            <InternalAgentsManager agents={agents} onSaved={reload} />
            <ExternalAgentsSection
              agents={externalAgents}
              projects={companyProjects}
              pendingAction={pendingAction}
              onOpenNewAgent={openNewExternalAgent}
              onReissuePairing={reissueExternalAgentPairing}
              onRotateAgent={rotateExternalAgent}
              onEditProjects={openEditExternalAgentProjects}
              onEditAvatar={setExternalAgentAvatarTarget}
              onRevokeAgent={revokeExternalAgent}
              onClearPendingAction={() => setPendingAction("")}
            />
            <ExternalAgentConnectionGuide />
            <ExternalAgentAvatarDialog
              target={externalAgentAvatarTarget}
              onTargetChange={setExternalAgentAvatarTarget}
            />
            <ExternalAgentNewAgentDialog
              open={newExternalAgentOpen}
              name={externalAgentName}
              error={externalAgentError}
              projectIds={externalAgentProjectIds}
              projects={companyProjects}
              avatarSeed={externalAgentAvatarSeed}
              onOpenChange={setNewExternalAgentOpen}
              onNameChange={(value) => {
                setExternalAgentName(value);
                setExternalAgentError("");
              }}
              onProjectIdsChange={setExternalAgentProjectIds}
              onAvatarSeedChange={setExternalAgentAvatarSeed}
              onCreate={createExternalAgent}
            />
            <ExternalAgentPairingCodeDialog
              open={pairingCodeModalOpen}
              data={pairingCodeData}
              profileName={externalAgentProfileName}
              codeCopied={pairingCodeCopied}
              instructionsCopied={pairingInstructionsCopied}
              onOpenChange={setPairingCodeModalOpen}
              onProfileNameChange={(value) => {
                setExternalAgentProfileName(value);
                setPairingInstructionsCopied(false);
              }}
              onCopyCode={copyPairingCode}
              onCopyInstructions={copyExternalAgentSetupInstructions}
            />
            <ExternalAgentProjectGrantsDialog
              open={editProjectsModalOpen}
              agent={editingExternalAgent}
              projectIds={editingExternalAgentProjectIds}
              projects={companyProjects}
              onOpenChange={setEditProjectsModalOpen}
              onProjectIdsChange={setEditingExternalAgentProjectIds}
              onSave={saveExternalAgentProjects}
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
