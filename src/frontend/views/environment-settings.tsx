import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import { SettingsContent, SettingsLayout, SettingRow, SettingsSection } from "../components/app/settings-layout.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { readJson, withCompany } from "../lib/api.js";

type EnvironmentSettings = { minFreeDiskGb: number; defaultBudgetUsd: number; defaultMaxTurns: number };

export function EnvironmentSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [minFreeDiskGb, setMinFreeDiskGb] = useState("5");
  const [savedMinFreeDiskGb, setSavedMinFreeDiskGb] = useState<number | null>(null);
  const [defaultBudgetUsd, setDefaultBudgetUsd] = useState("15");
  const [savedDefaultBudgetUsd, setSavedDefaultBudgetUsd] = useState<number | null>(null);
  const [defaultMaxTurns, setDefaultMaxTurns] = useState("40");
  const [savedDefaultMaxTurns, setSavedDefaultMaxTurns] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void readJson<EnvironmentSettings>("/api/admin/environment")
      .then((settings) => { setMinFreeDiskGb(String(settings.minFreeDiskGb)); setSavedMinFreeDiskGb(settings.minFreeDiskGb); setDefaultBudgetUsd(String(settings.defaultBudgetUsd)); setSavedDefaultBudgetUsd(settings.defaultBudgetUsd); setDefaultMaxTurns(String(settings.defaultMaxTurns)); setSavedDefaultMaxTurns(settings.defaultMaxTurns); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Environment settings could not be loaded"));
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
      const settings = await readJson<EnvironmentSettings>("/api/admin/environment", { method: "PATCH", body: JSON.stringify({ minFreeDiskGb: parsed, defaultBudgetUsd: parsedBudget, defaultMaxTurns: parsedMaxTurns }) });
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

  return <SettingsLayout title="Environment" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/environment", companyId)}>
    <SettingsContent>
      <SettingsSection title="Worktrees" description="Host-wide limits applied before Forge creates or changes a worktree.">
        <SettingRow label="Minimum free disk space" description="Block worktree operations when available space falls below this threshold.">
          <form className="flex items-center gap-2" onSubmit={(event) => void save(event)}>
            <div className="w-28"><Input aria-label="Minimum free disk space in GB" type="number" min="0" max="1024" step="0.1" inputMode="decimal" value={minFreeDiskGb} onChange={(event) => { setMinFreeDiskGb(event.target.value); setMessage(""); }} /></div>
            <span className="text-xs text-muted-foreground">GB</span>
            <Button size="sm" type="submit" disabled={!changed || saving}>{saving ? "Saving…" : "Save"}</Button>
          </form>
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Task limits" description="Host-wide limits applied before Forge dispatches a task prompt.">
        <form className="space-y-2" onSubmit={(event) => void save(event)}>
          <SettingRow label="Default task budget" description="Pause a task when its estimated spend reaches this amount.">
            <div className="flex items-center gap-2">
              <div className="w-28"><Input aria-label="Default task budget in USD" type="number" min="0" step="0.01" inputMode="decimal" value={defaultBudgetUsd} onChange={(event) => { setDefaultBudgetUsd(event.target.value); setMessage(""); }} /></div>
              <span className="text-xs text-muted-foreground">USD</span>
            </div>
          </SettingRow>
          <SettingRow label="Default maximum turns" description="Pause a task when its Coordinator and Worker turns reach this count.">
            <div className="flex items-center gap-2">
              <div className="w-28"><Input aria-label="Default maximum task turns" type="number" min="0" step="1" inputMode="numeric" value={defaultMaxTurns} onChange={(event) => { setDefaultMaxTurns(event.target.value); setMessage(""); }} /></div>
              <span className="text-xs text-muted-foreground">Turns</span>
            </div>
          </SettingRow>
          <Button size="sm" type="submit" disabled={!changed || saving}>{saving ? "Saving…" : "Save"}</Button>
        </form>
      </SettingsSection>
      {!validDisk ? <p className="text-xs text-destructive" role="alert">Enter a value from 0 to 1024 GB.</p> : null}
      {!validBudget ? <p className="text-xs text-destructive" role="alert">Enter a budget of 0 USD or more.</p> : null}
      {!validMaxTurns ? <p className="text-xs text-destructive" role="alert">Enter a whole number of 0 or more turns.</p> : null}
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
    </SettingsContent>
  </SettingsLayout>;
}
