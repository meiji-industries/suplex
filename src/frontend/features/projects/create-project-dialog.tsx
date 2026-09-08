import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldDescription, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { NewButton } from "../../components/ui/new-button.js";
import { readJson, type CompanyStatus } from "../../lib/api.js";
import { reconcileScopedNotFound, type ApiProject } from "../../shell/view-shared.js";
import { useEffect, useState, type FormEvent, type ReactElement } from "react";

export function CreateProjectDialog({
  open,
  onOpenChange,
  companyId,
  companyStatus,
  onCreated,
  reloadCompanies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyStatus: CompanyStatus | undefined;
  onCreated: () => Promise<void>;
  reloadCompanies: () => Promise<void>;
}): ReactElement {
  const [repositoryUrl, setRepositoryUrl] = useState("");
  const [findings, setFindings] = useState<Array<{ field: string; message: string }>>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setRepositoryUrl("");
      setFindings([]);
      setError("");
      setBusy(false);
    }
  }, [open]);

  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!companyId || companyStatus !== "active" || !repositoryUrl.trim()) return;
    setBusy(true);
    setError("");
    setFindings([]);
    try {
      await readJson<ApiProject>(`/api/companies/${companyId}/projects`, {
        method: "POST",
        body: JSON.stringify({ repositoryUrl: repositoryUrl.trim() }),
      });
      await onCreated();
      onOpenChange(false);
    } catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      setError(reason instanceof Error ? reason.message : "Project configuration failed");
      if (reason instanceof Error && "findings" in reason) setFindings((reason as Error & { findings?: Array<{ field: string; message: string }> }).findings ?? []);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton>
        <DialogHeader><DialogTitle>New project</DialogTitle></DialogHeader>
          {companyStatus !== "active" ? (
            <p className="text-xs text-muted-foreground">{companyStatus === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p>
          ) : (
            <form className="grid gap-3" onSubmit={(event: FormEvent) => void submit(event)}>
              <Field>
                <FieldLabel htmlFor="project-repository-url">GitHub repository URL</FieldLabel>
                <Input id="project-repository-url" name="repositoryUrl" autoFocus autoComplete="off" spellCheck={false} placeholder="https://github.com/owner/repository" aria-describedby="project-repository-hint" value={repositoryUrl} onChange={(event) => setRepositoryUrl(event.target.value)} />
                <FieldDescription id="project-repository-hint">HTTPS and SSH URLs are supported. Forge clones into <span className="font-mono">~/forge/repos</span> and creates worktrees in <span className="font-mono">~/forge/worktrees</span>.</FieldDescription>
              </Field>
              <DialogFooter><DialogClose render={<Button type="button" variant="outline" size="sm">Cancel</Button>} /><NewButton type="submit" disabled={busy || !companyId || !repositoryUrl.trim()}>{busy ? "Cloning…" : "New project"}</NewButton></DialogFooter>
            </form>
          )}
          {error ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-destructive">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}