import { useEffect, useRef, useState, type FormEvent, type RefObject, type ReactElement } from "react";
import { Plus } from "lucide-react";

import suplexWordmark from "../../assets/suplex-wordmark.svg?inline";
import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Input } from "../../components/ui/input.js";
import { Spinner } from "../../components/ui/spinner.js";
import { ApiError } from "../../lib/api.js";
import { getAccount, pollAccountLogin, startAccountLogin, type AccountProvider } from "./lib/account-api.js";

const POLL_MS = 2_000;
const POLL_LIMIT_MS = 15 * 60 * 1000;
const FAILURE_LIMIT = 15;
/** One named tab: "Open the browser" reuses the login tab when it is still open. */
const LOGIN_WINDOW = "suplex-login";

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

/** Closes the login tab that this view opened. A blocked popup, a closed tab, or a browser refusal is not an error. */
function closeLoginWindow(loginWindow: RefObject<Window | null>): void {
  const opened = loginWindow.current;
  loginWindow.current = null;
  try { if (opened && !opened.closed) opened.close(); } catch { /* The tab tells the user to close it. */ }
}

/**
 * App Store guideline 4.8 asks for Sign in with Apple next to a third-party login, so the iOS shell offers only
 * Suplex's own email login; every method reaches the same account. Google Play has no such rule. The shell bridge
 * does not name its platform, so any mobile shell that is not Android counts as iOS.
 */
export function emailLoginOnly(): boolean {
  return Boolean(window.suplexMobile) && !/Android/i.test(navigator.userAgent);
}

export function AccountLoginView({ preview = false, previewState }: { preview?: boolean; previewState?: "browser" | "email" | undefined }): ReactElement {
  const [canManage, setCanManage] = useState<boolean>();
  const [unclaimed, setUnclaimed] = useState(false);
  const [emailForm, setEmailForm] = useState(false);
  const [email, setEmail] = useState("");
  const [waiting, setWaiting] = useState<Waiting | undefined>(() => preview && previewState ? { attemptId: "preview", ...(previewState === "email" ? { email: "you@example.com" } : { url: "https://suplex.sh/auth/done" }) } : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [recovery] = useState(recoveryToken);
  // The login tab keeps its opener, so this view can close it after the login. A blocked popup gives `null`.
  const loginWindow = useRef<Window | null>(null);

  const openLogin = (url: string): void => { loginWindow.current = window.open(url, LOGIN_WINDOW); };

  useEffect(() => () => closeLoginWindow(loginWindow), []);

  useEffect(() => {
    if (preview) { setCanManage(true); return; }
    if (recovery) { setCanManage(true); return; }
    void getAccount().then((account) => {
      if (account.account) window.location.assign(completedLoginPath());
      else if (!account.configured) { setCanManage(false); setError("Suplex login is not configured on this host."); }
      else { setCanManage(account.canManage); setUnclaimed(account.unclaimed); }
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
        if (status === "complete") { closeLoginWindow(loginWindow); window.location.assign(recovery ? "/" : completedLoginPath()); return; }
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
      if (attempt.url) openLogin(attempt.url);
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

  const cancel = (): void => { closeLoginWindow(loginWindow); setWaiting(undefined); setEmailForm(false); setError(""); };

  return (
    <main className="dark flex min-h-dvh flex-col bg-[#070707] pb-[var(--desktop-status-height,0px)] text-foreground md:flex-row">
      <section aria-label="Suplex" className="flex flex-col justify-between gap-16 bg-primary px-6 py-10 text-primary-foreground md:flex-1 md:gap-24 md:px-12 md:py-16 xl:px-18">
        <div className="flex items-center justify-between font-mono text-xs tracking-wider text-primary-foreground/75 md:text-sm">
          <span>AI TOOLS FOR BUILDERS.</span>
          <Plus aria-hidden="true" strokeWidth={0.6} className="size-12 md:size-24" />
        </div>
        <div className="flex flex-col gap-6 md:gap-10">
          <h1 className="text-6xl leading-[0.92] font-medium tracking-[-0.05em] md:text-8xl">Heavy tasks.<br />Light work.</h1>
          <p className="font-mono text-xs tracking-wider text-primary-foreground/75 md:text-sm">YOUR BACKLOG NEVER SAW IT COMING.</p>
        </div>
      </section>
      <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 md:w-[37.5%] md:min-w-[30rem] md:flex-none md:px-12 md:py-16">
        <img src={suplexWordmark} alt="Suplex" className="h-auto w-full max-w-[375px]" />
        <div className="mt-10 flex w-full max-w-[375px] flex-col gap-4 md:mt-12">
          {canManage === false ? <p className="text-center text-sm text-muted-foreground">Ask an administrator to log in to Suplex.</p> : waiting ? (
            <div className="flex flex-col gap-5 text-center">
              <div className="flex flex-col gap-2">
                <h2 className="text-2xl font-normal tracking-tight">{waiting.email ? "Check your email" : "Continue in the browser"}</h2>
                {waiting.email ? <p className="text-sm leading-relaxed text-muted-foreground">Suplex sent a login link to <span className="break-words text-foreground">{waiting.email}</span>. Open it to continue.</p> : <p className="text-sm leading-relaxed text-muted-foreground">Suplex will continue after you log in.</p>}
              </div>
              <div className="flex min-h-9 items-center justify-center gap-2 text-muted-foreground"><Spinner />{waiting.url ? <Button variant="link" nativeButton={false} render={<a href={waiting.url} target={LOGIN_WINDOW} onClick={(event) => { event.preventDefault(); if (waiting.url) openLogin(waiting.url); }} />}>Open the browser</Button> : null}</div>
              <Button variant="outline" size="lg" onClick={cancel}>Cancel</Button>
            </div>
          ) : emailForm ? (
            <form className="flex flex-col gap-3" onSubmit={submitEmail}>
              <Input type="email" required autoFocus autoComplete="email" aria-label="Email address" placeholder="Email address" value={email} onChange={(event) => setEmail(event.target.value)} />
              <Button type="submit" size="lg" disabled={busy || email.trim().length < 3}>Continue</Button>
              <Button type="button" variant="ghost" size="lg" onClick={cancel}>Cancel</Button>
            </form>
          ) : (
            <div className="flex flex-col gap-3">
              {recovery ? <p className="pb-2 text-center text-sm text-muted-foreground">Log in to recover this host. Your account becomes its owner.</p> : unclaimed ? <p className="pb-2 text-center text-sm text-muted-foreground">This host has no owner. Log in to become its owner.</p> : null}
              {emailLoginOnly() ? null : <>
                <Button size="lg" disabled={busy || canManage === undefined} onClick={() => void start("google")}>Continue with Google</Button>
                <Button variant="outline" size="lg" disabled={busy || canManage === undefined} onClick={() => void start("github")}>Continue with GitHub</Button>
              </>}
              <Button variant={emailLoginOnly() ? "default" : "outline"} size="lg" disabled={busy || canManage === undefined} onClick={() => { setEmailForm(true); setError(""); }}>Continue with email</Button>
            </div>
          )}
          {error ? <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert> : null}
          {canManage === false || waiting ? null : (
            <p className="mt-7 text-center text-sm leading-snug text-balance text-muted-foreground">When you continue, you agree to the <a href="https://suplex.sh/terms" target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">Terms of Service</a> and <a href="https://suplex.sh/privacy" target="_blank" rel="noreferrer" className="underline underline-offset-4 hover:text-foreground">Privacy Policy</a>.</p>
          )}
        </div>
      </div>
    </main>
  );
}
