import { parsePatchFiles } from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { FileTree, useFileTree, useFileTreeSelection } from "@pierre/trees/react";
import { useEffect, useMemo, useState, type ReactElement } from "react";
import { Button } from "../ui/button.js";
import { Alert, AlertDescription } from "../ui/alert.js";
type ParsedFile = ReturnType<typeof parsePatchFiles>[number]["files"][number];
function DiffList({ files, themeType }: { files: ParsedFile[]; themeType: "light" | "dark" }): ReactElement {
  const options = useMemo(() => ({ diffStyle: "unified" as const, overflow: "scroll" as const, stickyHeader: true, themeType }), [themeType]);
  return <div className="overflow-hidden rounded-md border border-border bg-background">
    <Virtualizer className="h-[36rem] overflow-auto" contentClassName="space-y-3 p-2">
      {files.map((file) => <FileDiff fileDiff={file} options={options} disableWorkerPool key={file.name} />)}
    </Virtualizer>
  </div>;
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
  return <div className="grid overflow-hidden rounded-md border border-border bg-background lg:grid-cols-[14rem_minmax(0,1fr)]">
    <FileTree model={model} aria-label="Changed files" className="h-48 border-b border-border lg:h-[36rem] lg:border-r lg:border-b-0" style={{ colorScheme: themeType }} />
    <Virtualizer className="h-[36rem] overflow-auto" contentClassName="p-2">
      <FileDiff fileDiff={selectedFile} options={options} disableWorkerPool />
    </Virtualizer>
  </div>;
}


export function DeveloperDiff({ patch }: { patch: string }): ReactElement {
  const [showAll, setShowAll] = useState(true);
  const [themeType, setThemeType] = useState<"light" | "dark">(() => document.documentElement.classList.contains("dark") ? "dark" : "light");
  useEffect(() => { const observer = new MutationObserver(() => setThemeType(document.documentElement.classList.contains("dark") ? "dark" : "light")); observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] }); return () => observer.disconnect(); }, []);
  const parsed = useMemo(() => { try { return { files: parsePatchFiles(patch).flatMap(patch => patch.files), error: "" }; } catch (error) { return { files: [], error: error instanceof Error ? error.message : "The diff could not be read" }; } }, [patch]);
  if (parsed.error) return <Alert variant="destructive"><AlertDescription>{parsed.error}</AlertDescription></Alert>;
  if (!parsed.files.length && patch.trim()) return <Alert variant="destructive"><AlertDescription>The diff could not be displayed.</AlertDescription></Alert>;
  if (!parsed.files.length) return <p className="text-xs text-muted-foreground">No changes from the target base.</p>;
  return <div data-task-developer-diff className="min-w-0 space-y-2"><div><Button type="button" variant="outline" size="sm" aria-pressed={showAll} onClick={() => setShowAll(current => !current)}>Show all</Button></div>{showAll ? <DiffList files={parsed.files} themeType={themeType} /> : <DiffTree key={parsed.files.map(file => file.name).join("\n")} files={parsed.files} themeType={themeType} />}</div>;
}
