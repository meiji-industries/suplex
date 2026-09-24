import { Alert, AlertDescription } from "../../components/ui/alert.js";
import { Button } from "../../components/ui/button.js";
import { Field, FieldGroup, FieldLabel } from "../../components/ui/field.js";
import { Input } from "../../components/ui/input.js";
import { ApplicationFrame } from "../../shell/application-frame.js";
import { readJson } from "../../lib/api.js";
import { startAuthentication, startRegistration } from "@simplewebauthn/browser";
import { useEffect, useMemo, useState, type ReactElement } from "react";

export function AuthView(): ReactElement {
  const params = useMemo(() => new URLSearchParams(window.location.search), []);
  const [required, setRequired] = useState(false);
  const [token, setToken] = useState(params.get("invite") ?? "");
  const mode = params.get("mode") ?? "";
  const returnTo = oauthReturnTo(params.get("returnTo"));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void readJson<{ required: boolean; authenticated: boolean }>("/api/auth/status").then((status) => {
      if (status.authenticated) window.location.assign(returnTo);
      setRequired(status.required);
    }).catch(() => setError("Unable to read sign-in state"));
  }, [returnTo]);

  const enroll = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const registrationKind = mode === "recovery" ? "recovery" : required ? "bootstrap" : "invitation";
      const options = await readJson<{ challengeId: string; options: Parameters<typeof startRegistration>[0]["optionsJSON"] }>(`/api/auth/${registrationKind}/options`, { method: "POST", body: JSON.stringify({ token }) });
      const response = await startRegistration({ optionsJSON: options.options });
      await readJson(`/api/auth/${registrationKind}/verify`, { method: "POST", body: JSON.stringify({ token, challengeId: options.challengeId, response }) });
      window.location.assign(returnTo);
    } catch {
      setError("Passkey enrollment failed");
    } finally { setBusy(false); }
  };

  const signIn = async (): Promise<void> => {
    setBusy(true); setError("");
    try {
      const options = await readJson<{ challengeId: string; options: Parameters<typeof startAuthentication>[0]["optionsJSON"] }>("/api/auth/options", { method: "POST", body: "{}" });
      const response = await startAuthentication({ optionsJSON: options.options });
      await readJson("/api/auth/verify", { method: "POST", body: JSON.stringify({ challengeId: options.challengeId, response }) });
      window.location.assign(returnTo);
    } catch {
      setError("Passkey sign-in failed");
    } finally { setBusy(false); }
  };

  const enrollment = required || token.length > 0;
  return (
    <ApplicationFrame title={enrollment ? "Enroll passkey" : "Sign in"}>
      <div className="mx-auto max-w-md px-4 py-4 sm:px-8">
        <div className="bg-card p-4">
          <div className="mb-5 flex items-center justify-between"><span className="text-sm font-semibold">{enrollment ? "Passkey enrollment" : "Passkey sign-in"}</span><span className="text-xs text-muted-foreground">No password</span></div>
          {enrollment ? <FieldGroup><Field><FieldLabel htmlFor="invitation">Invitation token</FieldLabel><Input id="invitation" autoComplete="off" value={token} onChange={(event) => setToken(event.target.value)} /></Field><Button onClick={() => void enroll()} disabled={busy || token.length < 16}>{busy ? "Waiting for passkey…" : "Enroll passkey"}</Button></FieldGroup> : <Button className="w-full" onClick={() => void signIn()} disabled={busy}>{busy ? "Waiting for passkey…" : "Sign in with passkey"}</Button>}
          {error ? <div className="mt-3 text-xs text-destructive"><Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert></div> : null}
        </div>
      </div>
    </ApplicationFrame>
  );
}

export function oauthReturnTo(value: string | null): string {
  if (!value) return "/tasks";
  try {
    const url = new URL(value, window.location.origin);
    const requestId = url.searchParams.get("request") ?? "";
    if (url.origin !== window.location.origin || url.pathname !== "/oauth/consent" || !/^oauth_request_[a-f0-9]{32}$/.test(requestId)) return "/tasks";
    return `${url.pathname}?request=${encodeURIComponent(requestId)}`;
  } catch {
    return "/tasks";
  }
}
