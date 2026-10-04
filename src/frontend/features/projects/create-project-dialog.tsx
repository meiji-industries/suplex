import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";
import { Field, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { Combobox, ComboboxContent, ComboboxEmpty, ComboboxInput, ComboboxItem, ComboboxList } from "../../components/ui/combobox.js";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "../../components/ui/dropdown-menu.js";
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "../../components/ui/input-group.js";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group.js";
import { Spinner } from "../../components/ui/spinner.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { ApiError, billingSettingsPath, hasApiFinding, isApiError, readJsonUnchecked, type ApiFinding, type CompanyStatus } from "../../lib/api.js";
import { useOptionalCompanyContext } from "../../shell/company-context.js";
import { reconcileScopedNotFound } from "../../shell/view-shared.js";
import { ChevronDown, Plus } from "lucide-react";
import { useCallback, useEffect, useState, type FormEvent, type ReactElement } from "react";
import { ProjectConnections, REPOSITORY_HOSTS, withRepositoryHost } from "./project-connections.js";
import { ProjectIntegrationSchema, type ProjectIntegration } from "../../contracts/project-integration.js";
import { createProject } from "./lib/project-api.js";
import { clearProjectDraft, readProjectDraft, writeProjectDraft } from "./lib/project-draft.js";

const QUOTA_CODES = new Set(["project_limit_reached", "billing_unavailable"]);

function quotaMessage(code: string, admin: boolean): string {
  if (code === "billing_unavailable") return "Suplex cannot check the subscription. Retry the request.";
  return admin ? "The plan includes no more projects. Free includes 1 project and Pro includes 10." : "The plan includes no more projects. Request Pro from an administrator.";
}

type RepositoryOwnersState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "loaded"; owners: string[] }
  | { kind: "auth-required" }
  | { kind: "failed" };

/** A picker inside the repository field, in front of the text, like a URL protocol. */
function AddonMenu({ label, value, options, onChange }: { label: string; value: string; options: ReadonlyArray<{ value: string; label: string }>; onChange: (value: string) => void }): ReactElement {
  return <DropdownMenu>
    <DropdownMenuTrigger render={<InputGroupButton aria-label={label} />}>{options.find(option => option.value === value)?.label ?? value}<ChevronDown /></DropdownMenuTrigger>
    <DropdownMenuContent align="start" className="w-auto"><DropdownMenuRadioGroup value={value} onValueChange={next => onChange(String(next))}>{options.map(option => <DropdownMenuRadioItem key={option.value} value={option.value} closeOnClick>{option.label}</DropdownMenuRadioItem>)}</DropdownMenuRadioGroup></DropdownMenuContent>
  </DropdownMenu>;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  companyId,
  companyStatus,
  canSignInToGitHub,
  onCreated,
  reloadCompanies,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  companyId: string;
  companyStatus: CompanyStatus | undefined;
  canSignInToGitHub: boolean;
  onCreated: () => Promise<void>;
  reloadCompanies: () => Promise<void>;
}): ReactElement {
  const [source, setSource] = useState<"clone" | "create">("clone");
  const [host, setHost] = useState<"github" | "bitbucket" | "url">("github");
  const [repository, setRepository] = useState("");
  const [integration, setIntegration] = useState<ProjectIntegration>({ repository: { kind: "github" }, tracker: null });
  const [baseBranch, setBaseBranch] = useState("main");
  const [ownersState, setOwnersState] = useState<RepositoryOwnersState>({ kind: "idle" });
  const [owner, setOwner] = useState("");
  const [repositories, setRepositories] = useState<{ owner: string; list: Array<{ name: string; defaultBranch: string }> | null } | null>(null);
  const [findings, setFindings] = useState<ApiFinding[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quotaCode, setQuotaCode] = useState("");
  const isAdmin = useOptionalCompanyContext()?.user?.role === "admin";

  useEffect(() => {
    if (open) {
      const draft = readProjectDraft(companyId);
      setSource(draft?.source ?? "clone");
      setHost(draft?.source !== "create" && draft?.repository ? "url" : "github");
      setRepository(draft?.repository ?? "");
      setQuotaCode("");
      setIntegration({ repository: { kind: "github" }, tracker: null });
      setBaseBranch("main");
      setOwnersState({ kind: "idle" });
      setOwner("");
      setRepositories(null);
      setFindings([]);
      setError("");
      setBusy(false);
    }
  }, [open, companyId]);
  const closeDialog = (next: boolean): void => {
    if (!next) clearProjectDraft(companyId);
    onOpenChange(next);
  };

  const github = open && host === "github";
  const confirmGitHubAuthRequired = useCallback((reason: unknown): boolean => {
    if (!hasApiFinding(reason, "github-auth-unavailable")) return false;
    setOwnersState({ kind: "auth-required" });
    return true;
  }, []);
  const loadOwners = useCallback(async (): Promise<void> => {
    if (!companyId) return;
    setOwnersState({ kind: "loading" });
    try {
      const result = await readJsonUnchecked<{ owners: string[] }>(`/api/companies/${encodeURIComponent(companyId)}/repository-owners`);
      setOwnersState({ kind: "loaded", owners: result.owners });
      setOwner(result.owners[0] ?? "");
    } catch (reason) {
      if (confirmGitHubAuthRequired(reason)) return;
      setOwnersState({ kind: "failed" });
    }
  }, [companyId, confirmGitHubAuthRequired]);
  // GitHub repositories are picked by owner and name: the signed-in account first, then its organizations.
  useEffect(() => {
    if (!github || ownersState.kind !== "idle") return;
    void loadOwners();
  }, [github, loadOwners, ownersState.kind]);
  const owners = ownersState.kind === "loaded" ? ownersState.owners : [];
  // The picker layout shows while owners load, so the field does not change shape when they arrive.
  const ownersPending = github && (ownersState.kind === "idle" || ownersState.kind === "loading");
  // A location typed before GitHub sign-in finished stays as typed.
  const typedRepositoryLocation = repository.trim() !== "" && /[/:]/.test(repository);
  const ownerPicker = github && owner !== "" && !typedRepositoryLocation;
  // Without the GitHub CLI there is no owner list, and a clone takes a typed owner/repository.
  const repositoryPicker = ownerPicker && source === "clone";
  useEffect(() => {
    if (!repositoryPicker || repositories?.owner === owner) return;
    setRepositories({ owner, list: null });
    void readJsonUnchecked<{ repositories: Array<{ name: string; defaultBranch: string }> }>(`/api/companies/${encodeURIComponent(companyId)}/repository-owners/${encodeURIComponent(owner)}/repositories`)
      .catch(() => ({ repositories: [] }))
      .then(result => setRepositories(current => current?.owner === owner ? { owner, list: result.repositories } : current));
  }, [repositoryPicker, repositories, owner, companyId]);
  const chooseOwner = (next: string): void => {
    setOwner(next);
    if (source === "clone") setRepository("");
  };

  const hostDomain = integration.repository.kind === "bitbucket" ? "bitbucket.org" : "github.com";
  // A bare owner/repository clones from the selected host.
  const cloneUrl = repositoryPicker ? `https://github.com/${owner}/${repository}` : /^[\w.-]+\/[\w.-]+$/.test(repository.trim()) ? `https://${hostDomain}/${repository.trim()}` : repository.trim();

  const repositoryName = ownerPicker && !repository.includes("/") ? `${owner}/${repository.trim()}` : repository.trim();
  const submit = async (event?: FormEvent): Promise<void> => {
    event?.preventDefault();
    if (!companyId || companyStatus !== "active" || !repository.trim()) return;
    setBusy(true);
    setError("");
    setQuotaCode("");
    setFindings([]);
    try {
      await createProject(companyId, { ...(source === "create" ? { repositoryName } : { repositoryUrl: cloneUrl }), baseBranch, integration: ProjectIntegrationSchema.parse(integration) });
      clearProjectDraft(companyId);
      onOpenChange(false);
      setRepository("");
      setFindings([]);
      setError("");
      await onCreated().catch(() => undefined);
    } catch (reason) {
      if (await reconcileScopedNotFound(reason, reloadCompanies)) return;
      if (github && confirmGitHubAuthRequired(reason)) {
        setError("");
        setFindings([]);
        return;
      }
      if (isApiError(reason) && reason.code !== undefined && QUOTA_CODES.has(reason.code)) {
        setQuotaCode(reason.code);
        return;
      }
      setError(reason instanceof Error ? reason.message : "Project configuration failed");
      if (reason instanceof ApiError) setFindings(reason.findings ?? []);
    } finally {
      setBusy(false);
    }
  };

  const hostOptions = [...REPOSITORY_HOSTS.map(each => ({ value: each.kind, label: each.label })), ...(source === "clone" ? [{ value: "url", label: "URL" }] : [])];
  const chooseHost = (next: string): void => {
    setHost(next === "bitbucket" || next === "url" ? next : "github");
    setIntegration(withRepositoryHost(integration, next === "url" ? "github" : next));
    setRepository("");
  };
  // A typed URL selects the delivery host that serves it.
  const typeRepository = (value: string): void => {
    setRepository(value);
    const kind = /bitbucket\.org/i.test(value) ? "bitbucket" : "github";
    if (host === "url" && integration.repository.kind !== kind) setIntegration(withRepositoryHost(integration, kind));
  };
  const repositoryPrefix = <InputGroupAddon>
    <AddonMenu label="Repository host" value={host} options={hostOptions} onChange={chooseHost} />
    {ownersPending && !typedRepositoryLocation ? <Spinner /> : null}
    {ownerPicker ? <><AddonMenu label="Owner" value={owner} options={owners.map(each => ({ value: each, label: each }))} onChange={chooseOwner} /><InputGroupText>/</InputGroupText></> : null}
  </InputGroupAddon>;

  return (
    <Dialog open={open} onOpenChange={closeDialog}>
      <DialogContent showCloseButton>
        <DialogHeader><DialogTitle>Add project</DialogTitle></DialogHeader>
          {quotaCode ? <Alert><AlertDescription><p>{quotaMessage(quotaCode, isAdmin)}</p>{isAdmin && quotaCode !== "billing_unavailable" ? <a href={billingSettingsPath(companyId)} onClick={() => writeProjectDraft(companyId, { source, repository: source === "create" ? repositoryName : cloneUrl })}>Open billing settings</a> : null}</AlertDescription></Alert> : null}
          {companyStatus !== "active" ? (
            <p className="text-xs text-muted-foreground">{companyStatus === "paused" ? "Company paused. New projects are unavailable." : "Company archived. New projects are unavailable."}</p>
          ) : (
            <form className="grid gap-3" onSubmit={(event: FormEvent) => void submit(event)}>
              <RadioGroup aria-label="Repository source" value={source} onValueChange={value => { setSource(value === "create" ? "create" : "clone"); if (value === "create" && host === "url") chooseHost("github"); else setRepository(""); }} className="flex flex-wrap gap-x-4 gap-y-2">
                <label className="flex items-center gap-1.5 text-xs"><RadioGroupItem value="clone" />Clone existing repo</label>
                <label className="flex items-center gap-1.5 text-xs"><RadioGroupItem value="create" />Create fresh repo</label>
              </RadioGroup>
              <Field>
                <FieldLabel htmlFor="project-repository">Repository</FieldLabel>
                {repositoryPicker || ownersPending && source === "clone" && !typedRepositoryLocation ? <Combobox items={repositories?.list?.map(each => each.name) ?? []} value={repository || null} onValueChange={(name: string | null) => { setRepository(name ?? ""); const picked = repositories?.list?.find(each => each.name === name); if (picked) setBaseBranch(picked.defaultBranch); }}>
                  <ComboboxInput id="project-repository" autoFocus placeholder={repositoryPicker && repositories?.list ? "Search repositories" : "Loading repositories…"}>{repositoryPrefix}</ComboboxInput>
                  <ComboboxContent><ComboboxEmpty>No repositories found.</ComboboxEmpty><ComboboxList>{(name: string) => <ComboboxItem key={name} value={name}>{name}</ComboboxItem>}</ComboboxList></ComboboxContent>
                </Combobox> : <InputGroup>
                  {repositoryPrefix}
                  <InputGroupInput id="project-repository" name="repository" autoFocus autoComplete="off" spellCheck={false} placeholder={host === "url" ? "git@github.com:owner/repository.git" : host === "bitbucket" ? "workspace/repository" : ownerPicker || ownersPending ? "repository" : "owner/repository"} value={repository} onChange={(event) => typeRepository(event.target.value)} />
                </InputGroup>}
              </Field>
              <Field><FieldLabel htmlFor="create-base-branch">Base branch</FieldLabel><Input id="create-base-branch" value={baseBranch} onChange={event => setBaseBranch(event.target.value)} /></Field>
              <ProjectConnections value={integration} onChange={setIntegration} repositoryHost={false} />
              {github && ownersState.kind === "auth-required" ? <Alert><AlertDescription><div className="space-y-2"><p>GitHub is not signed in.</p>{canSignInToGitHub ? <GithubDeviceSignIn onConnected={async () => { setRepositories(null); await loadOwners(); }} /> : <p>An administrator must sign in to GitHub.</p>}</div></AlertDescription></Alert> : null}
              {github && ownersState.kind === "failed" ? <Alert><AlertDescription><div className="space-y-2"><p>Suplex could not load GitHub repositories. Enter owner/repository, or select Check again.</p><Button type="button" size="xs" variant="outline" onClick={() => void loadOwners()}>Check again</Button></div></AlertDescription></Alert> : null}
              <div className="grid"><Button size="sm" type="submit" disabled={busy || !companyId || !repository.trim()}><Plus />{busy ? source === "clone" ? "Cloning…" : "Creating…" : "Add project"}</Button></div>
            </form>
          )}
          {error ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
          {findings.length ? <ul className="mt-3 space-y-1 text-xs text-destructive">{findings.map((item, index) => <li key={`${item.field}-${index}`}>{item.field}: {item.message}</li>)}</ul> : null}
      </DialogContent>
    </Dialog>
  );
}
