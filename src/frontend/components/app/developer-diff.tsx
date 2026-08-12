import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { readJson } from "../../lib/api.js";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Skeleton } from "../ui/skeleton.js";

type ApiDeveloperDiff = { patch: string; branchName: string; baseSha: string; headSha: string };

function useAppThemeType(): "light" | "dark" {
  const readTheme = (): "light" | "dark" => document.documentElement.classList.contains("dark") ? "dark" : "light";
  const [themeType, setThemeType] = useState<"light" | "dark">(readTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeType(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return themeType;
}

export default function DeveloperDiff({ taskId, executionId }: { taskId: string; executionId: string }): ReactElement {
  const [diff, setDiff] = useState<ApiDeveloperDiff>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const themeType = useAppThemeType();

  useEffect(() => {
    const controller = new AbortController();
    setDiff(undefined); setLoading(true); setError("");
    void readJson<ApiDeveloperDiff>(`/api/tasks/${encodeURIComponent(taskId)}/developer-diff`, { signal: controller.signal })
      .then((value) => { setDiff(value); setLoading(false); })
      .catch((reason: unknown) => {
        if (controller.signal.aborted) return;
        setError(reason instanceof Error ? reason.message : "Unable to load the Developer diff"); setLoading(false);
      });
    return () => controller.abort();
  }, [taskId, executionId]);

  const files = useMemo(() => diff?.patch ? parsePatchFiles(diff.patch, executionId, true).flatMap((patch) => patch.files) : [], [diff?.patch, executionId]);
  const options = useMemo(() => ({ diffStyle: "unified" as const, overflow: "scroll" as const, stickyHeader: true, themeType }), [themeType]);
  if (loading) return <div className="space-y-2" aria-busy="true" aria-label="Loading Developer diff"><Skeleton className="h-5 w-36" /><Skeleton className="h-40 w-full" /></div>;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!diff || files.length === 0) return <p className="text-xs text-muted-foreground">No changes from the target base.</p>;

  return (
    <div data-task-developer-diff className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{files.length} {files.length === 1 ? "file" : "files"}</span>
        <code>{diff.baseSha.slice(0, 8)} → {diff.headSha.slice(0, 8)}</code>
      </div>
      <div className="overflow-hidden rounded-md border border-border bg-background">
        <Virtualizer className="max-h-[36rem] overflow-auto" contentClassName="space-y-2 p-2">
          {files.map((file, index) => <FileDiff key={`${file.name}-${index}`} fileDiff={file} options={options} disableWorkerPool />)}
        </Virtualizer>
      </div>
    </div>
  );
}
