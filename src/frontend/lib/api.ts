export type ApiUser = {
  id: string;
  displayName: string;
  username: string;
  role: "admin" | "member";
  status: "pending" | "active" | "revoked";
  companyIds: string[];
};

export type CompanyStatus = "active" | "paused" | "archived";

export type ApiCompany = {
  id: string;
  name: string;
  status: CompanyStatus;
  createdAt: string;
};

export class ApiError extends Error {
  readonly statusCode: number;
  readonly findings?: Array<{ field: string; message: string }>;

  constructor(message: string, statusCode: number, findings?: Array<{ field: string; message: string }>) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
    if (findings) this.findings = findings;
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
  const originToken = !isSafe ? cookieValue("forge_origin") : undefined;
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(originToken ? { "X-Forge-Origin": originToken } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  let body: T & { error?: string; findings?: Array<{ field: string; message: string }> } = {} as T & { error?: string; findings?: Array<{ field: string; message: string }> };
  try {
    body = (text ? JSON.parse(text) : {}) as T & { error?: string; findings?: Array<{ field: string; message: string }> };
  } catch {
    body = {} as T & { error?: string; findings?: Array<{ field: string; message: string }> };
  }
  if (!response.ok) {
    throw new ApiError(body.error ?? "Request failed", response.status, body.findings);
  }
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

export function companyInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "C";
  return words.slice(0, 2).map((word) => word[0]).join("").toUpperCase() || "C";
}
