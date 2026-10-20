// @vitest-environment happy-dom
import { act, createContext, useContext, useRef, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

const api = vi.hoisted(() => ({ readJsonUnchecked: vi.fn() }));
vi.mock("../lib/api.js", () => api);
vi.mock("../components/ui/select.js", () => {
  const context = createContext<{ value?: string | undefined; onValueChange?: ((value: string) => void) | undefined; label: { current: string } }>({ label: { current: "" } });
  return {
    Select: ({ value, onValueChange, children }: { value?: string; onValueChange?: (value: string) => void; children: ReactNode }) => {
      const label = useRef("");
      return <context.Provider value={{ value, onValueChange, label }}>{children}</context.Provider>;
    },
    SelectTrigger: ({ children, ...props }: { children: ReactNode; "aria-label"?: string }) => {
      const { label } = useContext(context);
      label.current = props["aria-label"] ?? "";
      return <div {...props}>{children}</div>;
    },
    SelectValue: () => <span data-select-value>{useContext(context).value}</span>,
    SelectContent: ({ children }: { children: ReactNode }) => children,
    SelectGroup: ({ children }: { children: ReactNode }) => <div role="group">{children}</div>,
    SelectLabel: ({ children }: { children: ReactNode }) => <div data-select-label>{children}</div>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const { onValueChange, label } = useContext(context);
      return <button type="button" data-select={label.current} data-value={value} onClick={() => onValueChange?.(value)}>{children}</button>;
    },
  };
});

import { ExternalAgentConnectionGuide } from "../features/admin/external-agent-connection-guide.js";

const mcpUrl = "https://suplex.example.com/mcp";

beforeEach(() => { api.readJsonUnchecked.mockReset(); });
afterEach(async () => { await act(async () => { document.body.replaceChildren(); }); });

async function mount(): Promise<HTMLElement> {
  const container = document.createElement("div");
  document.body.append(container);
  await act(async () => { createRoot(container).render(<ExternalAgentConnectionGuide />); });
  return container;
}

const codeBlocks = (container: HTMLElement): string[] => Array.from(container.querySelectorAll("pre code")).map((code) => code.textContent ?? "");

test("the guide shows Claude Code by default and switches to the selected client", async () => {
  api.readJsonUnchecked.mockResolvedValue({ resource: mcpUrl });
  const container = await mount();

  expect(api.readJsonUnchecked).toHaveBeenCalledWith("/.well-known/oauth-protected-resource/mcp", { cache: "no-cache" });
  expect(container.querySelector("[data-select-value]")?.textContent).toBe("claude-code");
  const options = Array.from(container.querySelectorAll<HTMLButtonElement>('[data-select="Client"]'));
  expect(options.slice(0, 2).map((option) => option.textContent)).toEqual(["Claude Code", "Codex"]);
  expect(Array.from(container.querySelectorAll("[data-select-label]")).map((label) => label.textContent)).toEqual(["Terminal agents", "Editors", "Desktop and web", "Other"]);
  expect(codeBlocks(container)).toContain(`claude mcp add --transport http suplex ${mcpUrl}\nclaude mcp login suplex`);
  expect(container.querySelector('[aria-label="Copy the Claude Code setup"]')).not.toBeNull();
  expect(container.textContent).not.toContain("Remote MCP clients");

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-select="Client"][data-value="codex"]')?.click(); });

  expect(codeBlocks(container)).toContain(`codex mcp add suplex --url ${mcpUrl}\ncodex mcp login suplex`);
  expect(codeBlocks(container).some((code) => code.startsWith("claude mcp add"))).toBe(false);
  expect(container.querySelector('[aria-label="Copy the Codex setup"]')).not.toBeNull();
  expect(container.querySelector('[aria-label="Copy the Claude Code setup"]')).toBeNull();

  await act(async () => { container.querySelector<HTMLButtonElement>('[data-select="Client"][data-value="cursor"]')?.click(); });
  expect(codeBlocks(container)).toContain(JSON.stringify({ mcpServers: { suplex: { url: mcpUrl } } }, null, 2));
  expect(container.querySelector('a[href="https://cursor.com/docs/context/mcp"]')).not.toBeNull();
});

test("the guide shows the loading message and no client snippet before the MCP address loads", async () => {
  api.readJsonUnchecked.mockReturnValue(new Promise(() => undefined));
  const container = await mount();

  expect(container.textContent).toContain("Suplex is reading the canonical MCP address.");
  expect(codeBlocks(container).some((code) => code.includes("claude mcp"))).toBe(false);
  expect(container.querySelector('[aria-label="Copy the Claude Code setup"]')).toBeNull();
});

test("the guide says OAuth is not available and shows no client snippet when the metadata read fails", async () => {
  api.readJsonUnchecked.mockRejectedValue(new Error("not found"));
  const container = await mount();

  expect(container.textContent).toContain("OAuth is not available. Open Remote Access and save an HTTPS address.");
  expect(codeBlocks(container).some((code) => code.includes("claude mcp"))).toBe(false);
  expect(container.querySelector('[aria-label="Copy the Claude Code setup"]')).toBeNull();
});
