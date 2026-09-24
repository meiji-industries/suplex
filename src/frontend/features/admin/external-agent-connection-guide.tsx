import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "../../components/ui/button.js";
import { readJson } from "../../lib/api.js";
import { SettingRow, SettingsSection } from "../settings/settings-layout.js";

function CodeBlock({ children }: { children: string }): ReactElement {
  return (
    <pre className="mt-2 overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs text-foreground">
      <code>{children}</code>
    </pre>
  );
}

function CopyButton({ text, label }: { text: string; label: string }): ReactElement {
  const [copied, setCopied] = useState(false);
  return <Button variant="ghost" size="sm" aria-label={label} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), () => setCopied(false))}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>;
}

function OpenLink({ href, children }: { href: string; children: string }): ReactElement {
  return <Button variant="ghost" size="sm" nativeButton={false} render={<a href={href} target="_blank" rel="noreferrer" />}>{children}<ExternalLink /></Button>;
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
  const claudeCommands = mcpUrl ? `claude mcp add --transport http suplex ${mcpUrl}\nclaude mcp login suplex` : "";
  const environment = `SUPLEX_BASE_URL=${baseUrl}\nSUPLEX_AGENT_CREDENTIAL=<returned credential>`;
  const stdioConfig = `[mcp_servers.suplex]\ncommand = "suplex"\nargs = ["mcp"]\nenv_vars = ["SUPLEX_BASE_URL", "SUPLEX_AGENT_CREDENTIAL"]`;
  return (
    <>
      <SettingsSection title="Connect an external client" description="Connect Claude Code to Suplex with OAuth. Suplex asks you to approve the company and projects.">
        <SettingRow label="Claude Code" description={mcpUrl ? <>Run these commands. You can also run <code>/mcp</code> in Claude Code and select <code>Authenticate</code>.<CodeBlock>{claudeCommands}</CodeBlock></> : "Suplex is reading the canonical MCP address."}>
          {mcpUrl ? <CopyButton text={claudeCommands} label="Copy the Claude Code commands" /> : null}
        </SettingRow>
        <SettingRow label="Remote MCP clients" description={<>Use {mcpUrl ? <code>{mcpUrl}</code> : "the MCP address"} in clients that support Streamable HTTP and OAuth. Remote web clients need reachable HTTPS. Suplex has not tested the ChatGPT or Claude web setup in this release.</>} />
      </SettingsSection>
      <SettingsSection title="Advanced API and stdio setup" description="Create an external agent to use the HTTP API or the local stdio bridge. Exchange its pairing code once.">
        <SettingRow label="Environment" description={<>Store the credential privately. Never paste it into chat, logs, shell history, or source control.<CodeBlock>{environment}</CodeBlock></>}>
          <CopyButton text={environment} label="Copy the environment" />
        </SettingRow>
        <SettingRow label="Stdio bridge" description={<>Add this server to the MCP configuration of the client.<CodeBlock>{stdioConfig}</CodeBlock></>}>
          <CopyButton text={stdioConfig} label="Copy the stdio configuration" />
        </SettingRow>
        <SettingRow label="HTTP-only operations" description="Delivery refresh, repair, decisions, approvals, merge-train, merge, provenance, and administration use the HTTP API. MCP covers the other task operations.">
          <OpenLink href="/.well-known/suplex/api-catalog.json">Open the API catalog</OpenLink>
        </SettingRow>
      </SettingsSection>
    </>
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
