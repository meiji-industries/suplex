import type { AuthUserResponse, CompanyResponse } from "../../http/contracts/common.js";
import { clientTabId, reportApiActivity, reportAuthenticatedResume } from "../shell/client-lifecycle.js";

export type ApiUser = AuthUserResponse;
export type ApiCompany = CompanyResponse;
export type CompanyStatus = ApiCompany["status"];

export class ApiError extends Error {
  readonly statusCode: number;
  readonly findings?: Array<{ field: string; message: string }>;
  readonly current?: unknown;

  constructor(message: string, statusCode: number, findings?: Array<{ field: string; message: string }>, current?: unknown) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    if (findings) this.findings = findings;
    if (current !== undefined) this.current = current;
  }
}

function cookieValue(name: string): string | undefined {
  return document.cookie
    .split(";")
    .map((pair) => pair.trim().split("=", 2))
    .find(([key]) => key === name)?.[1];
}

export async function readJson<T>(url: string, init?: RequestInit): Promise<T> {
  const method = init?.method?.toUpperCase() ?? "GET";
  const isSafe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  const originToken = !isSafe ? cookieValue("csrf_v1") : undefined;
  let clientId: string | undefined;
  try { if (!isSafe) clientId = clientTabId(); } catch { /* Telemetry cannot block a mutation. */ }
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(originToken ? { "X-CSRF-V1": originToken } : {}),
      ...(clientId ? { "X-Suplex-Tab-Id": clientId } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: T & { error?: string; findings?: Array<{ field: string; message: string }>; current?: unknown } = {} as T & { error?: string; findings?: Array<{ field: string; message: string }>; current?: unknown };
  try {
    body = (text ? JSON.parse(text) : {}) as T & { error?: string; findings?: Array<{ field: string; message: string }>; current?: unknown };
  } catch {
    body = {} as T & { error?: string; findings?: Array<{ field: string; message: string }>; current?: unknown };
  }
  if (!response.ok) {
    throw new ApiError(body.error ?? "Request failed", response.status, body.findings, body.current);
  }
  if (url.startsWith("/api/auth/") && url.endsWith("/verify")) reportAuthenticatedResume(true);
  else if (url.startsWith("/api/")) reportApiActivity();
  return body;
}

export function isApiError(error: unknown, statusCode?: number): error is ApiError {
  return error instanceof ApiError && (statusCode === undefined || error.statusCode === statusCode);
}

export function withCompany(path: string, companyId?: string): string {
  if (!companyId) return path;
  const [pathnameAndQuery, hash] = path.split("#", 2);
  const [pathname, query = ""] = pathnameAndQuery!.split("?", 2);
  const params = new URLSearchParams(query);
  params.set("company", companyId);
  const suffix = params.toString();
  return `${pathname}${suffix ? `?${suffix}` : ""}${hash ? `#${hash}` : ""}`;
}

export function companySettingsPath(companyId: string): string {
  return withCompany(`/companies/${encodeURIComponent(companyId)}/settings`, companyId);
}
