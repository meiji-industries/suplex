import { Check, Copy, ExternalLink } from "lucide-react";
import { useEffect, useState, type ReactElement } from "react";

import { Button } from "../../components/ui/button.js";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "../../components/ui/select.js";
import { readJsonUnchecked } from "../../lib/api.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { SettingRow, SettingsSection } from "../settings/settings-layout.js";
import { DEFAULT_MCP_CLIENT_ID, MCP_CLIENT_GROUPS, MCP_CLIENTS, mcpClient } from "./mcp-clients.js";

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
  const [clientId, setClientId] = useState(DEFAULT_MCP_CLIENT_ID);
  const client = mcpClient(clientId);
  const clientSnippet = mcpUrl ? client.render(mcpUrl) : "";
  const httpsAddressHint = "Open Remote Access and save an HTTPS address.";
  const skillCommand = "npx skills add meiji-industries/suplex-skills --skill suplex --global";
  const environment =`SUPLEX_BASE_URL=${baseUrl}\nSUPLEX_AGENT_CREDENTIAL=<returned credential>`;
  const stdioConfig = `[mcp_servers.suplex]\ncommand = "suplex"\nargs = ["mcp"]\nenv_vars = ["SUPLEX_BASE_URL", "SUPLEX_AGENT_CREDENTIAL"]`;
  const stdioJson = JSON.stringify({ mcpServers: { suplex: { command: "suplex", args: ["mcp"], env: { SUPLEX_BASE_URL: baseUrl, SUPLEX_AGENT_CREDENTIAL: "<returned credential>" } } } }, null, 2);
  const clientDescription = !address
    ? "Suplex is reading the canonical MCP address."
    : address.kind === "not_available"
      ? `OAuth is not available. ${httpsAddressHint}`
      : <>{client.description}<CodeBlock>{clientSnippet}</CodeBlock>{address.kind === "loopback" ? <p className="mt-2">Suplex advertises a loopback address that remote clients cannot reach. {httpsAddressHint}</p> : null}</>;
  return (
    <>
      <SettingsSection title="Connect an external client" description="Select your client. Suplex shows the setup for that client. Suplex asks you to approve the company and projects.">
        <SettingRow label="Client" htmlFor="mcp-client">
          <Select value={clientId} onValueChange={(value) => { if (value) setClientId(value); }}>
            <SelectTrigger id="mcp-client" aria-label="Client"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MCP_CLIENT_GROUPS.map((group) => (
                <SelectGroup key={group}>
                  <SelectLabel>{group}</SelectLabel>
                  {MCP_CLIENTS.filter((entry) => entry.group === group).map((entry) => <SelectItem key={entry.id} value={entry.id}>{entry.label}</SelectItem>)}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>
        </SettingRow>
        <SettingRow label={client.label} description={clientDescription}>
          {mcpUrl ? <div className="flex flex-col items-end gap-1"><CopyButton text={clientSnippet} label={`Copy the ${client.label} setup`} />{client.docsUrl ? <OpenLink href={client.docsUrl}>{`Open the ${client.label} docs`}</OpenLink> : null}</div> : null}
        </SettingRow>
        <SettingRow label="Suplex skill" description={<>Run this command on the client computer. The skill gives the agent the rules for Suplex tasks.<CodeBlock>{skillCommand}</CodeBlock></>}>
          <CopyButton text={skillCommand} label="Copy the skill command" />
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Advanced API and stdio setup" description="Create an external agent to use the HTTP API or the local stdio bridge. Exchange its pairing code once.">
        <SettingRow label="Environment" description={<>Store the credential privately. Never paste it into chat, logs, shell history, or source control.<CodeBlock>{environment}</CodeBlock></>}>
          <CopyButton text={environment} label="Copy the environment" />
        </SettingRow>
        <SettingRow label="Stdio bridge" description={<>Add this server to the Codex config.toml. The bridge reads both variables from the environment.<CodeBlock>{stdioConfig}</CodeBlock></>}>
          <CopyButton text={stdioConfig} label="Copy the stdio configuration" />
        </SettingRow>
        <SettingRow label="Stdio bridge for JSON clients" description={<>Add this server to a client that uses mcpServers JSON. Keep this file private because it holds the credential.<CodeBlock>{stdioJson}</CodeBlock></>}>
          <CopyButton text={stdioJson} label="Copy the stdio JSON configuration" />
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
