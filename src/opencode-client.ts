import {
  OpenCodeConfigSchema,
  OpenCodeHealthSchema,
  OpenCodeMcpStatusSchema,
  OpenCodeMessageEnvelopeSchema,
  OpenCodePromptRequestSchema,
  OpenCodeSessionCreateRequestSchema,
  OpenCodeSessionSchema,
  OpenCodeSessionStatusMapSchema,
  type OpenCodeConfig,
  type OpenCodeHealth,
  type OpenCodeMcpStatus,
  type OpenCodeMessageEnvelope,
  type OpenCodePromptRequest,
  type OpenCodeSessionCreateRequest,
  type OpenCodeSession,
  type OpenCodeSessionStatus,
} from "./opencode-contracts.js";

export type OpenCodeFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

export type OpenCodeFailureCode =
  | "invalid_address"
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "unexpected_status"
  | "invalid_response"
  | "server_unavailable"
  | "timeout";

export class OpenCodeFailure extends Error {
  constructor(
    readonly code: OpenCodeFailureCode,
    readonly retryable: boolean,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "OpenCodeFailure";
  }
}

export interface OpenCodeClientOptions {
  baseUrl: string;
  password: string;
  username?: string;
  timeoutMs?: number;
  fetch?: OpenCodeFetch;
}

export interface OpenCodeSessionQuery {
  directory?: string;
  workspace?: string;
}

export interface OpenCodeMessagesQuery extends OpenCodeSessionQuery {
  before?: string;
  limit?: number;
}

export interface OpenCodeCreateSessionInput {
  title: string;
  directory?: string;
  model: { id: string; providerID: string; variant?: string };
  agent: string;
  metadata?: Record<string, unknown>;
}

export interface OpenCodePromptInput {
  sessionID: string;
  messageID: string;
  text: string;
  model: { providerID: string; modelID: string };
  agent: string;
  variant: string;
  directory?: string;
  noReply?: boolean;
  system?: string;
  tools?: Record<string, boolean>;
}

function loopbackAddress(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new OpenCodeFailure("invalid_address", false, "OpenCode server address is invalid");
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  if (![
    "127.0.0.1",
    "localhost",
    "::1",
  ].includes(host))
    throw new OpenCodeFailure("invalid_address", false, "OpenCode server address must be loopback");
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new OpenCodeFailure("invalid_address", false, "OpenCode server address must use HTTP");
  if (parsed.username || parsed.password || parsed.hash)
    throw new OpenCodeFailure("invalid_address", false, "OpenCode server address must not contain credentials");
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  parsed.search = "";
  return parsed;
}

function queryUrl(base: URL, path: string, query: Record<string, string | number | undefined>): string {
  const url = new URL(path, `${base.toString()}/`);
  for (const [key, value] of Object.entries(query))
    if (value !== undefined) url.searchParams.set(key, String(value));
  return url.toString();
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

function failureForStatus(status: number, path: string): OpenCodeFailure {
  if (status === 401 || status === 403)
    return new OpenCodeFailure("unauthorized", false, `OpenCode rejected ${path}`, status);
  if (status === 404)
    return new OpenCodeFailure("not_found", false, `OpenCode resource was not found at ${path}`, status);
  if (status === 408 || status === 429 || status >= 500)
    return new OpenCodeFailure("server_unavailable", true, `OpenCode server returned ${status} for ${path}`, status);
  return new OpenCodeFailure("unexpected_status", false, `OpenCode server returned ${status} for ${path}`, status);
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export class OpenCodeClient {
  readonly baseUrl: string;
  private readonly address: URL;
  private readonly username: string;
  private readonly password: string;
  private readonly timeoutMs: number;
  private readonly fetcher: OpenCodeFetch;

  constructor(options: OpenCodeClientOptions) {
    this.address = loopbackAddress(options.baseUrl);
    this.baseUrl = this.address.toString().replace(/\/$/, "");
    if (!options.password) throw new OpenCodeFailure("invalid_request", false, "OpenCode server password is required");
    this.username = options.username ?? "opencode";
    this.password = options.password;
    this.timeoutMs = options.timeoutMs ?? 10_000;
    this.fetcher = options.fetch ?? fetch;
  }

  async health(): Promise<OpenCodeHealth> {
    return this.request("GET", "/global/health", OpenCodeHealthSchema);
  }

  async mcpStatus(directory: string): Promise<OpenCodeMcpStatus> {
    return this.request("GET", "/mcp", OpenCodeMcpStatusSchema, undefined, { directory });
  }

  async getConfig(directory?: string): Promise<OpenCodeConfig> {
    return this.request("GET", "/config", OpenCodeConfigSchema, undefined, { directory });
  }

  async createSession(input: OpenCodeCreateSessionInput): Promise<OpenCodeSession> {
    const request: OpenCodeSessionCreateRequest = {
      title: input.title,
      agent: input.agent,
      model: input.model,
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    const parsed = OpenCodeSessionCreateRequestSchema.safeParse(request);
    if (!parsed.success) throw new OpenCodeFailure("invalid_request", false, "OpenCode session request is invalid");
    return this.request("POST", "/session", OpenCodeSessionSchema, parsed.data, { directory: input.directory });
  }

  async getSession(sessionID: string, directory?: string): Promise<OpenCodeSession> {
    return this.request("GET", `/session/${encodeURIComponent(sessionID)}`, OpenCodeSessionSchema, undefined, { directory });
  }

  async getMessages(sessionID: string, query: OpenCodeMessagesQuery = {}): Promise<OpenCodeMessageEnvelope[]> {
    return this.request("GET", `/session/${encodeURIComponent(sessionID)}/message`, OpenCodeMessageEnvelopeSchema.array(), undefined, { ...query });
  }

  async getStatus(directory?: string): Promise<Record<string, OpenCodeSessionStatus>> {
    return this.request("GET", "/session/status", OpenCodeSessionStatusMapSchema, undefined, { directory });
  }

  async promptAsync(input: OpenCodePromptInput): Promise<void> {
    const request: OpenCodePromptRequest = {
      messageID: input.messageID,
      model: input.model,
      agent: input.agent,
      variant: input.variant,
      parts: [{ type: "text", text: input.text }],
      ...(input.noReply === undefined ? {} : { noReply: input.noReply }),
      ...(input.system === undefined ? {} : { system: input.system }),
      ...(input.tools === undefined ? {} : { tools: input.tools }),
    };
    OpenCodePromptRequestSchema.parse(request);
    await this.request("POST", `/session/${encodeURIComponent(input.sessionID)}/prompt_async`, undefined, request, { directory: input.directory }, 204);
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } } | undefined,
    body?: unknown,
    query: Record<string, string | number | undefined> = {},
    expectedStatus = 200,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const url = queryUrl(this.address, path, query);
    try {
      const response = await this.fetcher(url, {
        method,
        headers: {
          accept: "application/json",
          authorization: basicAuth(this.username, this.password),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        redirect: "error",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: controller.signal,
      });
      if (response.status !== expectedStatus) throw failureForStatus(response.status, path);
      if (expectedStatus === 204) return undefined as T;
      let parsed: unknown;
      try {
        parsed = await response.json();
      } catch {
        throw new OpenCodeFailure("invalid_response", false, `OpenCode returned invalid JSON for ${path}`);
      }
      if (!schema) return parsed as T;
      const result = schema.safeParse(parsed);
      if (!result.success)
        throw new OpenCodeFailure("invalid_response", false, `OpenCode returned an invalid v1 envelope for ${path}`);
      return result.data;
    } catch (error) {
      if (error instanceof OpenCodeFailure) throw error;
      if (isAbort(error)) throw new OpenCodeFailure("timeout", true, `OpenCode request timed out for ${path}`);
      throw new OpenCodeFailure("server_unavailable", true, `OpenCode server could not be reached for ${path}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
