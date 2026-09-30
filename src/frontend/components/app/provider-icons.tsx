import type { HarnessKind } from "../../contracts/harness-kind.js";

export const providerIcons = {
  "claude-code": { label: "Claude Code", src: new URL("./provider-icons/claude-code.svg", import.meta.url).href },
  codex: { label: "Codex", src: new URL("./provider-icons/codex.svg", import.meta.url).href },
  opencode: { label: "OpenCode", src: new URL("./provider-icons/opencode.svg", import.meta.url).href },
  devin: { label: "Devin", src: new URL("./provider-icons/devin.svg", import.meta.url).href },
} satisfies Record<HarnessKind, { label: string; src: string }>;

/** "brand" keeps Claude Code orange; "mono" draws every logo in the current text colour. */
export function ProviderIcon({ provider, tone = "brand", size = "sm" }: { provider: HarnessKind; tone?: "brand" | "mono"; size?: "sm" | "md" }) {
  const mask = `url("${providerIcons[provider].src}") center / contain no-repeat`;
  return <span aria-hidden="true" className={`inline-block ${size === "md" ? "size-5" : "size-4"} shrink-0 bg-current`} style={{ mask, WebkitMask: mask, color: tone === "brand" && provider === "claude-code" ? "#D97757" : undefined }} />;
}
