import type { ReactElement } from "react";

import type { UpdateOperationStatus } from "../../../http/contracts/update.js";
import { useUpdate } from "../../components/app/update-provider.js";
import { Button } from "../../components/ui/button.js";
import { SettingRow, SettingsSection } from "./settings-layout.js";

function operationStatusLabel(status: UpdateOperationStatus["status"]): string {
  if (status === "pending") return "Accepted";
  if (status === "preparing") return "In progress";
  if (status === "restarting") return "Restart in progress";
  if (status === "succeeded") return "Succeeded";
  return "Failed";
}

function attemptTime(timestamp: string): string {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(timestamp));
}

export function UpdateSettings(): ReactElement {
  const { update, requesting, refresh, restart } = useUpdate();
  const operation = update?.operation;
  const operationPending = operation?.status === "pending" || operation?.status === "preparing" || operation?.status === "restarting";
  const failedTarget = operation?.status === "failed" && update?.currentRevision !== operation.targetRevision
    ? operation.targetRevision
    : undefined;
  const restartRevision = update?.available ? update.revision : failedTarget;
  const retriesFailedTarget = Boolean(failedTarget && restartRevision === failedTarget);
  const availability = update ? update.available ? "Update available" : "No update available" : "Update status not available";
  const availabilityDescription = update?.available && update.revision ? `Revision ${update.revision.slice(0, 12)}` : undefined;
  const operationDescription = operation?.error ?? operation?.message;

  return (
    <SettingsSection title="Forge update">
      <SettingRow label="Availability" {...(availabilityDescription ? { description: availabilityDescription } : {})}>
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">{availability}</span>
          <Button type="button" variant="outline" size="xs" onClick={() => void refresh()}>Check</Button>
        </div>
      </SettingRow>
      {operation ? (
        <SettingRow label="Last attempt" {...(operationDescription ? { description: operationDescription } : {})}>
          <div className="text-right text-xs">
            <div>{operationStatusLabel(operation.status)}</div>
            <time className="text-muted-foreground" dateTime={operation.updatedAt}>{attemptTime(operation.updatedAt)}</time>
          </div>
        </SettingRow>
      ) : null}
      {restartRevision && update?.canRestart ? (
        <SettingRow
          label={retriesFailedTarget ? "Retry the update" : "Restart Forge"}
          description={retriesFailedTarget ? "Forge checks for an update and retries the restart." : "Forge installs the available revision and restarts."}
        >
          <Button type="button" size="sm" onClick={() => void restart(restartRevision)} disabled={requesting || operationPending}>
            {operationPending ? "Restart in progress" : retriesFailedTarget ? "Retry" : "Restart Forge"}
          </Button>
        </SettingRow>
      ) : null}
    </SettingsSection>
  );
}
