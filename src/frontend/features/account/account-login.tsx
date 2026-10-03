import { useEffect, useState, type FormEvent, type ReactElement } from "react";
import { Mail } from "lucide-react";

import suplexMark from "../../assets/suplex-mark.svg?inline";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Spinner } from "../../components/ui/spinner.js";
import { ApiError } from "../../lib/api.js";
import { getAccount, pollAccountLogin, startAccountLogin, type AccountProvider } from "./lib/account-api.js";

const POLL_MS = 2_000;
const POLL_LIMIT_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 15;

type Waiting = { attemptId: string; url?: string | undefined; email?: string | undefined };

function failureMessage(error: unknown): string {
  if (error instanceof ApiError && error.statusCode === 429) return "Suplex limits login requests. Retry later.";
  if (error instanceof ApiError && error.statusCode === 503) return "Suplex cannot reach the account service.";
  return "Suplex could not start the login.";
}

/** Shown on open until this host links a Suplex account. */
export function AccountLoginView(): ReactElement {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [canManage, setCanManage] = useState<boolean>();
  const [emailForm, setEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [waiting, setWaiting] = useState<Waiting>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void getAccount().then((account) => {
      if (account.account || !account.configured) window.location.assign("/");
      else setCanManage(account.canManage);
    }).catch(() => setCanManage(true));
  }, []);

  useEffect(() => {
    if (!waiting) return;
    const started = Date.now();
    let failures = 0;
    let timer: number | undefined;
    let stopped = false;
    const poll = async (): Promise<void> => {
      if (stopped) return;
      if (Date.now() - started > POLL_LIMIT_MS) { setWaiting(undefined); setError("The login expired. Retry."); return; }
      try {
        const { status } = await pollAccountLogin(waiting.attemptId);
        failures = 0;
        if (status === "complete") { window.location.assign("/"); return; }
        if (status === "expired") { setWaiting(undefined); setError("The login expired. Retry."); return; }
      } catch {
        failures += 1;
        if (failures >= FAILURE_LIMIT) { setWaiting(undefined); setError("Suplex cannot reach the account service."); return; }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [waiting]);

  const start = async (provider: AccountProvider, address?: string): Promise<void> => {
    setBusy(true);
    setError("");
    try {
      const attempt = await startAccountLogin(provider, address);
      if (attempt.url) window.open(attempt.url, "_blank", "noopener");
      setWaiting({ attemptId: attempt.attemptId, url: attempt.url, email: address });
    } catch (failure) {
      setError(failureMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = (event: FormEvent): void => {
    event.preventDefault();
    void start("email", email.trim());
  };

  const cancel = (): void => { setWaiting(undefined); setEmailForm(false); setError(""); };
  const title = waiting ? (waiting.email ? "Check your email." : "Continue in the browser.") : mode === "login" ? "Log in to Suplex" : "Launch your environment";

  return (
    <main className="flex min-h-dvh items-center justify-center px-4 pb-[var(--desktop-status-height,0px)]">
      <div className="flex w-full max-w-xs flex-col gap-4">
        <span aria-hidden="true" className="size-8 bg-foreground" style={{ maskImage: `url("${suplexMark}")`, WebkitMaskImage: `url("${suplexMark}")`, maskSize: "contain", WebkitMaskSize: "contain", maskRepeat: "no-repeat", WebkitMaskRepeat: "no-repeat" }} />
        <h1 className="text-[13px] font-semibold">{title}</h1>
        {canManage === false ? <p className="text-xs text-muted-foreground">Ask an administrator to log in to Suplex.</p> : waiting ? (
          <div className="flex flex-col gap-3">
            {waiting.email ? <p className="text-xs text-muted-foreground">Suplex sent a sign-in link to {waiting.email}. Open it to continue.</p> : <p className="text-xs text-muted-foreground">Suplex waits for the browser to finish the login.</p>}
            <div className="flex items-center gap-2 text-xs text-muted-foreground"><Spinner />{waiting.url ? <a href={waiting.url} target="_blank" rel="noreferrer" className="underline underline-offset-4">Open the browser</a> : null}</div>
            <Button variant="outline" onClick={cancel}>Cancel</Button>
          </div>
        ) : emailForm ? (
          <form className="flex flex-col gap-2" onSubmit={submitEmail}>
            <Input type="email" required autoFocus autoComplete="email" aria-label="Email address" placeholder="Email address" value={email} onChange={(event) => setEmail(event.target.value)} />
            <Button type="submit" disabled={busy || email.trim().length < 3}>Continue</Button>
            <Button type="button" variant="ghost" onClick={cancel}>Cancel</Button>
          </form>
        ) : (
          <div className="flex flex-col gap-2">
            <Button variant="outline" disabled={busy || canManage === undefined} onClick={() => void start("google")}>Continue with Google</Button>
            <Button variant="outline" disabled={busy || canManage === undefined} onClick={() => void start("github")}>Continue with GitHub</Button>
            <Button variant="outline" disabled={busy || canManage === undefined} onClick={() => { setEmailForm(true); setError(""); }}><Mail />Continue with email</Button>
          </div>
        )}
        {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
        {canManage === false || waiting ? null : mode === "login" ? (
          <p className="text-xs text-muted-foreground">No account? <Button variant="link" size="xs" onClick={() => setMode("signup")}>Sign up.</Button></p>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">When you sign up, you agree to the <a href="https://suplex.sh/terms" target="_blank" rel="noreferrer" className="underline underline-offset-4">Terms of Service</a> and <a href="https://suplex.sh/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-4">Privacy Policy</a>.</p>
            <p className="text-xs text-muted-foreground">Already have an account? <Button variant="link" size="xs" onClick={() => setMode("login")}>Log in.</Button></p>
          </>
        )}
      </div>
    </main>
  );
}
