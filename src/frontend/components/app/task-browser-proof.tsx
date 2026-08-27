import type { ReactElement } from "react";
import { Download } from "lucide-react";

import type { ApiTask } from "../../lib/view-shared.js";
import { Badge } from "../ui/badge.js";
import { Button } from "../ui/button.js";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "../ui/dialog.js";

export function TaskBrowserProof({ task }: { task: ApiTask }): ReactElement | null {
  if (task.executionControls.visualEvidence === "off") return null;
  const url = (artifactId: string): string => `/api/tasks/${task.id}/artifacts/${artifactId}`;
  return <section className="space-y-2" aria-label="Browser proof" data-browser-proof>
    <div className="flex items-center gap-2"><h3 className="text-xs font-semibold">Proof</h3><Badge variant="secondary">{task.browserProof.reduce((count, proof) => count + proof.images.length, 0)}</Badge></div>
    {task.browserProof.length === 0 ? <p className="text-xs text-muted-foreground">No proof attached</p> : <div className="space-y-3">
      {task.browserProof.map((proof) => <div className="space-y-1.5 border-t border-border pt-2 first:border-t-0 first:pt-0" key={proof.manifestArtifactId}>
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[11px] text-muted-foreground"><span className="font-mono">{proof.resultCommit.slice(0, 8)}</span><span className="max-w-full truncate" title={proof.developerExecutionId}>{proof.developerExecutionId}</span><time dateTime={proof.createdAt}>{new Date(proof.createdAt).toLocaleString()}</time></div>
        {proof.summary ? <p className="text-xs text-muted-foreground">{proof.summary}</p> : null}
        <div className="flex max-w-full gap-2 overflow-x-auto pb-1">
          {proof.images.map((image) => <div className="w-28 shrink-0 space-y-1" key={image.artifactId}>
            <div className="h-20 w-28 overflow-hidden"><Dialog><DialogTrigger render={<Button variant="outline" aria-label={`Preview ${image.caption || image.filename}`} />}><img className="h-16 w-24 object-cover" src={url(image.artifactId)} alt={image.caption || image.filename} /></DialogTrigger><DialogContent><DialogHeader><DialogTitle>{image.caption || image.filename}</DialogTitle></DialogHeader><img className="max-h-[75vh] w-full object-contain" src={url(image.artifactId)} alt={image.caption || image.filename} /></DialogContent></Dialog></div>
            <div className="flex items-start justify-between gap-1 text-[11px]"><span className="min-w-0 truncate" title={image.caption || image.filename}>{image.caption || image.filename}</span><a href={url(image.artifactId)} download={image.filename} aria-label={`Download ${image.filename}`}><Download aria-hidden="true" className="size-3.5" /></a></div>
            {image.viewport ? <div className="text-[10px] text-muted-foreground">{image.viewport.width}×{image.viewport.height}{image.viewport.deviceScaleFactor ? ` @${image.viewport.deviceScaleFactor}x` : ""}</div> : null}
            {image.capturedAt ? <time className="block text-[10px] text-muted-foreground" dateTime={image.capturedAt}>{new Date(image.capturedAt).toLocaleString()}</time> : null}
          </div>)}
        </div>
      </div>)}
    </div>}
  </section>;
}
