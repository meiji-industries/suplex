import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactElement } from "react";
import { ChevronLeft, ChevronRight, FileText } from "lucide-react";

import type { Task } from "../../contracts/tasks.js";
import {
  Attachment,
  AttachmentPreview,
  Attachments,
  type AttachmentData,
} from "../../components/ai-elements/attachments.js";
import { Button } from "../../components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "../../components/ui/card.js";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog.js";

type TaskArtifact = Task["artifacts"][number];

type VisualArtifact =
  | { kind: "image"; artifact: TaskArtifact; data: AttachmentData; url: string }
  | { kind: "video"; artifact: TaskArtifact; data: AttachmentData; url: string };

type ArtifactView = VisualArtifact | { kind: "file"; artifact: TaskArtifact; url: string };

function artifactUrl(taskId: string, artifactId: string): string {
  return `/api/tasks/${encodeURIComponent(taskId)}/artifacts/${encodeURIComponent(artifactId)}`;
}

function artifactView(taskId: string, artifact: TaskArtifact): ArtifactView {
  const url = artifactUrl(taskId, artifact.artifactId);
  const kind = artifact.mimeType.startsWith("image/")
    ? "image"
    : artifact.mimeType.startsWith("video/")
      ? "video"
      : "file";

  if (kind === "file") return { kind, artifact, url };

  const data = {
    type: "file",
    id: artifact.artifactId,
    filename: artifact.filename,
    mediaType: artifact.mimeType,
    url,
  } satisfies AttachmentData;
  return { kind, artifact, data, url };
}

function nextVisualArtifact(visuals: VisualArtifact[], selectedId: string, offset: -1 | 1): VisualArtifact | null {
  const selectedIndex = visuals.findIndex(item => item.artifact.artifactId === selectedId);
  if (selectedIndex < 0 || visuals.length < 2) return null;
  return visuals[(selectedIndex + offset + visuals.length) % visuals.length] ?? null;
}

export function TaskArtifacts({ task }: { task: Pick<Task, "id" | "artifacts"> }): ReactElement | null {
  const { views, visuals, files } = useMemo(() => {
    const nextViews = task.artifacts.map(artifact => artifactView(task.id, artifact));
    return {
      views: nextViews,
      visuals: nextViews.filter((view): view is VisualArtifact => view.kind !== "file"),
      files: nextViews.filter(view => view.kind === "file"),
    };
  }, [task.artifacts, task.id]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [failedPreviews, setFailedPreviews] = useState<ReadonlySet<string>>(() => new Set());
  const [failedFullPreviews, setFailedFullPreviews] = useState<ReadonlySet<string>>(() => new Set());
  const triggerRefs = useRef(new Map<string, HTMLDivElement>());
  const selected = selectedId ? visuals.find(item => item.artifact.artifactId === selectedId) ?? null : null;

  useEffect(() => {
    setFailedPreviews(previous => {
      const presentIds = new Set(visuals.map(item => item.artifact.artifactId));
      const next = new Set([...previous].filter(id => presentIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    setFailedFullPreviews(previous => {
      const presentIds = new Set(visuals.map(item => item.artifact.artifactId));
      const next = new Set([...previous].filter(id => presentIds.has(id)));
      return next.size === previous.size ? previous : next;
    });
    if (selectedId && !visuals.some(item => item.artifact.artifactId === selectedId)) setSelectedId(null);
  }, [selectedId, visuals]);

  if (!views.length) return null;

  const closePreview = () => {
    const trigger = selectedId ? triggerRefs.current.get(selectedId) : undefined;
    setSelectedId(null);
    window.setTimeout(() => trigger?.focus(), 0);
  };
  const openAdjacent = (offset: -1 | 1) => {
    if (!selectedId) return;
    const adjacent = nextVisualArtifact(visuals, selectedId, offset);
    if (adjacent) setSelectedId(adjacent.artifact.artifactId);
  };
  const handleThumbnailKeyDown = (event: KeyboardEvent<HTMLDivElement>, artifactId: string) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    setSelectedId(artifactId);
  };

  return <>
    <Card size="sm" aria-label="Artifacts">
      <CardHeader><CardTitle>Artifacts</CardTitle></CardHeader>
      <CardContent>
        {visuals.length ? <div className="w-fit max-w-full">
          <Attachments variant="grid" aria-label="Visual artifacts">
            {visuals.map(view => {
              const artifactId = view.artifact.artifactId;
              const failed = failedPreviews.has(artifactId);
              return <div
                key={artifactId}
                ref={node => { if (node) triggerRefs.current.set(artifactId, node); else triggerRefs.current.delete(artifactId); }}
                role="button"
                tabIndex={0}
                className="w-24 rounded-lg focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                aria-label={`Open ${view.artifact.filename}`}
                title={view.artifact.filename}
                onClick={() => setSelectedId(artifactId)}
                onKeyDown={event => handleThumbnailKeyDown(event, artifactId)}
                onError={() => setFailedPreviews(previous => new Set(previous).add(artifactId))}
              >
                <Attachment data={view.data}>
                  {failed
                    ? <span className="flex size-full flex-col items-center justify-center gap-1 bg-muted p-2 text-center text-xs text-muted-foreground"><FileText aria-hidden="true" /><span className="line-clamp-2 break-all">{view.artifact.filename}</span></span>
                    : <AttachmentPreview />}
                </Attachment>
                <span className="mt-1 block truncate text-center text-xs text-muted-foreground">{view.artifact.filename}</span>
              </div>;
            })}
          </Attachments>
        </div> : null}
        {files.length ? <ul className="space-y-1 pt-1 text-xs" aria-label="Artifact downloads">
          {files.map(view => <li key={view.artifact.artifactId} className="flex min-w-0 items-center gap-2">
            <FileText aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <a className="min-w-0 truncate underline underline-offset-2" href={view.url} download={view.artifact.filename}>{view.artifact.filename}</a>
            <span className="shrink-0 text-muted-foreground">{view.artifact.byteSize.toLocaleString()} bytes</span>
          </li>)}
        </ul> : null}
      </CardContent>
    </Card>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open) closePreview(); }}>
      <DialogContent className="w-auto max-w-[calc(100vw-2rem)] sm:max-w-[calc(100vw-2rem)]">
        <DialogHeader><DialogTitle>{selected?.artifact.filename ?? "Artifact preview"}</DialogTitle></DialogHeader>
        {selected && failedFullPreviews.has(selected.artifact.artifactId)
          ? <div className="flex min-h-40 flex-col items-center justify-center gap-2 bg-muted p-4 text-center text-muted-foreground" role="status"><FileText aria-hidden="true" /><span>Preview not available for {selected.artifact.filename}.</span></div>
          : null}
        {selected?.kind === "image" && !failedFullPreviews.has(selected.artifact.artifactId) ? <img className="mx-auto h-auto max-h-[calc(100dvh-12rem)] w-auto max-w-full object-contain" src={selected.url} alt={selected.artifact.filename} onError={() => setFailedFullPreviews(previous => new Set(previous).add(selected.artifact.artifactId))} /> : null}
        {selected?.kind === "video" && !failedFullPreviews.has(selected.artifact.artifactId) ? <video key={selected.artifact.artifactId} className="mx-auto h-auto max-h-[calc(100dvh-12rem)] w-auto max-w-full object-contain" src={selected.url} controls playsInline onError={() => setFailedFullPreviews(previous => new Set(previous).add(selected.artifact.artifactId))} /> : null}
        {selected ? <DialogFooter>
          {visuals.length > 1 ? <div className="mr-auto flex items-center gap-1">
            <Button type="button" variant="outline" size="icon-sm" aria-label="Open previous artifact" onClick={() => openAdjacent(-1)}><ChevronLeft /></Button>
            <Button type="button" variant="outline" size="icon-sm" aria-label="Open next artifact" onClick={() => openAdjacent(1)}><ChevronRight /></Button>
          </div> : null}
          <Button nativeButton={false} render={<a href={selected.url} target="_blank" rel="noreferrer" />} variant="outline" size="sm">Open original</Button>
        </DialogFooter> : null}
      </DialogContent>
    </Dialog>
  </>;
}
