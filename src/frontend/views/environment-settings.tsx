import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import { SettingsContent, SettingsLayout, SettingRow, SettingsSection } from "../components/app/settings-layout.js";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { useCompanyContext } from "../components/app/company-context.js";
import { readJson, withCompany } from "../lib/api.js";

type EnvironmentSettings = { minFreeDiskGb: number };

export function EnvironmentSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [minFreeDiskGb, setMinFreeDiskGb] = useState("5");
  const [savedMinFreeDiskGb, setSavedMinFreeDiskGb] = useState<number | null>(null);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void readJson<EnvironmentSettings>("/api/admin/environment")
      .then((settings) => { setMinFreeDiskGb(String(settings.minFreeDiskGb)); setSavedMinFreeDiskGb(settings.minFreeDiskGb); })
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Environment settings could not be loaded"));
  }, []);

  const parsed = Number(minFreeDiskGb);
  const valid = minFreeDiskGb.trim() !== "" && Number.isFinite(parsed) && parsed >= 0 && parsed <= 1024;
  const changed = valid && parsed !== savedMinFreeDiskGb;
  const save = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (!changed) return;
    setSaving(true);
    setMessage("");
    try {
      const settings = await readJson<EnvironmentSettings>("/api/admin/environment", { method: "PATCH", body: JSON.stringify({ minFreeDiskGb: parsed }) });
      setMinFreeDiskGb(String(settings.minFreeDiskGb));
      setSavedMinFreeDiskGb(settings.minFreeDiskGb);
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
      {!valid ? <p className="text-xs text-destructive" role="alert">Enter a value from 0 to 1024 GB.</p> : null}
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
    </SettingsContent>
  </SettingsLayout>;
}
