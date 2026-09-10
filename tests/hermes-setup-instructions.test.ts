// @vitest-environment happy-dom
import { expect, test } from "vitest";

import { hermesSetupInstructions } from "../src/frontend/features/admin/hermes-setup-instructions.js";

const pairing = { code: "placeholder-pairing-code", expiresAt: "2026-09-10T12:00:00.000Z" };

test("no pairing code produces no instructions", () => {
  expect(hermesSetupInstructions(null, "writer")).toBe("");
  expect(hermesSetupInstructions({ code: "", expiresAt: pairing.expiresAt }, "writer")).toBe("");
});

test("instructions point pairing at the shipped skill template", () => {
  const instructions = hermesSetupInstructions(pairing, "writer");
  expect(instructions).toContain("$HERMES_HOME/skills/forge/");
  expect(instructions).toContain("hermes/skills/forge/");
  expect(instructions).toContain("docs/hermes-skill.md");
  expect(instructions).toContain("smoke_test.py");
  // The template replaces the ad hoc client instructions the dialog used to restate.
  expect(instructions).not.toContain("Do not send local paths");
});

test("instructions keep the connectivity acknowledgment task flow", () => {
  const instructions = hermesSetupInstructions(pairing, "writer");
  expect(instructions).toContain("Hermes connectivity confirmed");
  expect(instructions).toContain("Connection acknowledged. Do not plan or execute this task.");
  expect(instructions).toContain("forge-connectivity-");
  expect(instructions).toContain("must remain in `backlog`");
  expect(instructions).toContain("project access is required");
});

test("instructions carry the pairing inputs and forbid echoing secrets", () => {
  const instructions = hermesSetupInstructions(pairing, " ");
  expect(instructions).toContain(window.location.origin + "/api/hermes/pairing/exchange");
  expect(instructions).toContain("\"profileId\": \"default\"");
  expect(instructions).toContain("FORGE_BASE_URL=" + window.location.origin);
  expect(instructions).toContain("FORGE_AGENT_CREDENTIAL=<returned credential>");
  expect(instructions).toContain("Never echo the pairing code or bearer credential.");
});
