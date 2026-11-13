import { useEffect, useState, type ReactElement } from "react";

import { useUpdate } from "../../components/app/update-provider.js";
import { Button } from "../../components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import type { UpdateChannel } from "../../contracts/generated/UpdateChannel.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { getEnvironmentSettings, updateEnvironmentSettings } from "./lib/environment-api.js";
import { SettingRow, SettingsSection } from "./settings-layout.js";

const CHANNELS = [{ value: "stable", label: "Stable" }, { value: "dev", label: "Development" }] satisfies { value: UpdateChannel; label: string }[];

export function UpdateSettings(): ReactElement {
  const { update, requesting, refresh, restart } = useUpdate();
  const admin = useOptionalCompanyContext()?.user?.role === "admin";
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
    : update?.availableVersion
      ? `Version ${update.availableVersion}`
      : update?.availableRevision
        ? `Revision ${update.availableRevision.slice(0, 12)}`
        : update?.currentVersion
          ? `Version ${update.currentVersion}`
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
      {admin ? <UpdateChannelSetting onChange={() => void refresh(true)} /> : null}
      {canApply ? (
        <SettingRow label={retry ? "Retry the update" : "Restart Suplex"} description={retry ? "Suplex retries the host update." : "Suplex applies the update and restarts the host."}>
          <Button type="button" size="sm" onClick={() => void restart()} disabled={requesting || busy}>{retry ? "Retry" : "Restart Suplex"}</Button>
        </SettingRow>
      ) : null}
    </SettingsSection>
  );
}

/** The release channel the host update check and `suplex update` read. Administrators only. */
export function UpdateChannelSetting({ onChange }: { onChange?: () => void }): ReactElement {
  const [channel, setChannel] = useState<UpdateChannel | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void getEnvironmentSettings()
      .then(settings => setChannel(settings.updateChannel))
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "Suplex could not read the update channel."));
  }, []);

  const select = async (next: UpdateChannel): Promise<void> => {
    const previous = channel;
    setChannel(next);
    setError("");
    try {
      setChannel((await updateEnvironmentSettings({ updateChannel: next })).updateChannel);
      onChange?.();
    } catch (reason) {
      setChannel(previous);
      setError(reason instanceof Error ? reason.message : "Suplex could not save the update channel.");
    }
  };

  return (
    <SettingRow
      label="Update channel"
      htmlFor="update-channel"
      description={error || "Development also offers interim builds. If you change to Stable, Suplex keeps the current build until a stable version is newer."}
    >
      <Select items={CHANNELS} value={channel} onValueChange={next => { if (next) void select(next); }} disabled={channel === null}>
        <SelectTrigger id="update-channel" size="sm"><SelectValue /></SelectTrigger>
        <SelectContent>{CHANNELS.map(option => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
      </Select>
    </SettingRow>
  );
}
