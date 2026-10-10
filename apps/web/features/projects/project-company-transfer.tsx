import { useState, type ReactElement } from "react";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "../../components/ui/alert-dialog.js";
import { Button } from "../../components/ui/button.js";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { useCompanyContext } from "../../shell/company-context.js";
import { navigate } from "../../shell/navigation-state.js";
import { withCompany } from "../../lib/api.js";
import type { ApiProject } from "../../shell/view-shared.js";
import { SettingRow, SettingsSection } from "../settings/settings-layout.js";
import { transferProject } from "./lib/project-api.js";

/** An admin moves the project, with its tasks, to another company. Only members of that company can then see it. */
export function ProjectCompanyTransfer({ project }: { project: ApiProject }): ReactElement | null {
  const { companies, reloadCompanies } = useCompanyContext();
  const targets = companies.filter(company => company.id !== project.companyId && company.status === "active");
  const [targetId, setTargetId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const target = targets.find(company => company.id === targetId);
  const move = async (): Promise<void> => {
    if (!target) return;
    setBusy(true); setError("");
    try {
      await transferProject(project.id, target.id);
      await reloadCompanies();
      navigate(withCompany(`/projects/${encodeURIComponent(project.id)}`, target.id));
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Suplex could not move the project."); setBusy(false); }
  };
  if (!targets.length) return null;
  return <SettingsSection title="Company">
    <SettingRow label="Move to company" description="Only members of that company can see the project and its tasks." htmlFor="project-company">
      <div className="flex w-full gap-2 sm:w-80">
        <div className="min-w-0 flex-1"><Select value={targetId} onValueChange={value => setTargetId(value)}>
          <SelectTrigger id="project-company"><SelectValue placeholder="Select a company">{target?.name}</SelectValue></SelectTrigger>
          <SelectContent>{targets.map(company => <SelectItem key={company.id} value={company.id}>{company.name}</SelectItem>)}</SelectContent>
        </Select></div>
        <Button type="button" variant="outline" size="sm" disabled={!target} onClick={() => setConfirming(true)}>Move the project</Button>
      </div>
    </SettingRow>
    <AlertDialog open={confirming} onOpenChange={next => { if (!busy) setConfirming(next); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Move {project.name} to {target?.name}?</AlertDialogTitle>
          <AlertDialogDescription>Suplex moves the tasks, moves, triggers, and attachments. Tasks get new keys in {target?.name}. External agents of this company lose access to the project.</AlertDialogDescription>
        </AlertDialogHeader>
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
          <AlertDialogAction disabled={busy} onClick={event => { event.preventDefault(); void move(); }}>Move the project</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  </SettingsSection>;
}
