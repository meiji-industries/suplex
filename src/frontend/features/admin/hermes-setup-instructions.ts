import { adminDate } from "../../shell/view-shared.js";

export function hermesSetupInstructions(pairingCodeData: { code: string; expiresAt: string } | null, profileName: string): string {
  if (!pairingCodeData?.code || !pairingCodeData.expiresAt) return "";
  const baseUrl = window.location.origin;
  const profileId = profileName.trim() || "default";
  return [
    "# Connect this Hermes profile to Forge", "", "Configure only the active Hermes profile.", "",
    "- Forge base URL: `" + baseUrl + "`", "- One-time pairing code: `" + pairingCodeData.code + "`", "- Pairing code expires: `" + adminDate(pairingCodeData.expiresAt) + "`", "",
    "Complete these steps:", "", "1. Pair the Hermes profile `" + profileId + "`.", "", "2. Exchange the pairing code by sending JSON to `POST " + baseUrl + "/api/hermes/pairing/exchange`:", "", "   ```json", "   {", "     \"pairingCode\": \"" + pairingCodeData.code + "\",", "     \"profileId\": \"" + profileId + "\"", "   }", "   ```", "",
    "3. Capture the exchange response without printing the raw response or credential. Preserve the active profile's existing `$HERMES_HOME/.env` contents and set:", "", "   - `FORGE_BASE_URL=" + baseUrl + "`", "   - `FORGE_AGENT_CREDENTIAL=<returned credential>`", "", "   Replace existing values for those keys instead of creating duplicates. Keep the file profile-local and restricted to the current user. Never put the credential in chat output, memory, logs, shell history, skill markdown, or source control.", "",
    "4. Install the shipped Forge skill template into `$HERMES_HOME/skills/forge/`. Copy `hermes/skills/forge/` from the Forge repository; it contains `SKILL.md`, a standard-library Python client, and a smoke test. Do not write your own client. The skill reads the two variables above from the environment at runtime and documents pairing, credential rotation, capability discovery, project selection, duplicate avoidance, idempotent task creation, status polling, and the lifecycle commands this agent is allowed to send. Installation and verification are described in `docs/hermes-skill.md`.", "",
    "5. Create one persistent connectivity acknowledgment task by running `python3 smoke_test.py` from the installed skill directory. The script reads the agent identity, then creates the task with `projectId` set to the first granted project, title `Hermes connectivity confirmed`, description `Connection acknowledged. Do not plan or execute this task.`, and idempotency key `forge-connectivity-` followed by the returned `agent.id`. It sends that request twice with the same key and confirms Forge returns the same task. The task must remain in `backlog` until you select `Start`; do not start this task. If no allowed project ID was returned, the script stops and reports that project access is required.", "",
    "6. Report only the pairing result, Forge agent name/ID, active profile ID, allowed project IDs, and the acknowledgment task issue key/ID and status. Never echo the pairing code or bearer credential.",
  ].join("\n");
}
