import { readJson } from "../../lib/api.js";
import type { ApiHermesAgent } from "../../shell/view-shared.js";
import { hermesSetupInstructions } from "./hermes-setup-instructions.js";
import type { Dispatch, SetStateAction } from "react";

type PairingCode = {
  code: string;
  expiresAt: string;
  agentName: string;
} | null;

export function createHermesActions({
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
}: {
  currentCompany: { id: string } | null | undefined;
  hermesName: string;
  hermesProjectIds: string[];
  hermesAvatarSeed: string;
  editingHermesAgent: ApiHermesAgent | null;
  editingHermesProjectIds: string[];
  pairingCodeData: PairingCode;
  hermesProfileName: string;
  pendingAction: string;
  reload: () => Promise<void>;
  setNewHermesOpen: Dispatch<SetStateAction<boolean>>;
  setHermesName: Dispatch<SetStateAction<string>>;
  setHermesError: Dispatch<SetStateAction<string>>;
  setHermesProjectIds: Dispatch<SetStateAction<string[]>>;
  setHermesAvatarSeed: Dispatch<SetStateAction<string>>;
  setPairingCodeData: Dispatch<SetStateAction<PairingCode>>;
  setHermesProfileName: Dispatch<SetStateAction<string>>;
  setPairingCodeCopied: Dispatch<SetStateAction<boolean>>;
  setPairingInstructionsCopied: Dispatch<SetStateAction<boolean>>;
  setPairingCodeModalOpen: Dispatch<SetStateAction<boolean>>;
  setPendingAction: Dispatch<SetStateAction<string>>;
  setEditingHermesAgent: Dispatch<SetStateAction<ApiHermesAgent | null>>;
  setEditingHermesProjectIds: Dispatch<SetStateAction<string[]>>;
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
    setHermesProfileName("default");
    setPairingCodeCopied(false);
    setPairingInstructionsCopied(false);
    setPairingCodeModalOpen(true);
  };
  const openNewHermesAgent = (): void => {
    setHermesName("");
    setHermesError("");
    setHermesProjectIds([]);
    setHermesAvatarSeed(crypto.randomUUID().replaceAll("-", ""));
    setNewHermesOpen(true);
  };
  const createHermesAgent = async (): Promise<void> => {
    if (!currentCompany) return;
    setHermesError("");
    try {
      const result = await readJson<{
        agent: ApiHermesAgent;
        pairingCode: string;
        expiresAt: string;
      }>("/api/admin/hermes-agents", {
        method: "POST",
        body: JSON.stringify({
          name: hermesName.trim(),
          companyId: currentCompany.id,
          projectIds: hermesProjectIds,
          avatarSeed: hermesAvatarSeed,
        }),
      });
      setNewHermesOpen(false);
      showPairingCode(result, result.agent.name);
      await reload();
    } catch (error) {
      setHermesError(
        error instanceof Error ? error.message : "Unable to add Hermes agent",
      );
    }
  };
  const reissueHermesPairing = async (agent: ApiHermesAgent): Promise<void> => {
    try {
      const result = await readJson<{ pairingCode: string; expiresAt: string }>(
        `/api/admin/hermes-agents/${encodeURIComponent(agent.id)}/pairing-code`,
        { method: "POST", body: "{}" },
      );
      showPairingCode(result, agent.name);
      await reload();
    } catch {
      setError("Unable to reissue pairing code");
    }
  };
  const rotateHermesAgent = async (agent: ApiHermesAgent): Promise<void> => {
    try {
      const result = await readJson<{ pairingCode: string; expiresAt: string }>(
        `/api/admin/hermes-agents/${encodeURIComponent(agent.id)}/rotate`,
        { method: "POST", body: "{}" },
      );
      showPairingCode(result, agent.name);
      await reload();
    } catch {
      setError("Unable to rotate Hermes agent");
    }
  };
  const revokeHermesAgent = async (agent: ApiHermesAgent): Promise<void> => {
    const action = `hermes:revoke:${agent.id}`;
    if (pendingAction !== action) {
      setPendingAction(action);
      return;
    }
    try {
      await readJson(
        `/api/admin/hermes-agents/${encodeURIComponent(agent.id)}/revoke`,
        { method: "POST", body: "{}" },
      );
      setPendingAction("");
      await reload();
    } catch {
      setError("Unable to revoke Hermes agent");
    }
  };
  const openEditHermesProjects = (agent: ApiHermesAgent): void => {
    setEditingHermesAgent(agent);
    setEditingHermesProjectIds([...agent.projectIds]);
    setEditProjectsModalOpen(true);
  };
  const saveHermesProjects = async (): Promise<void> => {
    if (!editingHermesAgent) return;
    try {
      await readJson<{ agent: ApiHermesAgent }>(
        `/api/admin/hermes-agents/${encodeURIComponent(editingHermesAgent.id)}/projects`,
        {
          method: "PUT",
          body: JSON.stringify({ projectIds: editingHermesProjectIds }),
        },
      );
      setEditProjectsModalOpen(false);
      setEditingHermesAgent(null);
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
  const copyHermesSetupInstructions = async (): Promise<void> => {
    const instructions = hermesSetupInstructions(
      pairingCodeData,
      hermesProfileName,
    );
    if (!instructions) return;
    try {
      await navigator.clipboard.writeText(instructions);
      setPairingInstructionsCopied(true);
    } catch {
      setPairingInstructionsCopied(false);
      setError("Unable to copy Hermes setup instructions");
    }
  };
  return {
    openNewHermesAgent,
    createHermesAgent,
    reissueHermesPairing,
    rotateHermesAgent,
    revokeHermesAgent,
    openEditHermesProjects,
    saveHermesProjects,
    copyPairingCode,
    copyHermesSetupInstructions,
  };
}
