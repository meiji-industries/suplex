import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { GitHubAuthStatusResponseSchema, GitHubDevicePollResponseSchema, GitHubDeviceStartResponseSchema, type GitHubDevicePollResponse, type GitHubDeviceStartResponse } from "../../../http/contracts/github-auth.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../ui/button.js";

export function GithubDeviceSignIn({ onConnected }: { onConnected: () => Promise<void> }): ReactElement {
  const [flow, setFlow] = useState<GitHubDeviceStartResponse>();
  const [nextPollAt, setNextPollAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!flow || !nextPollAt) return undefined;
    const delay = Math.max(0, Date.parse(nextPollAt) - Date.now());
    const timer = window.setTimeout(() => {
      const poll = async (): Promise<void> => {
        let result: GitHubDevicePollResponse | undefined;
        try {
          result = GitHubDevicePollResponseSchema.parse(await readJson<unknown>("/api/github/device/poll", {
            method: "POST",
            body: JSON.stringify({ flowId: flow.flowId }),
          }));
        } catch {
          try {
            const status = GitHubAuthStatusResponseSchema.parse(await readJson<unknown>("/api/github/auth"));
            if (status.status === "connected") result = { status: "connected", login: status.login };
          } catch { /* The status check may fail with the same network error. */ }
        }
        if (!result) {
          setNextPollAt(undefined);
          setMessage("Suplex could not check GitHub sign-in. Select Retry.");
          return;
        }
        if (result.status === "pending") setNextPollAt(result.nextPollAt);
        else if (result.status === "connected") {
          setFlow(undefined);
          setNextPollAt(undefined);
          setMessage(`GitHub is connected as ${result.login}.`);
          try { await onConnected(); } catch { setMessage("GitHub is connected. Select Check again to refresh status."); }
        } else {
          setFlow(undefined);
          setNextPollAt(undefined);
          setMessage(result.status === "expired" ? "GitHub sign-in expired. Start again." : "GitHub denied sign-in. Start again.");
        }
      };
      void poll().catch(() => {
        setNextPollAt(undefined);
        setMessage("Suplex could not check GitHub sign-in. Select Retry.");
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [flow, nextPollAt, onConnected]);

  const start = async (): Promise<void> => {
    setBusy(true);
    setMessage("");
    try {
      const started = GitHubDeviceStartResponseSchema.parse(await readJson<unknown>("/api/github/device/start", { method: "POST" }));
      setFlow(started);
      setNextPollAt(new Date(Date.now() + started.intervalSeconds * 1000).toISOString());
      setCopied(false);
    } catch {
      setMessage("Suplex could not start GitHub sign-in. Select Retry.");
    } finally {
      setBusy(false);
    }
  };

  const copy = async (): Promise<void> => {
    if (!flow) return;
    try {
      await navigator.clipboard.writeText(flow.userCode);
      setCopied(true);
    } catch {
      setMessage("Select the code and copy it.");
    }
  };

  return <div className="space-y-2 text-xs">
    {flow ? <>
      <p>Enter this code on GitHub:</p>
      <div className="flex flex-wrap items-center gap-2">
        <code className="rounded border bg-background px-2 py-1 font-mono text-sm select-all">{flow.userCode}</code>
        <Button size="xs" variant="outline" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy the code"}</Button>
        <Button size="xs" variant="outline" nativeButton={false} render={<a href={flow.verificationUri} target="_blank" rel="noreferrer" />}><ExternalLink />Open GitHub</Button>
      </div>
      <p className="text-muted-foreground">Suplex waits for GitHub. This code expires at {new Date(flow.expiresAt).toLocaleTimeString()}.</p>
      {!nextPollAt ? <Button size="xs" variant="outline" onClick={() => setNextPollAt(new Date().toISOString())}>Retry</Button> : null}
    </> : <Button size="xs" variant="outline" disabled={busy} onClick={() => void start()}>{busy ? "Suplex starts sign-in" : message ? "Retry" : "Sign in to GitHub"}</Button>}
    {message ? <p role="status" className="text-muted-foreground">{message}</p> : null}
  </div>;
}
