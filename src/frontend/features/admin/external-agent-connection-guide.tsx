import { useEffect, useState, type ReactElement } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../components/ui/accordion.js";
import { readJson } from "../../lib/api.js";

function CodeBlock({ children }: { children: string }): ReactElement {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
      <code>{children}</code>
    </pre>
  );
}

export function ExternalAgentConnectionGuide(): ReactElement {
  const baseUrl = window.location.origin;
  const [mcpUrl, setMcpUrl] = useState<string>();
  useEffect(() => {
    void readJson<{ resource?: unknown }>("/.well-known/oauth-protected-resource/mcp").then((metadata) => {
      const resource = canonicalMcpResource(metadata);
      if (resource) setMcpUrl(resource);
    }).catch(() => undefined);
  }, []);
  return (
    <section aria-labelledby="external-agent-connections" className="space-y-3">
      <div className="space-y-1">
        <h2 id="external-agent-connections" className="text-sm font-medium">
          Connect an external client
        </h2>
        <p className="text-xs text-muted-foreground">
          Connect Claude Code to Forge with OAuth. Forge asks you to approve the company and projects.
        </p>
      </div>
      {mcpUrl ? <CodeBlock>{`claude mcp add --transport http forge ${mcpUrl}\nclaude mcp login forge`}</CodeBlock> : <p className="text-xs text-muted-foreground">Forge is reading the canonical MCP address.</p>}
      <p className="text-xs text-muted-foreground">
        You can also run <code>/mcp</code> in Claude Code and select <code>Authenticate</code>.
      </p>
      <Accordion>
        <AccordionItem value="remote-clients">
          <AccordionTrigger>Remote MCP clients</AccordionTrigger>
          <AccordionContent>
            <p>Use <code>{mcpUrl}</code> in clients that support Streamable HTTP and OAuth. Remote web clients need reachable HTTPS.</p>
            <p>Forge has not tested the ChatGPT or Claude web setup in this release.</p>
            <a href="https://modelcontextprotocol.io/specification/latest/basic/authorization" target="_blank" rel="noreferrer">Open the MCP authorization specification</a>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="advanced">
          <AccordionTrigger>Advanced API and stdio setup</AccordionTrigger>
          <AccordionContent>
            <p>Create an external agent to use the HTTP API or the local stdio bridge. Exchange its pairing code once.</p>
            <CodeBlock>{`FORGE_BASE_URL=${baseUrl}\nFORGE_AGENT_CREDENTIAL=<returned credential>`}</CodeBlock>
            <p>Store the credential privately. Never paste it into chat, logs, shell history, or source control.</p>
            <CodeBlock>{`[mcp_servers.forge]\ncommand = "forge"\nargs = ["mcp"]\nenv_vars = ["FORGE_BASE_URL", "FORGE_AGENT_CREDENTIAL"]`}</CodeBlock>
            <p><a href="/.well-known/forge/api-catalog.json">Open the public API catalog</a></p>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
      <p className="text-xs text-muted-foreground">
        MCP covers identity, capabilities, workflow and template discovery, task reads,
        task creation, dependencies, and lifecycle commands. Delivery refresh, repair,
        decisions, approvals, merge-train, merge, provenance, and administration remain HTTP-only.
      </p>
    </section>
  );
}

export function canonicalMcpResource(metadata: { resource?: unknown }): string | undefined {
  if (typeof metadata.resource !== "string") return undefined;
  try {
    const url = new URL(metadata.resource);
    if (url.pathname !== "/mcp" || url.search || url.hash || url.username || url.password) return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}
