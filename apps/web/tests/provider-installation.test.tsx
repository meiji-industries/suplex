// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import { PROVIDER_INSTALLATIONS, ProviderInstallationInstructions } from "../components/app/provider-installation.js";

afterEach(() => { document.body.replaceChildren(); vi.restoreAllMocks(); });

test("every provider has its own official installation command and guide", () => {
  expect(PROVIDER_INSTALLATIONS).toEqual({
    "claude-code": { command: "curl -fsSL https://claude.ai/install.sh | bash", guideUrl: "https://code.claude.com/docs/en/quickstart", os: "macOS, Linux, or WSL" },
    codex: { command: "npm install -g @openai/codex", guideUrl: "https://github.com/openai/codex", os: "Any system with Node.js and npm", prerequisite: "Install Node.js and npm first." },
    opencode: { command: "curl -fsSL https://opencode.ai/install | bash", guideUrl: "https://opencode.ai/docs/", os: "macOS or Linux" },
    devin: { command: "curl -fsSL https://cli.devin.ai/install.sh | bash", guideUrl: "https://docs.devin.ai/cli/index", os: "macOS, Linux, or WSL" },
    pi: { command: "curl -fsSL https://pi.dev/install.sh | sh", guideUrl: "https://pi.dev/docs/latest/quickstart", os: "macOS, Linux, or WSL" },
  });
});

test("a failed command copy leaves selectable fallback text", async () => {
  vi.spyOn(navigator.clipboard, "writeText").mockRejectedValue(new Error("denied"));
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<ProviderInstallationInstructions provider="devin" checkLabel="Refresh" />));
  const copy = Array.from(container.querySelectorAll("button")).find(button => button.textContent === "Copy")!;
  await act(async () => copy.click());
  expect(container.querySelector("code")?.textContent).toBe("curl -fsSL https://cli.devin.ai/install.sh | bash");
  expect(container.querySelector("code")?.className).toContain("select-all");
  expect(container.querySelector('[role="status"]')?.textContent).toBe("Select the command and copy it.");
  await act(async () => root.unmount());
});
