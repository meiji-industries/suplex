import { Alert, AlertDescription } from ".././components/ui/alert.js";
import { Button } from ".././components/ui/button.js";
import { Input } from ".././components/ui/input.js";
import { Skeleton } from ".././components/ui/skeleton.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from ".././components/ui/alert-dialog.js";
import { ApplicationFrame } from ".././components/app/application-frame.js";
import { useCompanyContext } from ".././components/app/company-context.js";
import { SettingsLayout, SettingsSection, SettingRow } from ".././components/app/settings-layout.js";
import { companySettingsPath, withCompany, type CompanyStatus } from ".././lib/api.js";
import { Archive, RotateCcw, Save, Pause, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState, type ReactElement } from "react";

export function CompanySettingsView(): ReactElement {
  const { user, companies, currentCompany, loading, selectCompany, renameCompany, setCompanyIssueCode, setCompanyStatus, clearCompany } = useCompanyContext();
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
    return <ApplicationFrame title="Company settings"><div className="space-y-2 p-4" aria-busy="true" aria-label="Loading company settings"><Skeleton className="h-4 w-40" /><Skeleton className="h-8 w-full" /><Skeleton className="h-8 w-3/4" /></div></ApplicationFrame>;
  }
  if (notFound) {
    return <ApplicationFrame title="Company settings"><div className="p-4"><p className="text-xs text-muted-foreground">Company not found.</p><a className="mt-3 inline-flex text-xs text-primary underline underline-offset-2" href={withCompany("/projects", currentCompany?.id)}>Back to Projects</a></div></ApplicationFrame>;
  }
  if (!company) return <ApplicationFrame title="Company settings"><div className="p-4 text-xs text-muted-foreground">Company not found.</div></ApplicationFrame>;

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
    try { await clearCompany(company.id); setClearOpen(false); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Unable to clear company"); }
    finally { setBusy(""); }
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

  return (
    <SettingsLayout title="Workspace" companyId={company.id} backHref={backHref} activeHref={companySettingsPath(company.id)}>
      <SettingsSection title="Profile">
        <SettingRow label="Company name" description="Public workspace name.">
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Input id="company-name" value={name} onChange={(event) => { setName(event.target.value); setSaved(false); }} />
            <Button type="submit" size="sm" disabled={busy !== "" || !name.trim() || name.trim() === company.name}><Save className="size-3.5" />{busy === "rename" ? "Forge saves" : saved ? "Saved" : "Save"}</Button>
          </form>
        </SettingRow>
        <SettingRow label="Issue code" description="2–10 letters or numbers, beginning with a letter. Once set, it locks after the company has an issue.">
          <form className="flex items-end gap-2" onSubmit={(event) => { event.preventDefault(); void saveIssueCode(); }}>
            <Input id="company-issue-code" aria-label="Issue code" maxLength={10} pattern="[A-Za-z][A-Za-z0-9]{1,9}" placeholder="ADAM" value={issueCode} onChange={(event) => { setIssueCode(event.target.value.toUpperCase()); setCodeSaved(false); }} />
            <Button type="submit" size="sm" disabled={busy !== "" || (issueCode.trim().toUpperCase() || null) === company.issueCode}><Save className="size-3.5" />{busy === "issue-code" ? "Forge saves" : codeSaved ? "Saved" : "Save"}</Button>
          </form>
        </SettingRow>
        <SettingRow label="Company ID" description="Unique identifier.">
          <code className="select-all text-xs text-muted-foreground">{company.id}</code>
        </SettingRow>
        <SettingRow label="Created">
          <span className="text-xs text-muted-foreground">{new Date(company.createdAt).toLocaleDateString()}</span>
        </SettingRow>
      </SettingsSection>
      {error ? <div className="mb-4 text-xs text-rose-700"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
      <SettingsSection title="Lifecycle" description="Control workspace activity.">
        {company.status === "active" ? <SettingRow label="Pause company" description="Existing records remain available; new projects and tasks are blocked."><Button variant="outline" size="sm" onClick={() => void mutateStatus("paused")} disabled={busy !== ""}><Pause className="size-3.5" />{busy === "paused" ? "Forge pauses" : "Pause company"}</Button></SettingRow> : null}
        {company.status === "paused" ? <SettingRow label="Reactivate company" description="Restore creation of new projects and tasks."><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Forge reactivates" : "Reactivate company"}</Button></SettingRow> : null}
        {company.status !== "archived" ? <SettingRow label="Archive company" description="Archive is reversible, retains history, and blocks new work." destructive><Button variant="outline" size="sm" className="text-rose-700" onClick={() => setArchiveOpen(true)} disabled={busy !== ""}><Archive className="size-3.5" />Archive company</Button></SettingRow> : null}
        {company.status === "archived" ? <SettingRow label="Restore company" description="Restore the company to active status."><Button size="sm" onClick={() => void mutateStatus("active")} disabled={busy !== ""}><RotateCcw className="size-3.5" />{busy === "active" ? "Forge restores" : "Restore company"}</Button></SettingRow> : null}
        <SettingRow label="Clear account" description="Permanently delete every project, task, and record for this workspace, then reset it to factory state." destructive><Button variant="outline" size="sm" className="text-rose-700" onClick={() => setClearOpen(true)} disabled={busy !== ""}><Trash2 className="size-3.5" />Clear account</Button></SettingRow>
      </SettingsSection>
      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Archive {company.name}?</AlertDialogTitle><AlertDialogDescription>You can reverse this action. You can read the project and task history, but you cannot start new work.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void mutateStatus("archived")} disabled={busy !== ""}>{busy === "archived" ? "Forge archives the company." : "Archive"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
      <AlertDialog open={clearOpen} onOpenChange={setClearOpen}><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>Clear {company.name}?</AlertDialogTitle><AlertDialogDescription>This permanently deletes every project, task, artifact, and execution record for this workspace and resets it to factory state. Memberships and audit history are kept. This cannot be undone.</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>Cancel</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={() => void clearAccount()} disabled={busy !== ""}>{busy === "clear" ? "Forge clears" : "Clear account"}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>
    </SettingsLayout>
  );
}
