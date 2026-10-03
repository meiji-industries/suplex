import { useEffect, useState, type FormEvent, type ReactElement } from "react";

import { Button } from "../components/ui/button.js";
import { Checkbox } from "../components/ui/checkbox.js";
import { Input } from "../components/ui/input.js";
import { withCompany } from "../lib/api.js";
import { useOptionalCompanyContext } from "./company-context.js";
import { acknowledgeTelemetry, getTelemetry } from "./telemetry-api.js";

// One read per page load: every application frame mounts this notice.
let noticeRequired: Promise<boolean> | undefined;

/** Shown to an administrator until they answer it once for this host. */
export function TelemetryNotice(): ReactElement | null {
  const companyId = useOptionalCompanyContext()?.currentCompany?.id;
  const [required, setRequired] = useState(false);
  const [email, setEmail] = useState("");
  const [sessionReplay, setSessionReplay] = useState(false);
  const [message, setMessage] = useState("");
  const [sending, setSending] = useState(false);

  useEffect(() => {
    noticeRequired ??= getTelemetry().then((telemetry) => telemetry.noticeRequired).catch(() => false);
    let current = true;
    void noticeRequired.then((value) => { if (current) setRequired(value); });
    return () => { current = false; };
  }, []);

  if (!required) return null;

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setSending(true);
    setMessage("");
    try {
      await acknowledgeTelemetry(email.trim() || null, sessionReplay);
      noticeRequired = Promise.resolve(false);
      setRequired(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Suplex could not save the answer");
    } finally {
      setSending(false);
    }
  };

  return (
    <form data-telemetry-notice aria-label="Usage data" onSubmit={(event) => void submit(event)} className="flex min-h-9 flex-wrap items-center gap-2 border-b px-4 py-1 lg:px-6">
      <span className="w-full text-xs sm:w-auto sm:min-w-0 sm:flex-1">Suplex sends usage events, app details, and sanitized errors to PostHog. Suplex does not send code, prompts, repository names, or file paths.</span>
      <div className="min-w-0 flex-1 sm:w-56 sm:flex-none"><Input size="sm" type="email" aria-label="Email address (optional)" placeholder="Email address (optional)" value={email} onChange={(event) => { setEmail(event.target.value); setMessage(""); }} /></div>
      <label className="flex items-center gap-2 text-xs"><Checkbox checked={sessionReplay} onCheckedChange={(checked) => setSessionReplay(checked === true)} />Record masked session replays</label>
      <Button type="submit" size="xs" disabled={sending}>Accept</Button>
      <Button render={<a href={withCompany("/admin/environment", companyId)} />} variant="link" size="xs">Open settings</Button>
      {message ? <span role="alert" className="w-full text-xs text-destructive">{message}</span> : null}
      {sessionReplay ? <span className="w-full text-xs text-muted-foreground">Replays mask all text and inputs. They exclude terminal, code, prompt, and image content.</span> : null}
    </form>
  );
}
