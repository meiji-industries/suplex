import { adminDate } from "../../shell/view-shared.js";

export function externalAgentSetupInstructions(pairingCodeData: { code: string; expiresAt: string } | null, profileName: string): string {
  if (!pairingCodeData?.code || !pairingCodeData.expiresAt) return "";
  const baseUrl = window.location.origin;
  const profileId = profileName.trim() || "default";
  return [
    "# Connect an external client to Suplex", "", "Configure only the client that will use this Suplex identity.", "",
    "- Suplex base URL: `" + baseUrl + "`", "- One-time pairing code: `" + pairingCodeData.code + "`", "- Pairing code expires: `" + adminDate(pairingCodeData.expiresAt) + "`", "",
    "Complete these steps:", "", "1. Use client profile ID `" + profileId + "` as descriptive metadata. The pairing code and returned credential authorize the connection.", "", "2. Exchange the pairing code by sending JSON to `POST " + baseUrl + "/api/agent/pairing/exchange`:", "", "   ```json", "   {", "     \"pairingCode\": \"" + pairingCodeData.code + "\",", "     \"profileId\": \"" + profileId + "\"", "   }", "   ```", "",
    "3. Capture the response without printing the credential. Set `SUPLEX_BASE_URL=" + baseUrl + "` and `SUPLEX_AGENT_CREDENTIAL=<returned credential>` in the private environment of the MCP server or HTTP client. Preserve existing client settings. Never put the credential in chat, tool arguments, logs, shell history, skill files, or source control.", "",
    "4. Prefer the local MCP bridge. Run `suplex mcp`, or `pnpm --dir /absolute/path/to/suplex run suplex mcp` from a source checkout. The bridge reads both variables from its process environment.", "",
    "5. For Hermes, copy `skills/suplex/` to `$HERMES_HOME/skills/suplex/`. The client can also use the same MCP bridge. Read `docs/agent-skill.md`.", "",
    "6. Run `python3 smoke_test.py` from the installed skill directory. It reads the identity and creates `External agent connectivity confirmed` twice with the stable `suplex-connectivity-<agentId>` key. The task must remain in `backlog`. If the identity has no grants, stop and report that project access is required.", "",
    "7. You can also verify the connection with `GET " + baseUrl + "/api/agent/me`. Report only the agent ID, client profile ID, and granted project IDs. Never echo the pairing code or bearer credential.",
  ].join("\n");
}
