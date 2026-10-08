import { useEffect, useRef, useState, type ReactElement } from "react";

import { SettingsContent, SettingsLayout, SettingRow, SettingsSection } from "./settings-layout.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Button, buttonVariants } from "../../components/ui/button.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { readJsonUnchecked, withCompany } from "../../lib/api.js";

type Backup = { name: string; bytes: number; createdAt: string };

const megabytes = new Intl.NumberFormat(undefined, { style: "unit", unit: "megabyte", maximumFractionDigits: 1 });
const downloadUrl = (name: string): string => `/api/admin/backups/${encodeURIComponent(name)}`;

export function BackupSettingsView(): ReactElement {
  const { currentCompany } = useCompanyContext();
  const companyId = currentCompany?.id ?? "";
  const [backups, setBackups] = useState<Backup[] | null>(null);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState("");
  const fileInput = useRef<HTMLInputElement>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restoring, setRestoring] = useState(false);

  useEffect(() => {
    void readJsonUnchecked<{ backups: Backup[] }>("/api/admin/backups")
      .then((response) => setBackups(response.backups))
      .catch((error: unknown) => setMessage(error instanceof Error ? error.message : "Backups could not be loaded"));
  }, []);

  const create = async (): Promise<void> => {
    setCreating(true);
    setMessage("");
    try {
      const backup = await readJsonUnchecked<Backup>("/api/admin/backups", { method: "POST" });
      setBackups((current) => [backup, ...(current ?? [])]);
      window.location.assign(downloadUrl(backup.name));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The backup could not be created");
    } finally {
      setCreating(false);
    }
  };
  const restore = async (file: File): Promise<void> => {
    setRestoring(true);
    setMessage("");
    try {
      await readJsonUnchecked("/api/admin/backups/restore", { method: "POST", body: file, headers: { "Content-Type": "application/gzip" } });
      window.location.reload(); // every page now shows restored data
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The backup could not be restored");
      setRestoring(false);
      setRestoreFile(null);
    }
  };
  const createButton = <Button size="sm" onClick={() => void create()} disabled={creating}>{creating ? "Creating…" : "Create backup"}</Button>;

  return <SettingsLayout title="Backups" companyId={companyId} backHref={withCompany("/", companyId)} activeHref={withCompany("/admin/backups", companyId)}>
    <SettingsContent title="Backups" description="Each backup contains the database, artifacts and non-secret configuration. Credentials are not in the backup.">
      <SettingsSection>
        {backups?.length === 0 ? <SettingRow label="No backups yet" description="Create one to download a copy of this Suplex host's data.">{createButton}</SettingRow> : null}
        {backups?.length ? <>
          <SettingRow label="New backup" description="Creates a backup on the host and downloads it.">{createButton}</SettingRow>
          {backups.map((backup) => <SettingRow key={backup.name} label={new Date(backup.createdAt).toLocaleString()} description={`${megabytes.format(backup.bytes / 1_000_000)} · ${backup.name}`}>
            <a className={buttonVariants({ variant: "outline", size: "sm" })} href={downloadUrl(backup.name)}>Download</a>
          </SettingRow>)}
        </> : null}
      </SettingsSection>
      <SettingsSection title="Restore">
        <SettingRow label="Restore from a file" description="Suplex replaces the data on this host with the data in a backup file.">
          <input ref={fileInput} type="file" accept=".gz,application/gzip" hidden onChange={(event) => { setRestoreFile(event.target.files?.[0] ?? null); event.target.value = ""; }} />
          <Button size="sm" variant="outline" onClick={() => fileInput.current?.click()} disabled={restoring}>Select a file</Button>
        </SettingRow>
      </SettingsSection>
      <AlertDialog open={restoreFile !== null} onOpenChange={(open) => { if (!open && !restoring) setRestoreFile(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Restore {restoreFile?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Suplex replaces all tasks, projects and settings on this host with the data in this backup. Suplex keeps your users. You cannot undo this.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={restoring}>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={restoring} onClick={() => { if (restoreFile) void restore(restoreFile); }}>{restoring ? "Restoring…" : "Restore"}</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {message ? <p className="text-xs text-muted-foreground" role="status">{message}</p> : null}
    </SettingsContent>
  </SettingsLayout>;
}
