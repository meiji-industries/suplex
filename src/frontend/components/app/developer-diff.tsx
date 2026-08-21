import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import { useEffect, useMemo, useState, type ReactElement } from "react";

import { readJson } from "../../lib/api.js";
import { Alert, AlertDescription } from "../ui/alert.js";
import { Skeleton } from "../ui/skeleton.js";
import type { TaskDeveloperDiffResponse } from "../../../http/contracts/tasks.js";

type ApiDeveloperDiff = TaskDeveloperDiffResponse;

type ParsedFile = ReturnType<typeof parsePatchFiles>[number]["files"][number];

export type DeveloperDiffProps = { taskId: string; executionId: string; onFileCount?: (count: number) => void };

export function useAppThemeType(): "light" | "dark" {
  const readTheme = (): "light" | "dark" => document.documentElement.classList.contains("dark") ? "dark" : "light";
  const [themeType, setThemeType] = useState<"light" | "dark">(readTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setThemeType(readTheme()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return themeType;
}

function DiffTree({ files, themeType }: { files: ParsedFile[]; themeType: "light" | "dark" }): ReactElement {
  const { model } = useFileTree({
    flattenEmptyDirectories: true,
    initialExpansion: "open",
    initialSelectedPaths: [files[0]!.name],
    paths: files.map((file) => file.name),
    search: true,
  });
  const selectedPaths = useFileTreeSelection(model);
  const selectedFile = files.find((file) => file.name === selectedPaths.at(-1)) ?? files[0]!;
  const options = useMemo(() => ({ diffStyle: "unified" as const, overflow: "scroll" as const, stickyHeader: true, themeType }), [themeType]);

  return files.length === 1 ? (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <Virtualizer className="h-[36rem] overflow-auto" contentClassName="p-2">
        <FileDiff fileDiff={selectedFile} options={options} disableWorkerPool />
      </Virtualizer>
    </div>
  ) : (
    <div className="grid overflow-hidden rounded-md border border-border bg-background lg:grid-cols-[14rem_minmax(0,1fr)]">
      <FileTree model={model} aria-label="Changed files" className="h-48 border-b border-border lg:h-[36rem] lg:border-r lg:border-b-0" style={{ colorScheme: themeType }} />
      <Virtualizer className="h-[36rem] overflow-auto" contentClassName="p-2">
        <FileDiff fileDiff={selectedFile} options={options} disableWorkerPool />
      </Virtualizer>
    </div>
  );
}

export default function DeveloperDiff({ taskId, executionId, onFileCount }: DeveloperDiffProps): ReactElement {
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
        setError(reason instanceof Error ? reason.message : "Unable to load the Builder diff"); setLoading(false);
      });
    return () => controller.abort();
  }, [taskId, executionId]);

  const files = useMemo(() => diff?.patch ? parsePatchFiles(diff.patch, executionId, true).flatMap((patch) => patch.files) : [], [diff?.patch, executionId]);
  useEffect(() => { if (diff) onFileCount?.(files.length); }, [diff, files.length, onFileCount]);
  if (loading) return <div className="space-y-2" aria-busy="true" aria-label="Loading Builder diff"><Skeleton className="h-5 w-36" /><Skeleton className="h-40 w-full" /></div>;
  if (error) return <Alert variant="destructive"><AlertDescription>{error}</AlertDescription></Alert>;
  if (!diff || files.length === 0) return <p className="text-xs text-muted-foreground">No changes from the target base.</p>;

  return (
    <div data-task-developer-diff className="space-y-2">
      <DiffTree files={files} themeType={themeType} />
    </div>
  );
}
