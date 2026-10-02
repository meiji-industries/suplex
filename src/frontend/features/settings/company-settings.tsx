import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { AvatarEditor } from "../../components/app/entity-avatar.js";
import { SettingsContent, SettingsLayout, SettingsSection, SettingRow } from "./settings-layout.js";
import { companySettingsPath, readJsonUnchecked, withCompany, type CompanyStatus } from "../../lib/api.js";
import { Archive, Building2, RotateCcw, Save, Pause, Trash2 } from "lucide-react";
import { EmptyState } from "../../components/app/empty-state.js";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { LoadingState } from "../../components/app/loading-state.js";

export function CompanySettingsView(): ReactElement {
  const { user, companies, currentCompany, loading, selectCompany, renameCompany, setCompanyIssueCode, setCompanyStatus } = useCompanyContext();
  const [name, setName] = useState("");
  const [issueCode, setIssueCode] = useState("");
  const [busy, setBusy] = useState("");
  const [saved, setSaved] = useState(false);
  const [codeSaved, setCodeSaved] = useState(false);
  const [error, setError] = useState("");
  const [archiveOpen, setArchiveOpen] = useState(false);
  const [clearOpen, setClearOpen] = useState(false);
  const pathId = useMemo(() => {
    const match = /^\/companies\/([^/]+)\/settings$/.exec(window.location.pathname);
    if (!match?.[1]) return "";
    try { return decodeURIComponent(match[1]); } catch { return ""; }
  }, []);
  const company = companies.find((candidate) => candidate.id === pathId);

  useEffect(() => {
    if (company && company.id !== currentCompany?.id) selectCompany(company.id);
  }, [company, currentCompany?.id, selectCompany]);
  useEffect(() => { setName(company?.name ?? ""); setIssueCode(company?.issueCode ?? ""); setSaved(false); setCodeSaved(false); }, [company?.id]);

  const notFound = !loading && (user?.role !== "admin" || !company);
  if (loading) {
    return <ApplicationFrame title="Company settings"><LoadingState /></ApplicationFrame>;
  }
  if (notFound || !company) {
    return <ApplicationFrame title="Company settings"><EmptyState icon={Building2} title="Company not found" action={<Button variant="outline" size="sm" nativeButton={false} render={<a href={withCompany("/projects", currentCompany?.id)} />}>Back to Projects</Button>} /></ApplicationFrame>;
  }

  const mutateStatus = async (status: CompanyStatus): Promise<void> => {
    setBusy(status); setError("");
    try { await setCompanyStatus(company.id, status); setArchiveOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update company"); }
    finally { setBusy(""); }
  };
  const save = async (): Promise<void> => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === company.name || busy) return;
    setBusy("rename"); setError(""); setSaved(false);
    try { await renameCompany(company.id, trimmed); setSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to rename company"); }
    finally { setBusy(""); }
  };
  const clearAccount = async (): Promise<void> => {
    setBusy("clear"); setError("");
    try { await readJsonUnchecked("/api/admin/factory-reset", { method: "POST", body: "{}" }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to factory reset"); setBusy(""); setClearOpen(false); return; }
    window.localStorage.clear();
    window.sessionStorage.clear();
    // The desktop app closes and its next start shows the choice screen. A browser starts onboarding now.
    if (window.suplexApp) await window.suplexApp.accountCleared(); else window.location.assign("/");
  };
  const saveIssueCode = async (): Promise<void> => {
    const normalized = issueCode.trim().toUpperCase();
    const next = normalized || null;
    if (next === company.issueCode || busy) return;
    setBusy("issue-code"); setError(""); setCodeSaved(false);
    try { const updated = await setCompanyIssueCode(company.id, next); setIssueCode(updated.issueCode ?? ""); setCodeSaved(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to update issue code"); }
    finally { setBusy(""); }
  };

  const backHref = withCompany("/projects", company.id);
  const avatarName = name.trim() || company.name;

  return (
    <SettingsLayout title="Workspace" companyId={company.id} backHref={backHref} activeHref={companySettingsPath(company.id)}>
      <SettingsContent title="Workspace">
      <SettingsSection title="Profile">
        <SettingRow label="Company name" description="Public workspace name.">
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Input size="sm" id="company-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
            <Button type="submit" size="sm" disabled={busy !== "" || !name.trim() || name.trim() === company.name}><Save className="size-3.5" />{busy === "rename" ? "Saving…" : saved ? "Saved" : "Save"}</Button>
          </form>
        </SettingRow>
        <SettingRow label="Avatar" description="Shown in the company switcher.">
          <AvatarEditor kind="company" id={company.id} name={avatarName} seed={avatarName} />
        </SettingRow>
        <SettingRow label="Issue code" description="2–10 letters or numbers, beginning with a letter. Once set, it locks after the company has an issue.">
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void saveIssueCode(); }}>
            <Input size="sm" id="company-issue-code" aria-label="Issue code" maxLength={10} pattern="[A-Za-z][A-Za-z0-9]{1,9}" placeholder="ADAM" value={issueCode} onChange={(event) => { setIssueCode(event.target.value.toUpperCase()); setCodeSaved(false); }} />
            <Button type="submit" size="sm" disabled={busy !== "" || (issueCode.trim().toUpperCase() || null) === company.issueCode}><Save className="size-3.5" />{busy === "issue-code" ? "Saving…" : codeSaved ? "Saved" : "Save"}</Button>
          </form>
        </SettingRow>
        <SettingRow label="Company ID" description="Unique identifier.">
          <code className="select-all text-xs text-muted-foreground">{company.id}</code>
        </SettingRow>
        <SettingRow label="Created">
          <span className="text-xs text-muted-foreground">{new Date(company.createdAt).toLocaleDateString()}</span>
        </SettingRow>
       </SettingsSection>
       {error ? <div className="mb-4 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      <SettingsSection title="Lifecycle" description="Control workspace activity.">
        {company.status === "active" ? <SettingRow label="Pause company" description="Existing records remain available; new projects and tasks are blocked."><Button variant="outline" size="sm" onClick={() => void mutateStatus("paused")} disabled={busy !== ""}><Pause className="size-3.5" />{busy === "paused" ? "Pausing…" : "Pause company"}</Button></SettingRow> : null}
        {company.status === "paused" ? <SettingRow label="Reactivate company" description="Restore creation of new projects and tasks."><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Reactivating…" : "Reactivate company"}</Button></SettingRow> : null}
        {company.status !== "archived" ? <SettingRow label="Archive company" description="Archive is reversible, retains history, and blocks new work." destructive><Button variant="destructive" size="sm" onClick={() => setArchiveOpen(true)} disabled={busy !== ""}><Archive className="size-3.5" />Archive company</Button></SettingRow> : null}
        {company.status === "archived" ? <SettingRow label="Restore company" description="Restore the company to active status."><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Restoring…" : "Restore company"}</Button></SettingRow> : null}
        <SettingRow label="Factory reset" description="Delete all Suplex data on this host and start onboarding again." destructive><Button variant="destructive" size="sm" onClick={() => setClearOpen(true)} disabled={busy !== ""}><Trash2 className="size-3.5" />Factory reset</Button></SettingRow>
      </SettingsSection>
      </SettingsContent>
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive {company.name}?</AlertDialogTitle><AlertDialogDescription>You can reverse this action. You can read the project and task history, but you cannot start new work.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void mutateStatus("archived")} disabled={busy !== ""}>{busy === "archived" ? "Archiving…" : "Archive"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Factory reset Suplex?</AlertDialogTitle><AlertDialogDescription>Suplex deletes all companies, projects, tasks, users, settings, and artifacts on this host. Suplex keeps backups, repositories, and worktrees. Factory reset deletes the billing credential on this host and does not cancel a subscription. You cannot undo this.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void clearAccount()} disabled={busy !== ""}>{busy === "clear" ? "Resetting…" : "Factory reset"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </SettingsLayout>
  );
}
