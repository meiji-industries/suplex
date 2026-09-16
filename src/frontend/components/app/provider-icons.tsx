import type { HarnessKind } from "../../../runtimes/harness-kind.js";

export const providerIcons = {
  "claude-code": { label: "Claude Code", src: new URL("./provider-icons/claude-code.svg", import.meta.url).href },
  codex: { label: "Codex", src: new URL("./provider-icons/codex.svg", import.meta.url).href },
  opencode: { label: "OpenCode", src: new URL("./provider-icons/opencode.svg", import.meta.url).href },
  devin: { label: "Devin", src: new URL("./provider-icons/devin.svg", import.meta.url).href },
} satisfies Record<HarnessKind, { label: string; src: string }>;

export function ProviderIcon({ provider }: { provider: HarnessKind }) {
  const mask = `url("${providerIcons[provider].src}") center / contain no-repeat`;
  return <span aria-hidden="true" className="inline-block size-4 shrink-0 bg-current" style={{ mask, WebkitMask: mask, color: provider === "claude-code" ? "#D97757" : undefined }} />;
}
