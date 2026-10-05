import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import suplexWordmark from "../../assets/suplex-wordmark.svg?inline";
import accountBackground from "../../assets/account-background.png?inline";
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

/** The token of a `suplex recover` link (`/auth?mode=recovery&invite=…`). */
function recoveryToken(): string | undefined {
  const query = new URLSearchParams(window.location.search);
  return query.get("mode") === "recovery" ? query.get("invite") ?? undefined : undefined;
}

/** Shown on open until this host links a Suplex account. */
function completedLoginPath(): string {
  const query = new URLSearchParams(window.location.search);
  const returnTo = query.get("returnTo");
  if (returnTo?.startsWith("/oauth/consent?")) return returnTo;
  const company = query.get("company");
  return company ? `/?company=${encodeURIComponent(company)}` : "/";
}

export function AccountLoginView({ preview = false, previewState }: { preview?: boolean; previewState?: "browser" | "email" | undefined }): ReactElement {
  const [canManage, setCanManage] = useState<boolean>();
  const [emailForm, setEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [waiting, setWaiting] = useState<Waiting | undefined>(() => preview && previewState ? { attemptId: "preview", ...(previewState === "email" ? { email: "you@example.com" } : { url: "https://suplex.sh/auth/done" }) } : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recovery] = useState(recoveryToken);

  useEffect(() => {
    if (preview) { setCanManage(true); return; }
    if (recovery) { setCanManage(true); return; }
    void getAccount().then((account) => {
      if (account.account) window.location.assign(completedLoginPath());
      else if (!account.configured) { setCanManage(false); setError("Suplex login is not configured on this host."); }
      else setCanManage(account.canManage);
    }).catch(() => setCanManage(true));
  }, [preview, recovery]);

  useEffect(() => {
    if (preview || !waiting) return;
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
        if (status === "complete") { window.location.assign(recovery ? "/" : completedLoginPath()); return; }
        if (status === "expired") { setWaiting(undefined); setError("The login expired. Retry."); return; }
      } catch (failure) {
        if (failure instanceof ApiError && failure.statusCode === 403) { setWaiting(undefined); setError(failure.message); return; }
        failures += 1;
        if (failures >= FAILURE_LIMIT) { setWaiting(undefined); setError("Suplex cannot reach the account service."); return; }
      }
      if (!stopped) timer = window.setTimeout(() => void poll(), POLL_MS);
    };
    timer = window.setTimeout(() => void poll(), POLL_MS);
    return () => { stopped = true; window.clearTimeout(timer); };
  }, [preview, waiting]);

  const start = async (provider: AccountProvider, address?: string): Promise<void> => {
    if (preview) { setError("Open the login page to continue. This page is a preview."); return; }
    setBusy(true);
    setError("");
    try {
      const attempt = await startAccountLogin(provider, address, recovery);
      if (attempt.url) window.open(attempt.url, "_blank", "noopener");
      setWaiting({ attemptId: attempt.attemptId, url: attempt.url, email: address });
    } catch (failure) {
      setError(failure instanceof ApiError && failure.statusCode === 403 ? failure.message : failureMessage(failure));
    } finally {
      setBusy(false);
    }
  };

  const submitEmail = (event: FormEvent): void => {
    event.preventDefault();
    void start("email", email.trim());
  };

  const cancel = (): void => { setWaiting(undefined); setEmailForm(false); setError(""); };

  return (
    <main className="dark flex min-h-dvh flex-col items-center justify-center gap-8 bg-[#080808] pt-8 pb-[calc(var(--desktop-status-height,0px)+2rem)] text-foreground md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] md:gap-0 md:pt-0 md:pb-[var(--desktop-status-height,0px)]">
      <div className="relative order-2 aspect-[941/1257] w-full max-w-sm justify-self-center overflow-hidden md:aspect-[1257/941] md:max-w-none">
        <img src={accountBackground} alt="" className="absolute top-1/2 left-1/2 h-auto w-[133.582%] max-w-none -translate-x-1/2 -translate-y-1/2 -rotate-90 md:w-full md:-rotate-180" />
      </div>
      <div className="order-1 flex flex-col items-center gap-10 px-6 py-8 md:px-12">
        <img src={suplexWordmark} alt="Suplex" className="h-auto w-full max-w-sm" />
        <div className="flex w-full max-w-xs flex-col gap-4">
          {canManage === false ? <p className="text-xs text-muted-foreground">Ask an administrator to log in to Suplex.</p> : waiting ? (
            <div className="flex flex-col gap-5 text-center">
              <div className="flex flex-col gap-2">
                <h1 className="text-2xl font-normal tracking-tight">{waiting.email ? "Check your email" : "Continue in the browser"}</h1>
                {waiting.email ? <p className="text-sm leading-relaxed text-muted-foreground">Suplex sent a login link to <span className="break-words text-foreground">{waiting.email}</span>. Open it to continue.</p> : <p className="text-sm leading-relaxed text-muted-foreground">Suplex will continue after you log in.</p>}
              </div>
              <div className="flex min-h-9 items-center justify-center gap-2 text-muted-foreground"><Spinner />{waiting.url ? <Button variant="link" nativeButton={false} render={<a href={waiting.url} target="_blank" rel="noreferrer" />}>Open the browser</Button> : null}</div>
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
              {recovery ? <p className="pb-2 text-sm text-muted-foreground">Log in to recover this host. Your account becomes its owner.</p> : null}
              <Button disabled={busy || canManage === undefined} onClick={() => void start("google")}>Continue with Google</Button>
              <Button variant="outline" disabled={busy || canManage === undefined} onClick={() => void start("github")}>Continue with GitHub</Button>
              <Button variant="outline" disabled={busy || canManage === undefined} onClick={() => { setEmailForm(true); setError(""); }}>Continue with email</Button>
            </div>
          )}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {canManage === false || waiting ? null : (
            <p className="pt-4 text-center text-xs text-muted-foreground">When you continue, you agree to the <a href="https://suplex.sh/terms" target="_blank" rel="noreferrer" className="underline underline-offset-4">Terms of Service</a> and <a href="https://suplex.sh/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-4">Privacy Policy</a>.</p>
          )}
        </div>
      </div>
    </main>
  );
}
