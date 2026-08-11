import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactElement, type ReactNode } from "react";

import { companySettingsPath, readJson, withCompany, type ApiCompany, type ApiUser, type CompanyStatus } from "../../lib/api.js";

const activeCompanyStorageKey = "forge.activeCompanyId";

export type CompanyContextValue = {
  user?: ApiUser;
  companies: ApiCompany[];
  currentCompany?: ApiCompany;
  loading: boolean;
  error?: string;
  selectCompany: (companyId: string) => void;
  createCompany: (name: string) => Promise<ApiCompany>;
  renameCompany: (companyId: string, name: string) => Promise<ApiCompany>;
  setCompanyStatus: (companyId: string, status: CompanyStatus) => Promise<ApiCompany>;
  reloadCompanies: () => Promise<void>;
};

const CompanyContext = createContext<CompanyContextValue | undefined>(undefined);

function sortCompanies(companies: ApiCompany[]): ApiCompany[] {
  const order: Record<CompanyStatus, number> = { active: 0, paused: 1, archived: 2 };
  return [...companies].sort((left, right) => order[left.status] - order[right.status] || left.name.localeCompare(right.name));
}

function replaceCompanyLocation(companyId?: string, detailRoot?: string): void {
  const url = new URL(window.location.href);
  if (detailRoot) url.pathname = detailRoot;
  if (companyId) url.searchParams.set("company", companyId);
  else url.searchParams.delete("company");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function isScopedDetailPath(pathname: string, companyId: string): string | undefined {
  if (/^\/tasks\/[^/]+$/.test(pathname)) return "/tasks";
  if (/^\/projects\/[^/]+$/.test(pathname)) return "/projects";
  if (/^\/companies\/[^/]+\/settings$/.test(pathname)) return `/companies/${encodeURIComponent(companyId)}/settings`;
  return undefined;
}

export function CompanyProvider({ children }: { children: ReactNode }): ReactElement {
  const [user, setUser] = useState<ApiUser>();
  const [companies, setCompanies] = useState<ApiCompany[]>([]);
  const [currentCompany, setCurrentCompany] = useState<ApiCompany>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  const resolveSelection = useCallback((visibleCompanies: ApiCompany[]): void => {
    const visible = sortCompanies(visibleCompanies);
    const params = new URLSearchParams(window.location.search);
    const urlSelection = params.get("company");
    const storedSelection = window.localStorage.getItem(activeCompanyStorageKey);
    const selected = visible.find((company) => company.id === urlSelection)
      ?? visible.find((company) => company.id === storedSelection)
      ?? visible.find((company) => company.status === "active")
      ?? visible.find((company) => company.status === "paused")
      ?? visible.find((company) => company.status === "archived");
    setCurrentCompany(selected);
    if (selected) {
      window.localStorage.setItem(activeCompanyStorageKey, selected.id);
      if (urlSelection !== selected.id) replaceCompanyLocation(selected.id);
    } else {
      window.localStorage.removeItem(activeCompanyStorageKey);
      if (urlSelection) replaceCompanyLocation();
    }
  }, []);

  const reloadCompanies = useCallback(async (): Promise<void> => {
    setLoading(true);
    setError(undefined);
    try {
      const result = await readJson<{ companies: ApiCompany[] }>("/api/companies");
      setCompanies(sortCompanies(result.companies));
      resolveSelection(result.companies);
    } catch (reason) {
      setCompanies([]);
      setCurrentCompany(undefined);
      window.localStorage.removeItem(activeCompanyStorageKey);
      if (new URLSearchParams(window.location.search).has("company")) replaceCompanyLocation();
      setError(reason instanceof Error && reason.message === "Authentication required" ? "Unable to load companies" : "Unable to load companies");
    } finally {
      setLoading(false);
    }
  }, [resolveSelection]);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      readJson<{ user: ApiUser }>("/api/auth/me"),
      readJson<{ companies: ApiCompany[] }>("/api/companies"),
    ]).then(([me, result]) => {
      if (cancelled) return;
      setUser(me.user);
      setCompanies(sortCompanies(result.companies));
      resolveSelection(result.companies);
    }).catch((reason) => {
      if (cancelled) return;
      setCompanies([]);
      setCurrentCompany(undefined);
      window.localStorage.removeItem(activeCompanyStorageKey);
      setError(reason instanceof Error && reason.message === "Authentication required" ? "Unable to load companies" : "Unable to load companies");
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [resolveSelection]);

  const selectCompany = useCallback((companyId: string): void => {
    const selected = companies.find((company) => company.id === companyId);
    if (!selected) return;
    if (selected.id === currentCompany?.id) return;
    const detailRoot = isScopedDetailPath(window.location.pathname, selected.id);
    window.localStorage.setItem(activeCompanyStorageKey, selected.id);
    if (detailRoot?.startsWith("/companies/")) {
      window.location.assign(withCompany(detailRoot, selected.id));
      return;
    }
    replaceCompanyLocation(selected.id, detailRoot);
    setCurrentCompany(selected);
    window.dispatchEvent(new Event("forge:company-change"));
  }, [companies, currentCompany?.id]);

  const createCompany = useCallback(async (name: string): Promise<ApiCompany> => {
    const created = await readJson<ApiCompany>("/api/admin/companies", { method: "POST", body: JSON.stringify({ name }) });
    window.localStorage.setItem(activeCompanyStorageKey, created.id);
    await reloadCompanies();
    return created;
  }, [reloadCompanies]);

  const renameCompany = useCallback(async (companyId: string, name: string): Promise<ApiCompany> => {
    const renamed = await readJson<ApiCompany>(`/api/admin/companies/${encodeURIComponent(companyId)}`, { method: "PATCH", body: JSON.stringify({ name }) });
    await reloadCompanies();
    return renamed;
  }, [reloadCompanies]);

  const setCompanyStatus = useCallback(async (companyId: string, status: CompanyStatus): Promise<ApiCompany> => {
    const updated = await readJson<ApiCompany>(`/api/admin/companies/${encodeURIComponent(companyId)}/status/${status}`, { method: "POST", body: "{}" });
    await reloadCompanies();
    return updated;
  }, [reloadCompanies]);

  const value = useMemo<CompanyContextValue>(() => ({
    ...(user ? { user } : {}),
    companies,
    ...(currentCompany ? { currentCompany } : {}),
    loading,
    ...(error ? { error } : {}),
    selectCompany,
    createCompany,
    renameCompany,
    setCompanyStatus,
    reloadCompanies,
  }), [companies, createCompany, currentCompany, error, loading, reloadCompanies, renameCompany, selectCompany, setCompanyStatus, user]);
  return <CompanyContext.Provider value={value}>{children}</CompanyContext.Provider>;
}

export function useCompanyContext(): CompanyContextValue {
  const context = useContext(CompanyContext);
  if (!context) throw new Error("CompanyProvider is required");
  return context;
}

export function useOptionalCompanyContext(): CompanyContextValue | undefined {
  return useContext(CompanyContext);
}

export { activeCompanyStorageKey, companySettingsPath, withCompany };
