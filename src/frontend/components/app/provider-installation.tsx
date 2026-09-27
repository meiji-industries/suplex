import { Check, Copy, ExternalLink } from "lucide-react";
import { useState, type ReactElement } from "react";

import type { HarnessKind } from "../../contracts/harness-kind.js";
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
};

export function ProviderInstallationInstructions({ provider, checkLabel }: { provider: HarnessKind; checkLabel: "Check again" | "Refresh" }): ReactElement {
  const installation = PROVIDER_INSTALLATIONS[provider];
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(installation.command);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
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
