import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "../../components/ui/button.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { copyToClipboard } from "../../lib/clipboard.js";
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
  return <Button variant="ghost" size="sm" aria-label={label} onClick={() => void copyToClipboard(text, `Copied ${label.slice("Copy ".length)} to clipboard`).then(setCopied)}>{copied ? <Check /> : <Copy />}{copied ? "Copied" : "Copy"}</Button>;
}

function OpenLink({ href, children }: { href: string; children: string }): ReactElement {
  return <Button variant="ghost" size="sm" nativeButton={false} render={<a href={href} target="_blank" rel="noreferrer" />}>{children}<ExternalLink /></Button>;
}

export function ExternalAgentConnectionGuide(): ReactElement {
  const baseUrl = window.location.origin;
  const [address, setAddress] = useState<McpAddress>();
  useEffect(() => {
    void readJsonUnchecked<{ resource?: unknown }>("/.well-known/oauth-protected-resource/mcp")
      .then((metadata) => setAddress(mcpAddress(metadata, window.location.hostname)))
      .catch(() => setAddress({ kind: "not_available" }));
  }, []);
  const mcpUrl = address && address.kind !== "not_available" ? address.url : undefined;
  const claudeCommands = mcpUrl ? `claude mcp add --transport http suplex ${mcpUrl}\nclaude mcp login suplex` : "";
  const httpsAddressHint = "Open Remote Access and save an HTTPS address.";
  const skillCommand = "npx skills add meiji-industries/suplex-skills --skill suplex --global";
  const environment =`SUPLEX_BASE_URL=${baseUrl}\nSUPLEX_AGENT_CREDENTIAL=<returned credential>`;
  const stdioConfig = `[mcp_servers.suplex]\ncommand = "suplex"\nargs = ["mcp"]\nenv_vars = ["SUPLEX_BASE_URL", "SUPLEX_AGENT_CREDENTIAL"]`;
  const claudeDescription = !address
    ? "Suplex is reading the canonical MCP address."
    : address.kind === "not_available"
      ? `OAuth is not available. ${httpsAddressHint}`
      : <>Run these commands. You can also run <code>/mcp</code> in Claude Code and select <code>Authenticate</code>.<CodeBlock>{claudeCommands}</CodeBlock>{address.kind === "loopback" ? <p className="mt-2">Suplex advertises a loopback address that remote clients cannot reach. {httpsAddressHint}</p> : null}</>;
  return (
    <>
      <SettingsSection title="Connect an external client" description="Connect Claude Code to Suplex with OAuth. Suplex asks you to approve the company and projects.">
        <SettingRow label="Claude Code" description={claudeDescription}>
          {mcpUrl ? <CopyButton text={claudeCommands} label="Copy the Claude Code commands" /> : null}
        </SettingRow>
        <SettingRow label="Suplex skill" description={<>Run this command on the client computer. The skill gives the agent the rules for Suplex tasks.<CodeBlock>{skillCommand}</CodeBlock></>}>
          <CopyButton text={skillCommand} label="Copy the skill command" />
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

export type McpAddress =
  | { kind: "ready"; url: string }
  | { kind: "loopback"; url: string }
  | { kind: "not_available" };

const loopbackHosts = new Set(["127.0.0.1", "[::1]", "::1", "localhost"]);

/** The advertised MCP address, judged from the page that shows it. A loopback
 * address shown on a remote page means the HTTPS address is not set. */
export function mcpAddress(metadata: { resource?: unknown } | undefined, pageHostname: string): McpAddress {
  const url = metadata ? canonicalMcpResource(metadata) : undefined;
  if (!url) return { kind: "not_available" };
  if (loopbackHosts.has(new URL(url).hostname) && !loopbackHosts.has(pageHostname)) return { kind: "loopback", url };
  return { kind: "ready", url };
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
