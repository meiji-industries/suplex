import { useEffect, useState, type ReactElement } from "react";

import { GitHubAuthStatusResponseSchema, GitHubDevicePollResponseSchema, GitHubDeviceStartResponseSchema, type GitHubDevicePollResponse, type GitHubDeviceStartResponse } from "../../../http/contracts/github-auth.js";
import { readJson } from "../../lib/api.js";
import { Button } from "../ui/button.js";
import { Spinner } from "../ui/spinner.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";

export function GithubDeviceSignIn({ onConnected, label, primary = false }: { onConnected: () => Promise<void>; label?: string; primary?: boolean }): ReactElement {
  const [open, setOpen] = useState(false);
  const [flow, setFlow] = useState<GitHubDeviceStartResponse>();
  const [nextPollAt, setNextPollAt] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!flow || !nextPollAt) return undefined;
    const delay = Math.max(0, Date.parse(nextPollAt) - Date.now());
    const timer = window.setTimeout(() => {
      const retry = (): void => {
        setNextPollAt(new Date(Date.now() + 5000).toISOString());
        setMessage("Suplex could not check GitHub sign-in. Suplex will retry.");
      };
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
          retry();
          return;
        }
        if (result.status === "pending") {
          setMessage("");
          setNextPollAt(result.nextPollAt);
        }
        else if (result.status === "connected") {
          setOpen(false);
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
      void poll().catch(retry);
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
      setWaiting(false);
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
      setMessage("");
    } catch {
      setMessage("Select the code and copy it.");
    }
  };

  return <Dialog open={open} onOpenChange={setOpen}>
    <div className="space-y-2 text-xs">
      <DialogTrigger render={<Button type="button" size="xs" variant={primary ? "default" : "outline"} disabled={busy} onClick={() => { if (!flow) void start(); }} />}>
        {label ?? (flow ? "Continue GitHub sign-in" : "Sign in to GitHub")}
      </DialogTrigger>
      {!open && message ? <p role="status" className="text-muted-foreground">{message}</p> : null}
    </div>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Sign in to GitHub</DialogTitle>
      </DialogHeader>
      <div className="space-y-3 text-sm">
        {flow ? <>
          <p>Enter this code on GitHub:</p>
          <code aria-label={`GitHub code: ${flow.userCode}`} className="flex items-center gap-1 font-mono text-xl font-semibold select-all sm:gap-2 sm:text-2xl">
            {Array.from(flow.userCode, (character, index) => character === "-"
              ? <span key={index} aria-hidden="true">-</span>
              : <span key={index} aria-hidden="true" className="flex h-12 min-w-0 flex-1 items-center justify-center rounded-md border border-input bg-background sm:h-14">{character}</span>)}
          </code>
          <div className="grid">
            {waiting
              ? <Button size="lg" className="rounded-md bg-green-700 text-white" disabled><Spinner />Testing connection</Button>
              : copied
              ? <Button size="lg" className="rounded-md bg-green-700 text-white hover:bg-green-800" nativeButton={false} render={<a href={flow.verificationUri} target="_blank" rel="noreferrer" />} onClick={() => setWaiting(true)}>Continue to Github</Button>
              : <Button type="button" size="lg" className="rounded-md" onClick={() => void copy()}>Copy the code</Button>}
          </div>
          {!nextPollAt ? <Button type="button" size="xs" variant="outline" onClick={() => setNextPollAt(new Date().toISOString())}>Retry</Button> : null}
        </> : busy ? <p role="status">Suplex starts sign-in</p> : <Button type="button" size="xs" variant="outline" onClick={() => void start()}>Retry</Button>}
        {message ? <p role="status" className="text-muted-foreground">{message}</p> : null}
      </div>
    </DialogContent>
  </Dialog>;
}
