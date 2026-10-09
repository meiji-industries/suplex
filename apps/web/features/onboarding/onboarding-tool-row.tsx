import { Check, Copy } from "lucide-react";
import type { ReactElement } from "react";
import type { HealthCheck } from "../../contracts/health.js";
import { CheckStatusIndicator, healthCheckPurpose, HerdrInstallButton } from "../../components/app/system-health.js";
import { GithubDeviceSignIn } from "../../components/app/github-device-sign-in.js";
import { ToolIcon, type ToolIconId } from "../../components/app/tool-icons.js";
import { Badge } from "../../components/ui/badge.js";
import { Button } from "../../components/ui/button.js";
import { Skeleton } from "../../components/ui/skeleton.js";
import { copyToClipboard } from "../../lib/clipboard.js";

export function OnboardingToolRow({ id, check, loading, canManage, onConnected }: {
  id: HealthCheck["id"] & ToolIconId;
  check: HealthCheck | undefined;
  loading: boolean;
  canManage: boolean;
  onConnected: () => Promise<void>;
}): ReactElement {
  return <div className="border-b pb-3">
    <div className="flex items-center gap-3">
      <div className="shrink-0 self-start pt-1">{check || !loading ? <ToolIcon tool={id} /> : <Skeleton className="size-4 shrink-0" />}</div>
      <div className="min-w-0 flex-1">
        <span className="text-sm font-medium">{id === "git" ? "Git" : id === "gh-auth" ? "GitHub App" : id === "gh-cli" ? "GitHub CLI" : "Herdr"}</span>{" "}
        <span className="text-xs text-muted-foreground">{id === "git" ? "for source control" : id === "gh-auth" ? "for branches, pull requests, and merges" : id === "gh-cli" ? "lets agents read pull requests and checks" : "runs your agents in the background"}</span>
        <div className="text-xs text-muted-foreground">
          {loading ? <div aria-label="Check in progress">
            {id !== "herdr-readiness" ? <Skeleton className="h-4 w-32" /> : null}
            {id === "gh-auth" ? <Skeleton className="h-4 w-44" /> : null}
          </div> : !check ? "Check not available. Select Check again." : id === "gh-auth" && check.details.method === "device" ? check.status === "healthy" ? <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />{check.details.logins ? `Signed in as ${check.details.logins}` : "GitHub is connected"}</span> : check.summary : id === "gh-auth" ? check.status === "healthy" ? <>
            <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />CLI tools installed</span>
            <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />{check.details.logins ? `Signed in as ${check.details.logins}` : "Signed in"}</span>
          </> : check.summary : id === "herdr-readiness" ? null : check.status === "healthy" ? <span className="flex items-center gap-1"><Check aria-hidden="true" className="size-3" />{id === "git" ? "Git is available" : "CLI tools installed"}</span> : healthCheckPurpose(id)}
        </div>
      </div>
      {id === "gh-auth" && check?.details.method === "device" && check.status !== "healthy" && canManage ? <GithubDeviceSignIn primary onConnected={onConnected} />
        : id === "herdr-readiness" && check?.status === "unhealthy" && canManage ? <HerdrInstallButton />
        : check ? <CheckStatusIndicator check={check} healthyLabel={id === "gh-cli" && check.details.logins ? `@${check.details.logins}` : "Done"} /> : loading ? <Skeleton className="h-5 w-16 shrink-0" /> : <Badge variant="outline">Not available</Badge>}
    </div>
    {check && check.status !== "healthy" && check.remedy && !(id === "herdr-readiness" && check.status === "unhealthy" && canManage) ? <div className="mt-2 flex justify-end gap-2">
      {check.remedyKind === "link" ? <Button size="xs" variant="outline" nativeButton={false} render={<a href={check.remedy} target="_blank" rel="noreferrer" />}>Open the instructions</Button> : <><code className="min-w-0 break-all text-xs">{check.remedy}</code><Button size="xs" variant="outline" onClick={() => void copyToClipboard(check.remedy!, "Copied the setup command to clipboard")}><Copy />Copy</Button></>}
    </div> : null}
  </div>;
}
