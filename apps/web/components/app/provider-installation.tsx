import { Check, Copy, ExternalLink } from "lucide-react";
import { useState, type ReactElement } from "react";

import type { HarnessKind } from "../../contracts/harness-kind.js";
import { copyToClipboard } from "../../lib/clipboard.js";
import { Button } from "../ui/button.js";

export type ProviderInstallation = {
  command: string;
  guideUrl: string;
  os: string;
  prerequisite?: string | undefined;
};

export const PROVIDER_INSTALLATIONS: Record<HarnessKind, ProviderInstallation> = {
  "claude-code": {
    command: "curl -fsSL https://claude.ai/install.sh | bash",
    guideUrl: "https://code.claude.com/docs/en/quickstart",
    os: "macOS, Linux, or WSL",
  },
  codex: {
    command: "npm install -g @openai/codex",
    guideUrl: "https://github.com/openai/codex",
    os: "Any system with Node.js and npm",
    prerequisite: "Install Node.js and npm first.",
  },
  opencode: {
    command: "curl -fsSL https://opencode.ai/install | bash",
    guideUrl: "https://opencode.ai/docs/",
    os: "macOS or Linux",
  },
  devin: {
    command: "curl -fsSL https://cli.devin.ai/install.sh | bash",
    guideUrl: "https://docs.devin.ai/cli/index",
    os: "macOS, Linux, or WSL",
  },
  pi: {
    command: "curl -fsSL https://pi.dev/install.sh | sh",
    guideUrl: "https://pi.dev/docs/latest/quickstart",
    os: "macOS, Linux, or WSL",
  },
};

export function ProviderInstallationInstructions({ provider, checkLabel }: { provider: HarnessKind; checkLabel: "Check again" | "Refresh" }): ReactElement {
  const installation = PROVIDER_INSTALLATIONS[provider];
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    setCopyStatus(await copyToClipboard(installation.command, "Copied the install command to clipboard") ? "copied" : "failed");
  };
  return <div className="space-y-2 text-xs text-muted-foreground">
    <p>Install on the machine that runs Suplex. Select {checkLabel} after installation.</p>
    {installation.prerequisite ? <p>{installation.prerequisite}</p> : null}
    <p>{installation.os}</p>
    <div className="flex items-start gap-2">
      <code className="min-w-0 flex-1 break-all select-all">{installation.command}</code>
      <Button type="button" size="xs" variant="outline" onClick={() => void copy()}>{copyStatus === "copied" ? <Check /> : <Copy />}{copyStatus === "copied" ? "Copied" : "Copy"}</Button>
    </div>
    {copyStatus === "failed" ? <p role="status">Select the command and copy it.</p> : null}
    <Button size="xs" variant="outline" nativeButton={false} render={<a href={installation.guideUrl} target="_blank" rel="noreferrer" />}><ExternalLink />Open the official guide</Button>
  </div>;
}

/** One line for a table cell: the command, a copy button, and the guide. The system notes are in the tooltip. */
export function ProviderInstallCommand({ provider }: { provider: HarnessKind }): ReactElement {
  const installation = PROVIDER_INSTALLATIONS[provider];
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    setCopyStatus(await copyToClipboard(installation.command, "Copied the install command to clipboard") ? "copied" : "failed");
  };
  const notes = [installation.os, installation.prerequisite].filter(Boolean).join(". ");
  return <div className="flex min-w-0 max-w-full items-center gap-1">
    <code className="min-w-0 truncate font-mono text-xs text-muted-foreground select-all" title={`${installation.command}\n${notes}`}>{installation.command}</code>
    <Button type="button" size="icon-xs" variant="ghost" aria-label={copyStatus === "copied" ? "Command copied" : "Copy the install command"} title={copyStatus === "failed" ? "Select the command and copy it" : "Copy the install command"} onClick={() => void copy()}>{copyStatus === "copied" ? <Check /> : <Copy />}</Button>
    <Button size="icon-xs" variant="ghost" nativeButton={false} aria-label="Open the official guide" title="Open the official guide" render={<a href={installation.guideUrl} target="_blank" rel="noreferrer" />}><ExternalLink /></Button>
  </div>;
}
