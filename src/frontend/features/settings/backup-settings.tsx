import { useEffect, useState, type ReactElement } from "react";

import { SettingsContent, SettingsLayout, SettingRow, SettingsSection } from "./settings-layout.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJson, withCompany } from "../../lib/api.js";

type Backup = { name: string; bytes: number; createdAt: string };

const megabytes = new Intl.NumberFormat(undefined, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });
const downloadUrl = (name: string): string => `/api/admin/backups/${encodeURIComponent(name)}`;

export function BackupSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    void readJson<{ backups: Backup[] }>("/api/admin/backups")
      .then((response) => setBackups(response.backups))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Backups could not be loaded"));
  }, []);

  const create = async (): Promise<void> => {
    setCreating(true);
    setMessage("");
    try {
      const backup = await readJson<Backup>("/api/admin/backups", { method: "POST" });
      setBackups((current) => [backup, ...(current ?? [])]);
      window.location.assign(downloadUrl(backup.name));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The backup could not be created");
    } finally {
      setCreating(false);
    }
  };
  const createButton = <Button size="sm" onClick={() => void create()} disabled={creating}>{creating ? "Creating…" : "Create backup"}</Button>;

  return <SettingsLayout title="Backups" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/backups", companyId)}>
    <SettingsContent>
      <SettingsSection title="Backups" description="Each backup contains the database, artifacts and non-secret configuration. Credentials and passkeys are excluded, so a restore requires signing in again.">
        {backups?.length === 0 ? <SettingRow label="No backups yet" description="Create one to download a copy of this Suplex host's data.">{createButton}</SettingRow> : null}
        {backups?.length ? <>
          <SettingRow label="New backup" description="Creates a backup on the host and downloads it.">{createButton}</SettingRow>
          {backups.map((backup) => <SettingRow key={backup.name} label={new Date(backup.createdAt).toLocaleString()} description={`${megabytes.format(backup.bytes / 1_000_000)} · ${backup.name}`}>
            <a className={buttonVariants({ variant: "outline", size: "sm" })} href={downloadUrl(backup.name)}>Download</a>
          </SettingRow>)}
        </> : null}
      </SettingsSection>
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
    </SettingsContent>
  </SettingsLayout>;
}
