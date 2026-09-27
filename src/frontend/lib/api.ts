import type { AuthUserResponse, CompanyResponse } from "../contracts/common.js";
import { clientTabId, reportApiActivity, reportAuthenticatedResume } from "../shell/client-lifecycle.js";

export type ApiUser = AuthUserResponse;
export type ApiCompany = CompanyResponse;
export type CompanyStatus = ApiCompany["status"];
export type ApiFinding = { code?: string | undefined; field: string; message: string };

export class ApiError extends Error {
  readonly statusCode: number;
  readonly findings?: ApiFinding[];
  readonly current?: unknown;

  constructor(message: string, statusCode: number, findings?: ApiFinding[], current?: unknown) {
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

function errorField(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null && key in value ? Reflect.get(value, key) : undefined;
}

function parseFinding(value: unknown): ApiFinding | undefined {
  const field = errorField(value, "field");
  const message = errorField(value, "message");
  const code = errorField(value, "code");
  if (typeof field !== "string" || typeof message !== "string" || (code !== undefined && typeof code !== "string")) return undefined;
  return { ...(code === undefined ? {} : { code }), field, message };
}

export async function readJson(url: string, init?: RequestInit): Promise<unknown> {
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
  let body: unknown = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = {};
  }
  if (!response.ok) {
    const error = errorField(body, "error");
    const findings = errorField(body, "findings");
    throw new ApiError(
      typeof error === "string" ? error : "Request failed",
      response.status,
      Array.isArray(findings) ? findings.flatMap(finding => {
        const parsed = parseFinding(finding);
        return parsed ? [parsed] : [];
      }) : undefined,
      errorField(body, "current"),
    );
  }
  if (url.startsWith("/api/auth/") && url.endsWith("/verify")) reportAuthenticatedResume(true);
  else if (url.startsWith("/api/")) reportApiActivity();
  return body;
}

export function readJsonUnchecked<T>(url: string, init?: RequestInit): Promise<T> {
  return readJson(url, init) as Promise<T>;
}

export function isApiError(error: unknown, statusCode?: number): error is ApiError {
  return error instanceof ApiError && (statusCode === undefined || error.statusCode === statusCode);
}

export function hasApiFinding(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.findings?.some(finding => finding.code === code) === true;
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
