import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import { RefreshCw } from "lucide-react";
import { ProjectRepositoryStatusSchema, type ProjectRepositoryStatus } from "../../../http/contracts/projects.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { StatusLight } from "../../components/app/status-light.js";
import { Spinner } from "../../components/ui/spinner.js";
import { Button } from "../../components/ui/button.js";
import { readJson } from "../../lib/api.js";

type State = { kind: "checking" } | { kind: "failed" } | { kind: "ready"; result: ProjectRepositoryStatus };

export function ProjectRepositoryConnection({ projectId }: { projectId: string }): ReactElement {
  const [state, setState] = useState<State>({ kind: "checking" });
  const generation = useRef(0);
  const check = useCallback(async (): Promise<void> => {
    const token = ++generation.current;
    setState({ kind: "checking" });
    try {
      const result = ProjectRepositoryStatusSchema.parse(await readJson<unknown>(`/api/projects/${encodeURIComponent(projectId)}/repository-status`));
      if (token === generation.current) setState({ kind: "ready", result });
    } catch {
      if (token === generation.current) setState({ kind: "failed" });
    }
  }, [projectId]);
  useEffect(() => { void check(); return () => { generation.current++; }; }, [check]);
  const result = state.kind === "ready" ? state.result : undefined;
  const connected = result?.status === "connected";
  return <div className="w-full space-y-2 text-xs sm:w-80">
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <span role="status" className="inline-flex items-center gap-2">
          {state.kind === "checking" ? <><Spinner />Check in progress</> : <><StatusLight level={connected ? "green" : "red"} label={connected ? "Connected" : "Disconnected"} />{connected ? "Connected" : "Disconnected"}</>}
        </span>
        <Button type="button" size="icon-xs" variant="ghost" aria-label="Check again" title="Check again" disabled={state.kind === "checking"} onClick={() => void check()}><RefreshCw /></Button>
      </div>
      {state.kind !== "checking" && !connected ? result?.method === "cli"
        ? <Button type="button" size="xs" onClick={() => void check()}>Connect</Button>
        : <GithubDeviceSignIn onConnected={check} label="Connect" primary /> : null}
    </div>
    {state.kind === "failed" ? <p role="alert">Repository check is not available.</p> : null}
    {result && (result.status === "needs_repair" || result.status === "unavailable") ? <p>{result.message}</p> : null}
    {result?.method === "cli" && !connected ? <p>Sign in to GitHub on the Suplex host with <code>gh auth login</code>, then select Connect.</p> : null}
  </div>;
}
