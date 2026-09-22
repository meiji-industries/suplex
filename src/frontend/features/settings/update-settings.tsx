import type { ReactElement } from "react";

import { useUpdate } from "../../components/app/update-provider.js";
import { Button } from "../../components/ui/button.js";
import { SettingRow, SettingsSection } from "./settings-layout.js";

export function UpdateSettings(): ReactElement {
  const { update, requesting, refresh, restart } = useUpdate();
  const status = update?.status;
  const busy = status?.kind === "checking" || status?.kind === "applying";
  const retry = status?.kind === "failed" && status.action === "apply";
  const canApply = update?.canRestart && (status?.kind === "available" || retry);
  const statusLabel = !status ? "Status not available"
    : status.kind === "idle" ? "Not checked"
      : status.kind === "checking" ? "Check in progress"
        : status.kind === "current" ? "Suplex is current"
          : status.kind === "available" ? "Update available"
            : status.kind === "applying" ? status.message
              : status.message;
  const description = status?.kind === "failed"
    ? status.error
    : update?.availableRevision
      ? `Revision ${update.availableRevision.slice(0, 12)}`
      : update?.currentRevision
        ? `Revision ${update.currentRevision.slice(0, 12)}`
        : undefined;

  return (
    <SettingsSection title="Suplex host update">
      <SettingRow label="Status" {...(description ? { description } : {})}>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{statusLabel}</span>
          <Button type="button" variant="outline" size="xs" onClick={() => void refresh(true)} disabled={busy}>Check</Button>
        </div>
      </SettingRow>
      {canApply ? (
        <SettingRow label={retry ? "Retry the update" : "Restart Suplex"} description={retry ? "Suplex retries the host update." : "Suplex applies the update and restarts the host."}>
          <Button type="button" size="sm" onClick={() => void restart()} disabled={requesting || busy}>{retry ? "Retry" : "Restart Suplex"}</Button>
        </SettingRow>
      ) : null}
    </SettingsSection>
  );
}
