import { readJson } from "../../lib/api.js";
import type { ApiExternalAgent } from "../../shell/view-shared.js";
import { externalAgentSetupInstructions } from "./external-agent-setup-instructions.js";
import type { Dispatch, SetStateAction } from "react";

type PairingCode = {
  code: string;
  expiresAt: string;
  agentName: string;
} | null;

export function createExternalAgentActions({
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
}: {
  currentCompany: { id: string } | null | undefined;
  externalAgentName: string;
  externalAgentProjectIds: string[];
  externalAgentAvatarSeed: string;
  editingExternalAgent: ApiExternalAgent | null;
  editingExternalAgentProjectIds: string[];
  pairingCodeData: PairingCode;
  externalAgentProfileName: string;
  pendingAction: string;
  reload: () => Promise<void>;
  setNewExternalAgentOpen: Dispatch<SetStateAction<boolean>>;
  setExternalAgentName: Dispatch<SetStateAction<string>>;
  setExternalAgentError: Dispatch<SetStateAction<string>>;
  setExternalAgentProjectIds: Dispatch<SetStateAction<string[]>>;
  setExternalAgentAvatarSeed: Dispatch<SetStateAction<string>>;
  setPairingCodeData: Dispatch<SetStateAction<PairingCode>>;
  setExternalAgentProfileName: Dispatch<SetStateAction<string>>;
  setPairingCodeCopied: Dispatch<SetStateAction<boolean>>;
  setPairingInstructionsCopied: Dispatch<SetStateAction<boolean>>;
  setPairingCodeModalOpen: Dispatch<SetStateAction<boolean>>;
  setPendingAction: Dispatch<SetStateAction<string>>;
  setEditingExternalAgent: Dispatch<SetStateAction<ApiExternalAgent | null>>;
  setEditingExternalAgentProjectIds: Dispatch<SetStateAction<string[]>>;
  setEditProjectsModalOpen: Dispatch<SetStateAction<boolean>>;
  setError: Dispatch<SetStateAction<string>>;
}) {
  const showPairingCode = (
    data: { pairingCode: string; expiresAt: string },
    agentName: string,
  ): void => {
    setPairingCodeData({
      code: data.pairingCode,
      expiresAt: data.expiresAt,
      agentName,
    });
    setExternalAgentProfileName("default");
    setPairingCodeCopied(false);
    setPairingInstructionsCopied(false);
    setPairingCodeModalOpen(true);
  };
  const openNewExternalAgent = (): void => {
    setExternalAgentName("");
    setExternalAgentError("");
    setExternalAgentProjectIds([]);
    setExternalAgentAvatarSeed(crypto.randomUUID().replaceAll("-", ""));
    setNewExternalAgentOpen(true);
  };
  const createExternalAgent = async (): Promise<void> => {
    if (!currentCompany) return;
    setExternalAgentError("");
    try {
      const result = await readJson<{
        agent: ApiExternalAgent;
        pairingCode: string;
        expiresAt: string;
      }>("/api/admin/external-agents", {
        method: "POST",
        body: JSON.stringify({
          name: externalAgentName.trim(),
          companyId: currentCompany.id,
          projectIds: externalAgentProjectIds,
          avatarSeed: externalAgentAvatarSeed,
        }),
      });
      setNewExternalAgentOpen(false);
      showPairingCode(result, result.agent.name);
      await reload();
    } catch (error) {
      setExternalAgentError(
        error instanceof Error ? error.message : "Unable to add external agent",
      );
    }
  };
  const reissueExternalAgentPairing = async (agent: ApiExternalAgent): Promise<void> => {
    try {
      const result = await readJson<{ pairingCode: string; expiresAt: string }>(
        `/api/admin/external-agents/${encodeURIComponent(agent.id)}/pairing-code`,
        { method: "POST", body: "{}" },
      );
      showPairingCode(result, agent.name);
      await reload();
    } catch {
      setError("Unable to reissue pairing code");
    }
  };
  const rotateExternalAgent = async (agent: ApiExternalAgent): Promise<void> => {
    try {
      const result = await readJson<{ pairingCode: string; expiresAt: string }>(
        `/api/admin/external-agents/${encodeURIComponent(agent.id)}/rotate`,
        { method: "POST", body: "{}" },
      );
      showPairingCode(result, agent.name);
      await reload();
    } catch {
      setError("Unable to rotate external agent");
    }
  };
  const revokeExternalAgent = async (agent: ApiExternalAgent): Promise<void> => {
    const action = `externalAgent:revoke:${agent.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(
        `/api/admin/external-agents/${encodeURIComponent(agent.id)}/revoke`,
        { method: "POST", body: "{}" },
      );
      setPendingAction("");
      await reload();
    } catch {
      setError("Unable to revoke external agent");
    }
  };
  const openEditExternalAgentProjects = (agent: ApiExternalAgent): void => {
    setEditingExternalAgent(agent);
    setEditingExternalAgentProjectIds([...agent.projectIds]);
    setEditProjectsModalOpen(true);
  };
  const saveExternalAgentProjects = async (): Promise<void> => {
    if (!editingExternalAgent) return;
    try {
      await readJson<{ agent: ApiExternalAgent }>(
        `/api/admin/external-agents/${encodeURIComponent(editingExternalAgent.id)}/projects`,
        {
          method: "PUT",
          body: JSON.stringify({ projectIds: editingExternalAgentProjectIds }),
        },
      );
      setEditProjectsModalOpen(false);
      setEditingExternalAgent(null);
      await reload();
    } catch {
      setError("Unable to update agent projects");
    }
  };
  const copyPairingCode = async (): Promise<void> => {
    if (!pairingCodeData?.code) return;
    try {
      await navigator.clipboard.writeText(pairingCodeData.code);
      setPairingCodeCopied(true);
    } catch {
      setError("Unable to copy pairing code");
    }
  };
  const copyExternalAgentSetupInstructions = async (): Promise<void> => {
    const instructions = externalAgentSetupInstructions(
      pairingCodeData,
      externalAgentProfileName,
    );
    if (!instructions) return;
    try {
      await navigator.clipboard.writeText(instructions);
      setPairingInstructionsCopied(true);
    } catch {
      setPairingInstructionsCopied(false);
      setError("Unable to copy ExternalAgent setup instructions");
    }
  };
  return {
    openNewExternalAgent,
    createExternalAgent,
    reissueExternalAgentPairing,
    rotateExternalAgent,
    revokeExternalAgent,
    openEditExternalAgentProjects,
    saveExternalAgentProjects,
    copyPairingCode,
    copyExternalAgentSetupInstructions,
  };
}
