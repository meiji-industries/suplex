import { createInterface, type Interface } from "node:readline";
import { z } from "zod";

const JsonRpcEnvelopeSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.unknown().optional(),
}).strict();

export interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

type Writable = { write(chunk: string): boolean };

/** Minimal MCP stdio JSON-RPC server: initialize, tools/list, and tools/call over newline-delimited JSON. */
export function startMcpStdioTransport(input: {
  serverName: string;
  tools: readonly McpTool[];
  call(name: string, args: Record<string, unknown>): Promise<unknown>;
  /** Maps a tool result onto MCP content when the default text plus structured content is wrong for it. */
  present?(result: unknown): McpToolResult | undefined;
  failureMessage: string;
  stdin: NodeJS.ReadableStream;
  stdout: Writable;
}): Interface {
  const lineReader = createInterface({ input: input.stdin, crlfDelay: Infinity });
  const toolNames = new Set(input.tools.map(tool => tool.name));
  let initialized = false;
  const respond = (id: string | number, result: unknown): void => {
    input.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  };
  const fail = (id: string | number | null, code: number, message: string): void => {
    input.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
  };
  lineReader.on("line", async (line) => {
    let request: z.infer<typeof JsonRpcEnvelopeSchema> | undefined;
    try {
      request = JsonRpcEnvelopeSchema.parse(JSON.parse(line));
      if (request.method === "notifications/initialized") {
        if (!initialized) throw new Error("MCP client sent initialized before initialize");
        return;
      }
      if (request.id === undefined) throw new Error("MCP notification is unsupported");
      if (request.method === "initialize") {
        const params = z.object({ protocolVersion: z.string(), capabilities: z.object({}).passthrough(), clientInfo: z.object({ name: z.string(), version: z.string() }).passthrough() }).strict().parse(request.params);
        initialized = true;
        respond(request.id, { protocolVersion: params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: input.serverName, version: "1" } });
        return;
      }
      if (!initialized) throw new Error("MCP client must initialize before calling tools");
      if (request.method === "tools/list") {
        respond(request.id, { tools: input.tools });
        return;
      }
      if (request.method !== "tools/call") {
        fail(request.id, -32601, "MCP method is unsupported");
        return;
      }
      const params = z.object({ name: z.string(), arguments: z.object({ _meta: z.unknown().optional() }).passthrough(), _meta: z.unknown().optional() }).strict().parse(request.params);
      if (!toolNames.has(params.name)) throw new Error(`MCP tool is unsupported: ${params.name}`);
      try {
        const argumentsWithoutMetadata = { ...params.arguments };
        delete argumentsWithoutMetadata._meta;
        const result = await input.call(params.name, argumentsWithoutMetadata);
        respond(request.id, input.present?.(result) ?? { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
      } catch (error) {
        respond(request.id, { content: [{ type: "text", text: error instanceof Error ? error.message : input.failureMessage }], isError: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : input.failureMessage;
      const id = typeof request?.id === "string" || typeof request?.id === "number" ? request.id : null;
      fail(id, -32600, message);
    }
  });
  return lineReader;
}
