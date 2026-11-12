import { adminDate } from "../../shell/view-shared.js";
import { SUPLEX_SKILL_INSTALL_COMMAND } from "./suplex-skill.js";

export function externalAgentSetupInstructions(pairingCodeData: { code: string; expiresAt: string } | null, profileName: string): string {
  if (!pairingCodeData?.code || !pairingCodeData.expiresAt) return "";
  const baseUrl = window.location.origin;
  const profileId = profileName.trim() || "default";
  return [
    "# Connect an external client to Suplex", "", "Configure only the client that will use this Suplex identity.", "",
    "- Suplex base URL: `" + baseUrl + "`", "- One-time pairing code: `" + pairingCodeData.code + "`", "- Pairing code expires: `" + adminDate(pairingCodeData.expiresAt) + "`", "",
    "Complete these steps:", "", "1. Use client profile ID `" + profileId + "` as descriptive metadata. The pairing code and returned credential authorize the connection.", "", "2. Exchange the pairing code by sending JSON to `POST " + baseUrl + "/api/agent/pairing/exchange`:", "", "   ```json", "   {", "     \"pairingCode\": \"" + pairingCodeData.code + "\",", "     \"profileId\": \"" + profileId + "\"", "   }", "   ```", "",
    "3. Capture the response without printing the credential. Set `SUPLEX_BASE_URL=" + baseUrl + "` and `SUPLEX_AGENT_CREDENTIAL=<returned credential>` in the private environment of the MCP server or HTTP client. Preserve existing client settings. Never put the credential in chat, tool arguments, logs, shell history, skill files, or source control.", "",
    "4. Install the Suplex skill. This step is required. Run `" + SUPLEX_SKILL_INSTALL_COMMAND + "`. For Hermes, copy `skills/suplex/` to `$HERMES_HOME/skills/suplex/` instead. Find the installed skill folder and report the path that holds `SKILL.md`, `suplex_client.py`, and `smoke_test.py`. If the install fails or these files are missing, stop and report the failure.", "",
    "5. Verify the connection without the `suplex` CLI. From the installed skill folder, run `python3 suplex_client.py --self-check && python3 smoke_test.py`. The scripts need Python 3.10 or later and the standard library only. The smoke test reads the identity and creates `External agent connectivity confirmed` twice with the stable `suplex-connectivity-<agentId>` key. The task must remain in `backlog`. If the identity has no grants, stop and report that project access is required.", "",
    "6. Select the tool access. No CLI is necessary. Read `" + baseUrl + "/.well-known/oauth-protected-resource/mcp`. When its `resource` is `" + baseUrl + "/mcp`, use the hosted Streamable HTTP MCP endpoint, for example `claude mcp add --transport http suplex " + baseUrl + "/mcp`. That endpoint uses OAuth, and an administrator approves the company and projects. Otherwise, use `suplex_client.py` over the agent HTTP API with the paired credential.", "",
    "7. Optional: use the local stdio bridge `suplex mcp` only if you already have the Suplex app or a checkout. Check with `suplex --version`. The bridge reads both variables from its process environment. Do not install the CLI, and do not ask for a checkout. The npm package named `suplex` is unrelated. Do not use it. Pairing does not depend on this step.", "",
    "8. You can also verify the connection with `GET " + baseUrl + "/api/agent/me`. Report only the agent ID, client profile ID, and granted project IDs. Never echo the pairing code or bearer credential.",
  ].join("\n");
}
