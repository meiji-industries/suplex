import type { ReactElement } from "react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../../components/ui/accordion.js";

function CodeBlock({ children }: { children: string }): ReactElement {
  return (
    <pre className="overflow-x-auto rounded-md border bg-muted/50 p-3 text-xs">
      <code>{children}</code>
    </pre>
  );
}

export function ExternalAgentConnectionGuide(): ReactElement {
  const baseUrl = window.location.origin;
  return (
    <section aria-labelledby="external-agent-connections" className="space-y-3">
      <div className="space-y-1">
        <h2 id="external-agent-connections" className="text-sm font-medium">
          Connect an external client
        </h2>
        <p className="text-xs text-muted-foreground">
          Use MCP for assistants. Use the HTTP API for software integrations.
        </p>
      </div>
      <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
        <li>Create an external agent and grant its projects.</li>
        <li>Exchange the single-use pairing code for a credential.</li>
        <li>Set the base URL and credential in the client process environment.</li>
      </ol>
      <CodeBlock>{`FORGE_BASE_URL=${baseUrl}\nFORGE_AGENT_CREDENTIAL=<returned credential>`}</CodeBlock>
      <p className="text-xs text-muted-foreground">
        Store the credential privately. Never paste it into chat, tool arguments,
        logs, shell history, or source control.
      </p>
      <Accordion>
        <AccordionItem value="claude-code">
          <AccordionTrigger>Claude Code</AccordionTrigger>
          <AccordionContent>
            <p>Add this private entry to <code>.mcp.json</code>. Claude Code expands the variables from its environment.</p>
            <CodeBlock>{`{\n  "mcpServers": {\n    "forge": {\n      "type": "stdio",\n      "command": "forge",\n      "args": ["mcp"],\n      "env": {\n        "FORGE_BASE_URL": "\${FORGE_BASE_URL}",\n        "FORGE_AGENT_CREDENTIAL": "\${FORGE_AGENT_CREDENTIAL}"\n      }\n    }\n  }\n}`}</CodeBlock>
            <p>From a source checkout, change the command to <code>pnpm</code> and use these absolute-path arguments.</p>
            <CodeBlock>{`"args": ["--dir", "/absolute/path/to/forge", "run", "forge", "mcp"]`}</CodeBlock>
            <a href="https://code.claude.com/docs/en/mcp#environment-variable-expansion-in-mcpjson" target="_blank" rel="noreferrer">Open the Claude Code MCP guide</a>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="codex">
          <AccordionTrigger>Codex</AccordionTrigger>
          <AccordionContent>
            <p>Add this server to <code>~/.codex/config.toml</code>. The <code>env_vars</code> list forwards values from the Codex process environment.</p>
            <CodeBlock>{`[mcp_servers.forge]\ncommand = "forge"\nargs = ["mcp"]\nenv_vars = ["FORGE_BASE_URL", "FORGE_AGENT_CREDENTIAL"]`}</CodeBlock>
            <p>For a source checkout, set <code>command = "pnpm"</code> and use the arguments below.</p>
            <CodeBlock>{`args = ["--dir", "/absolute/path/to/forge", "run", "forge", "mcp"]`}</CodeBlock>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="claude-desktop">
          <AccordionTrigger>Claude Desktop or manual MCP</AccordionTrigger>
          <AccordionContent>
            <p>Add this entry to the private client configuration. Replace both placeholders locally. Claude Desktop does not reliably inherit shell variables. Preserve the other server entries in the file.</p>
            <CodeBlock>{`{\n  "mcpServers": {\n    "forge": {\n      "command": "forge",\n      "args": ["mcp"],\n      "env": {\n        "FORGE_BASE_URL": "${baseUrl}",\n        "FORGE_AGENT_CREDENTIAL": "<returned credential>"\n      }\n    }\n  }\n}`}</CodeBlock>
            <p>For a source checkout, use <code>pnpm</code> as the command and the absolute-path arguments shown above.</p>
            <a href="https://py.sdk.modelcontextprotocol.io/get-started/real-host/#claude-desktop" target="_blank" rel="noreferrer">Open the MCP host configuration guide</a>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="chatgpt">
          <AccordionTrigger>ChatGPT desktop or web</AccordionTrigger>
          <AccordionContent>
            <p>In the ChatGPT desktop Code workspace, configure Forge in the Codex host file shown above. Local stdio is for desktop and CLI hosts.</p>
            <a href="https://learn.chatgpt.com/docs/extend/mcp?surface=cli" target="_blank" rel="noreferrer">Open the host MCP configuration guide</a>
            <p>Forge does not provide a remote MCP endpoint. ChatGPT web needs an HTTPS Streamable HTTP server or a secure MCP tunnel.</p>
            <a href="https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt" target="_blank" rel="noreferrer">Open the ChatGPT remote MCP guide</a>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="claude-web">
          <AccordionTrigger>Claude.ai</AccordionTrigger>
          <AccordionContent>
            <p>Claude.ai custom connectors require a remote MCP server that Anthropic can reach. Forge does not provide a remote MCP endpoint. The local stdio setup works only in desktop and CLI hosts.</p>
            <a href="https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp" target="_blank" rel="noreferrer">Open the Claude remote connector guide</a>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="hermes">
          <AccordionTrigger>Hermes</AccordionTrigger>
          <AccordionContent>
            <p>Copy <code>skills/forge/</code> to <code>$HERMES_HOME/skills/forge/</code>. Keep the existing profile settings.</p>
            <p>Hermes can use the shipped Python client or the same <code>forge mcp</code> server.</p>
          </AccordionContent>
        </AccordionItem>
        <AccordionItem value="http">
          <AccordionTrigger>Direct HTTP API</AccordionTrigger>
          <AccordionContent>
            <p>The shell builtin streams the header to curl. The expanded credential does not enter the curl process arguments.</p>
            <CodeBlock>{`printf 'Authorization: Bearer %s\\n' "$FORGE_AGENT_CREDENTIAL" | \\
  curl --fail --silent --show-error \\
  --header @- "$FORGE_BASE_URL/api/agent/me"`}</CodeBlock>
            <p>Request the OpenAPI contract with the same credential.</p>
            <CodeBlock>{`printf 'Authorization: Bearer %s\\n' "$FORGE_AGENT_CREDENTIAL" | \\
  curl --fail --silent --show-error \\
  --header @- "$FORGE_BASE_URL/api/agent/openapi.json"`}</CodeBlock>
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
