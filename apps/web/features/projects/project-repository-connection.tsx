import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { RefreshCw, Trash2 } from "lucide-react";
import { ProjectRepositoryStatusSchema, type ProjectRepositoryStatus } from "../../contracts/projects.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { StatusLight } from "../../components/app/status-light.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Button } from "../../components/ui/button.js";
import { AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel } from "../../components/ui/alert-dialog.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { SettingRow } from "../settings/settings-layout.js";

type State = { kind: "checking" } | { kind: "failed" } | { kind: "ready"; result: ProjectRepositoryStatus };

const checkoutLabels: Record<ProjectRepositoryStatus["checkout"], string> = { ready: "Ready", missing: "Missing", not_a_repository: "Not a repository" };

function LocalCheckout({ state, repository, repositoryPath }: { state: State; repository: string | undefined; repositoryPath: string }): ReactElement {
  if (state.kind === "checking") return <span role="status" className="inline-flex items-center gap-2 text-xs"><Spinner />Check in progress</span>;
  if (state.kind === "failed") return <span className="text-xs text-muted-foreground">Not available</span>;
  const { checkout, message } = state.result;
  const ready = checkout === "ready";
  return <div className="w-full space-y-2 text-xs sm:w-80">
    <span role="status" className="inline-flex items-center gap-2"><StatusLight level={ready ? "green" : "red"} label={checkoutLabels[checkout]} />{checkoutLabels[checkout]}</span>
    {ready ? null : <p>{message}</p>}
    {!ready && repository ? <pre className="overflow-x-auto"><code className="select-all">{`git clone https://github.com/${repository}.git ${repositoryPath}`}</code></pre> : null}
  </div>;
}

/** One repository-status fetch feeds the local checkout row and the GitHub connection row. */
export function ProjectRepositoryConnection({ projectId, repository, repositoryPath }: { projectId: string; repository: string | undefined; repositoryPath: string }): ReactElement {
  const [state, setState] = useState<State>({ kind: "checking" });
  const generation = useRef(0);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [disconnectError, setDisconnectError] = useState<string>();
  const [disconnecting, setDisconnecting] = useState(false);
  const check = useCallback(async (): Promise<void> => {
    const token = ++generation.current;
    setState({ kind: "checking" });
    try {
      const result = ProjectRepositoryStatusSchema.parse(await readJsonUnchecked<unknown>(`/api/projects/${encodeURIComponent(projectId)}/repository-status`));
      if (token === generation.current) setState({ kind: "ready", result });
    } catch {
      if (token === generation.current) setState({ kind: "failed" });
    }
  }, [projectId]);
  useEffect(() => { void check(); return () => { generation.current++; }; }, [check]);
  const result = state.kind === "ready" ? state.result : undefined;
  const connected = result?.status === "connected";
  const disconnect = async (): Promise<void> => {
    setDisconnecting(true);
    setDisconnectError(undefined);
    try {
      await readJsonUnchecked("/api/github/disconnect", { method: "POST" });
      setConfirmDisconnect(false);
      await check();
    } catch { setDisconnectError("Suplex could not disconnect GitHub."); }
    finally { setDisconnecting(false); }
  };
  return <>
    <SettingRow label="Local checkout"><LocalCheckout state={state} repository={repository} repositoryPath={repositoryPath} /></SettingRow>
    <SettingRow label="GitHub connection"><div className="w-full space-y-2 text-xs sm:w-80">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span role="status" className="inline-flex items-center gap-2">
          {state.kind === "checking" ? <><Spinner />Check in progress</> : <><StatusLight level={connected ? "green" : "red"} label={connected ? "Connected" : "Disconnected"} />{connected && result?.login ? `@${result.login}` : connected ? "Connected" : "Disconnected"}</>}
        </span>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="Check again" title="Check again" disabled={state.kind === "checking"} onClick={() => void check()}><RefreshCw /></Button>
        {connected ? <Button type="button" size="icon-xs" variant="ghost" aria-label="Disconnect GitHub" title="Disconnect GitHub" onClick={() => setConfirmDisconnect(true)}><Trash2 /></Button> : null}
      </div>
      {state.kind !== "checking" && !connected ? result?.method === "cli"
        ? <Button type="button" size="xs" onClick={() => void check()}>Connect</Button>
        : <GithubDeviceSignIn onConnected={check} label="Connect" primary /> : null}
    </div>
    <AlertDialog open={confirmDisconnect} onOpenChange={setConfirmDisconnect}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>Disconnect GitHub?</AlertDialogTitle><AlertDialogDescription>Suplex disconnects all projects in this installation. GitHub CLI stays signed in.</AlertDialogDescription></AlertDialogHeader>
        {disconnectError ? <p role="alert">{disconnectError}</p> : null}
        <AlertDialogFooter><AlertDialogCancel disabled={disconnecting}>Cancel</AlertDialogCancel><Button type="button" variant="destructive" disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? <Spinner /> : null}Disconnect</Button></AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
    {state.kind === "failed" ? <p role="alert">Repository check is not available.</p> : null}
    {result && result.checkout === "ready" && (result.status === "needs_repair" || result.status === "unavailable") ? <p>{result.message}</p> : null}
    {result?.method === "cli" && !connected ? <p>Sign in to GitHub on the Suplex host with <code>gh auth login -s workflow</code>, then select Connect.</p> : null}
  </div></SettingRow>
  </>;
}
