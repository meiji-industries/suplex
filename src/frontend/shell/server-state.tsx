import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import { useContext, useEffect, useState, type ReactNode } from "react";
import { useCompanyContext } from "./company-context.js";
import { ApiError } from "../lib/api.js";

function UserServerState({ children }: { children: ReactNode }) {
  const [client] = useState(() => new QueryClient({
    defaultOptions: {
      queries: {
        retry: (failureCount, error) => failureCount < 1 && !(error instanceof ApiError && [401, 403, 404].includes(error.statusCode)),
      },
    },
  }));
  useEffect(() => () => client.clear(), [client]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function ServerStateProvider({ children }: { children: ReactNode }) {
  const { user } = useCompanyContext();
  return <UserServerState key={user?.id ?? "signed-out"}>{children}</UserServerState>;
}

export function useSignOut() {
  const client = useContext(QueryClientContext);
  return async () => {
    try { await fetch("/api/auth/sign-out", { method: "POST" }); }
    finally {
      try { client?.clear(); }
      finally {
        window.localStorage.removeItem("suplex.activeCompanyId");
        window.location.assign("/auth");
      }
    }
  };
}
