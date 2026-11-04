import { lazy, Suspense, useEffect, useState, type ReactElement } from "react";

import { Button } from "../../components/ui/button.js";
import { readJsonUnchecked } from "../../lib/api.js";

const PaneTerminal = lazy(() => import("../tasks/task-chat/live-pane-terminal.js").then(module => ({ default: module.PaneTerminal })));

export type ProviderLoginSession = { paneId: string; label: string; kind: "login" | "install" };

export function useProviderLogin({ reload }: { reload: (silent?: boolean) => Promise<void> }): {
  login: ProviderLoginSession | null;
  loginPending: string | null;
  startLogin: (key: string, label: string, url: string) => Promise<void>;
  startInstall: (key: string, label: string, url: string) => Promise<void>;
  closeLogin: () => Promise<void>;
} {
  const [login, setLogin] = useState<ProviderLoginSession | null>(null);
  const [loginPending, setLoginPending] = useState<string | null>(null);

  useEffect(() => {
    if (!login) return;
    const timer = window.setInterval(() => { void reload(true); }, 3_000);
    return () => window.clearInterval(timer);
  }, [login, reload]);

  const open = async (kind: ProviderLoginSession["kind"], key: string, label: string, url: string): Promise<void> => {
    setLoginPending(key);
    try {
      const session = await readJsonUnchecked<{ paneId: string }>(url, { method: "POST" });
      setLogin({ paneId: session.paneId, label, kind });
    } finally {
      setLoginPending(null);
    }
  };
  const startLogin = (key: string, label: string, url: string): Promise<void> => open("login", key, label, url);
  const startInstall = (key: string, label: string, url: string): Promise<void> => open("install", key, label, url);

  const closeLogin = async (): Promise<void> => {
    const session = login;
    setLogin(null);
    if (session) await readJsonUnchecked(`/api/admin/provider-login/${encodeURIComponent(session.paneId)}`, { method: "DELETE" }).catch(() => undefined);
    await reload(true);
  };

  return { login, loginPending, startLogin, startInstall, closeLogin };
}

export function ProviderLoginTerminal({ login, onClose }: { login: ProviderLoginSession | null; onClose: () => void }): ReactElement | null {
  if (!login) return null;
  const install = login.kind === "install";
  return <div className="fixed inset-x-0 bottom-0 z-50 flex h-64 flex-col border-t border-border bg-background" role="region" aria-label={`${install ? "Install" : "Sign-in"} terminal for ${login.label}`}>
    <div className="flex h-9 shrink-0 items-center justify-between gap-2 px-4">
      <span className="truncate text-xs font-medium">{install ? "Install" : "Login"}: {login.label}</span>
      <Button size="sm" variant="outline" onClick={onClose}>Done</Button>
    </div>
    <div className="min-h-0 flex-1 px-2 pb-2">
      <Suspense fallback={null}><PaneTerminal path={`/api/admin/provider-login/${encodeURIComponent(login.paneId)}/terminal`} interactive paneId={login.paneId} label={`${install ? "Install" : "Sign-in"} pane for ${login.label}`} /></Suspense>
    </div>
  </div>;
}
