// @vitest-environment happy-dom
import { expect, test } from "vitest";

import { externalAgentSetupInstructions } from "../features/admin/external-agent-setup-instructions.js";

const pairing = { code: "placeholder-pairing-code", expiresAt: "2026-09-10T12:00:00.000Z" };

test("no pairing code produces no instructions", () => {
  expect(externalAgentSetupInstructions(null, "writer")).toBe("");
  expect(externalAgentSetupInstructions({ code: "", expiresAt: pairing.expiresAt }, "writer")).toBe("");
});

test("instructions point pairing at the shipped skill template", () => {
  const instructions = externalAgentSetupInstructions(pairing, "writer");
  expect(instructions).toContain("$HERMES_HOME/skills/suplex/");
  expect(instructions).toContain("skills/suplex/");
  expect(instructions).toContain("docs/agent-skill.md");
  expect(instructions).toContain("pnpm --dir /absolute/path/to/suplex run suplex mcp");
  expect(instructions).toContain("smoke_test.py");
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
  expect(instructions).toContain("Never echo the pairing code or bearer credential.");
});
