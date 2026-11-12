// @vitest-environment happy-dom
import { expect, test } from "vitest";

import { externalAgentSetupInstructions } from "../features/admin/external-agent-setup-instructions.js";
import { SUPLEX_SKILL_INSTALL_COMMAND } from "../features/admin/suplex-skill.js";

const pairing = { code: "placeholder-pairing-code", expiresAt: "2026-09-10T12:00:00.000Z" };

test("no pairing code produces no instructions", () => {
  expect(externalAgentSetupInstructions(null, "writer")).toBe("");
  expect(externalAgentSetupInstructions({ code: "", expiresAt: pairing.expiresAt }, "writer")).toBe("");
});

function step(instructions: string, number: number): string {
  const line = instructions.split("\n").find((entry) => entry.startsWith(`${number}. `));
  if (!line) throw new Error(`step ${number} is missing`);
  return line;
}

test("instructions require the skill install and a reported install path", () => {
  const install = step(externalAgentSetupInstructions(pairing, "writer"), 4);
  expect(SUPLEX_SKILL_INSTALL_COMMAND).toBe("npx skills add meiji-industries/suplex-skills --skill suplex --global");
  expect(install).toContain("This step is required.");
  expect(install).toContain("`" + SUPLEX_SKILL_INSTALL_COMMAND + "`");
  expect(install).toContain("copy `skills/suplex/` to `$HERMES_HOME/skills/suplex/`");
  expect(install).toContain("report the path that holds `SKILL.md`, `suplex_client.py`, and `smoke_test.py`");
  expect(install).toContain("If the install fails or these files are missing, stop and report the failure.");
});

test("instructions verify the connection with the skill scripts and no CLI", () => {
  const verify = step(externalAgentSetupInstructions(pairing, "writer"), 5);
  expect(verify).toContain("`python3 suplex_client.py --self-check && python3 smoke_test.py`");
  expect(verify).toContain("Python 3.10 or later and the standard library only");
});

test("instructions default to the hosted MCP endpoint or the Python client", () => {
  const origin = window.location.origin;
  const access = step(externalAgentSetupInstructions(pairing, "writer"), 6);
  expect(access).toContain("No CLI is necessary.");
  expect(access).toContain("`" + origin + "/.well-known/oauth-protected-resource/mcp`");
  expect(access).toContain("When its `resource` is `" + origin + "/mcp`");
  expect(access).toContain("`claude mcp add --transport http suplex " + origin + "/mcp`");
  expect(access).toContain("an administrator approves the company and projects");
  expect(access).toContain("use `suplex_client.py` over the agent HTTP API with the paired credential");
});

test("instructions keep the stdio bridge optional and never ask for the CLI", () => {
  const instructions = externalAgentSetupInstructions(pairing, "writer");
  const optional = step(instructions, 7);
  expect(optional).toMatch(/^7\. Optional:/);
  expect(optional).toContain("only if you already have the Suplex app or a checkout");
  expect(optional).toContain("`suplex --version`");
  expect(optional).toContain("Do not install the CLI, and do not ask for a checkout.");
  expect(optional).toContain("The npm package named `suplex` is unrelated. Do not use it.");
  expect(optional).toContain("Pairing does not depend on this step.");
  // `suplex mcp` appears only in the optional step.
  expect(instructions.split("\n").filter((line) => line.includes("suplex mcp`")).map((line) => line.slice(0, 2))).toEqual(["7."]);
  expect(instructions).not.toContain("pnpm --dir");
  expect(instructions).not.toContain("npm install");
  // The template replaces the ad hoc client instructions the dialog used to restate.
  expect(instructions).not.toContain("Do not send local paths");
});

test("instructions keep the connectivity acknowledgment task flow", () => {
  const instructions = externalAgentSetupInstructions(pairing, "writer");
  expect(instructions).toContain("External agent connectivity confirmed");
  expect(instructions).toContain("suplex-connectivity-");
  expect(instructions).toContain("must remain in `backlog`");
  expect(instructions).toContain("project access is required");
});

test("instructions carry the pairing inputs and forbid echoing secrets", () => {
  const instructions = externalAgentSetupInstructions(pairing, " ");
  expect(instructions).toContain(window.location.origin + "/api/agent/pairing/exchange");
  expect(instructions).toContain("\"profileId\": \"default\"");
  expect(instructions).toContain("SUPLEX_BASE_URL=" + window.location.origin);
  expect(instructions).toContain("SUPLEX_AGENT_CREDENTIAL=<returned credential>");
  expect(instructions).toContain("Capture the response without printing the credential.");
  expect(instructions).toContain("Never put the credential in chat, tool arguments, logs, shell history, skill files, or source control.");
  expect(step(instructions, 8)).toContain("Never echo the pairing code or bearer credential.");
});
