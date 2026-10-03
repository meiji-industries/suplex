import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import { SettingsContent, SettingsLayout, SettingRow, SettingsSection } from "./settings-layout.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Switch } from "../../components/ui/switch.js";
import { setExperiments } from "../../shell/experiments-api.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { withCompany } from "../../lib/api.js";
import { getEnvironmentSettings, updateEnvironmentSettings, type EnvironmentSettings } from "./lib/environment-api.js";
import { getTelemetry, notifyTelemetryChanged, updateTelemetryReplay } from "../../shell/telemetry-api.js";

type ExperimentSettings = Pick<EnvironmentSettings, "todayPageEnabled" | "git2Enabled" | "telemetryEnabled">;

export function EnvironmentSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [minFreeDiskGb, setMinFreeDiskGb] = useState("5");
  const [savedMinFreeDiskGb, setSavedMinFreeDiskGb] = useState<number | null>(null);
  const [defaultBudgetUsd, setDefaultBudgetUsd] = useState("15");
  const [savedDefaultBudgetUsd, setSavedDefaultBudgetUsd] = useState<number | null>(null);
  const [defaultMaxTurns, setDefaultMaxTurns] = useState("40");
  const [savedDefaultMaxTurns, setSavedDefaultMaxTurns] = useState<number | null>(null);
  const [experimentSettings, setExperimentSettings] = useState<ExperimentSettings | null>(null);
  const [sessionReplay, setSessionReplay] = useState(false);
  const [sessionReplayReady, setSessionReplayReady] = useState(false);
  const [sessionReplayMessage, setSessionReplayMessage] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void getEnvironmentSettings()
      .then((settings) => { setMinFreeDiskGb(String(settings.minFreeDiskGb)); setSavedMinFreeDiskGb(settings.minFreeDiskGb); setDefaultBudgetUsd(String(settings.defaultBudgetUsd)); setSavedDefaultBudgetUsd(settings.defaultBudgetUsd); setDefaultMaxTurns(String(settings.defaultMaxTurns)); setSavedDefaultMaxTurns(settings.defaultMaxTurns); setExperimentSettings({ todayPageEnabled: settings.todayPageEnabled, git2Enabled: settings.git2Enabled, telemetryEnabled: settings.telemetryEnabled }); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Environment settings could not be loaded"));
    void getTelemetry()
      .then((telemetry) => { setSessionReplay(telemetry.sessionReplayEnabled); setSessionReplayReady(true); })
      .catch(() => setSessionReplayMessage("Session replay setting could not be loaded"));
  }, []);

  const parsed = Number(minFreeDiskGb);
  const parsedBudget = Number(defaultBudgetUsd);
  const parsedMaxTurns = Number(defaultMaxTurns);
  const validDisk = minFreeDiskGb.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1024;
  const validBudget = defaultBudgetUsd.trim() !== "" && Number.isFinite(parsedBudget) && parsedBudget >= 0;
  const validMaxTurns = defaultMaxTurns.trim() !== "" && Number.isInteger(parsedMaxTurns) && parsedMaxTurns >= 0;
  const valid = validDisk && validBudget && validMaxTurns;
  const changed = valid && (parsed !== savedMinFreeDiskGb || parsedBudget !== savedDefaultBudgetUsd || parsedMaxTurns !== savedDefaultMaxTurns);
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!changed) return;
    setSaving(true);
    setMessage("");
    try {
      const settings = await updateEnvironmentSettings({ minFreeDiskGb: parsed, defaultBudgetUsd: parsedBudget, defaultMaxTurns: parsedMaxTurns });
      setMinFreeDiskGb(String(settings.minFreeDiskGb));
      setSavedMinFreeDiskGb(settings.minFreeDiskGb);
      setDefaultBudgetUsd(String(settings.defaultBudgetUsd));
      setSavedDefaultBudgetUsd(settings.defaultBudgetUsd);
      setDefaultMaxTurns(String(settings.defaultMaxTurns));
      setSavedDefaultMaxTurns(settings.defaultMaxTurns);
      setMessage("Environment settings saved");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Environment settings could not be saved");
    } finally {
      setSaving(false);
    }
  };

  const toggleExperiment = async (key: keyof ExperimentSettings, enabled: boolean): Promise<void> => {
    setExperimentSettings((current) => current && { ...current, [key]: enabled });
    setMessage("");
    try {
      const settings = await updateEnvironmentSettings({ [key]: enabled });
      setExperimentSettings({ todayPageEnabled: settings.todayPageEnabled, git2Enabled: settings.git2Enabled, telemetryEnabled: settings.telemetryEnabled });
      setExperiments({ todayPage: settings.todayPageEnabled, hostTerminal: settings.hostTerminalEnabled });
      if (key === "telemetryEnabled") notifyTelemetryChanged();
    } catch (error) {
      setExperimentSettings((current) => current && { ...current, [key]: !enabled });
      setMessage(error instanceof Error ? error.message : "Environment settings could not be saved");
    }
  };

  const toggleSessionReplay = async (enabled: boolean): Promise<void> => {
    setSessionReplay(enabled);
    setSessionReplayMessage("");
    try {
      await updateTelemetryReplay(enabled);
    } catch (error) {
      setSessionReplay(!enabled);
      setSessionReplayMessage(error instanceof Error ? error.message : "Session replay setting could not be saved");
    }
  };

  return <SettingsLayout title="Environment" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/environment", companyId)}>
    <SettingsContent title="Environment">
      <SettingsSection title="Worktrees" description="Host-wide limits applied before Suplex creates or changes a worktree.">
        <SettingRow label="Minimum free disk space" description="Block worktree operations when available space falls below this threshold.">
          <form className="flex items-center gap-2" onSubmit={(event) => void save(event)}>
            <div className="w-28"><Input size="sm" aria-label="Minimum free disk space in GB" type="number" min="0" max="1024" step="0.1" inputMode="decimal" value={minFreeDiskGb} onChange={(event) => { setMinFreeDiskGb(event.target.value); setMessage(""); }} /></div>
            <span className="text-xs text-muted-foreground">GB</span>
            <Button size="sm" type="submit" disabled={!changed || saving}>{saving ? "Saving…" : "Save"}</Button>
          </form>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Task limits" description="These defaults apply to tasks without task-specific limits. Suplex checks each limit before it dispatches a new prompt.">
        <form className="space-y-2" onSubmit={(event) => void save(event)}>
          <SettingRow label="Default task budget" description="Pause a task when its estimated spend reaches this amount.">
            <div className="flex items-center gap-2">
              <div className="w-28"><Input size="sm" aria-label="Default task budget in USD" type="number" min="0" step="0.01" inputMode="decimal" value={defaultBudgetUsd} onChange={(event) => { setDefaultBudgetUsd(event.target.value); setMessage(""); }} /></div>
              <span className="text-xs text-muted-foreground">USD</span>
            </div>
          </SettingRow>
          <SettingRow label="Default maximum turns" description="Pause a task when all admitted agent turns reach this count.">
            <div className="flex items-center gap-2">
              <div className="w-28"><Input size="sm" aria-label="Default maximum task turns" type="number" min="0" step="1" inputMode="numeric" value={defaultMaxTurns} onChange={(event) => { setDefaultMaxTurns(event.target.value); setMessage(""); }} /></div>
              <span className="text-xs text-muted-foreground">Turns</span>
            </div>
          </SettingRow>
          <Button size="sm" type="submit" disabled={!changed || saving}>{saving ? "Saving…" : "Save"}</Button>
          <p className="text-xs text-muted-foreground">Set a limit to 0 to disable it. A native turn already in progress can finish before Suplex pauses.</p>
        </form>
      </SettingsSection>
      <SettingsSection title="Experiments" description="Try features that are not complete. Each setting applies to all users on this host.">
        <SettingRow label="Today page" description="Show the Today page in the navigation." htmlFor="experiment-today-page">
          <Switch id="experiment-today-page" checked={experimentSettings?.todayPageEnabled ?? false} disabled={experimentSettings === null} onCheckedChange={(checked) => void toggleExperiment("todayPageEnabled", checked)} />
        </SettingRow>
        <SettingRow label="Built-in Git" description="Suplex uses libgit2 and the GitHub sign-in to clone, fetch, and push. When this is off, Suplex uses the Git on this host and its credentials." htmlFor="experiment-git2">
          <Switch id="experiment-git2" checked={experimentSettings?.git2Enabled ?? false} disabled={experimentSettings === null} onCheckedChange={(checked) => void toggleExperiment("git2Enabled", checked)} />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Usage data" description="Suplex sends usage events, app details, and sanitized errors to PostHog. Suplex does not send code, prompts, repository names, or file paths.">
        <SettingRow label="Send usage data" description="This setting applies to all users on this host. DO_NOT_TRACK=1 also stops it." htmlFor="telemetry-enabled">
          <Switch id="telemetry-enabled" checked={experimentSettings?.telemetryEnabled ?? false} disabled={experimentSettings === null} onCheckedChange={(checked) => void toggleExperiment("telemetryEnabled", checked)} />
        </SettingRow>
        <SettingRow label="Record session replays" description="PostHog records masked screen activity. Suplex masks all text and inputs and excludes terminal, code, prompt, and image content." htmlFor="telemetry-session-replay">
          <Switch id="telemetry-session-replay" checked={sessionReplay} disabled={!sessionReplayReady} onCheckedChange={(checked) => void toggleSessionReplay(checked)} />
        </SettingRow>
        {sessionReplayMessage ? <p className="text-xs text-muted-foreground" role="status">{sessionReplayMessage}</p> : null}
      </SettingsSection>
      {!validDisk ? <p className="text-xs text-destructive" role="alert">Enter a value from 0 to 1024 GB.</p> : null}
      {!validBudget ? <p className="text-xs text-destructive" role="alert">Enter a budget of 0 USD or more.</p> : null}
      {!validMaxTurns ? <p className="text-xs text-destructive" role="alert">Enter a whole number of 0 or more turns.</p> : null}
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
    </SettingsContent>
  </SettingsLayout>;
}
