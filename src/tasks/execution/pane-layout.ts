import type { HerdrClient, Pane, PaneLayout } from "../../integrations/herdr/client.js";

type PaneLayoutPort = Pick<HerdrClient, "splitPane"> & Partial<Pick<HerdrClient, "getPaneLayout" | "resizePane">>;
type LayoutPane = PaneLayout["panes"][number];
type LayoutRect = PaneLayout["area"];

const paneLayoutQueues = new Map<string, Promise<void>>();

export interface PaneResize {
  paneId: string;
  direction: "up" | "down";
  amount: number;
}

function contains(outer: LayoutRect, inner: LayoutRect): boolean {
  return inner.x >= outer.x && inner.y >= outer.y
    && inner.x + inner.width <= outer.x + outer.width
    && inner.y + inner.height <= outer.y + outer.height;
}

export function paneForNextRow(layout: PaneLayout, fallbackPaneId: string): string {
  const depth = (pane: LayoutPane) => layout.splits.filter(split => contains(split.rect, pane.rect)).length;
  return [...layout.panes].sort((left, right) =>
    right.rect.height - left.rect.height
      || depth(left) - depth(right)
      || right.rect.width - left.rect.width
      || left.rect.y - right.rect.y
      || left.rect.x - right.rect.x,
  )[0]?.paneId ?? fallbackPaneId;
}

export function balancedRowResizes(layout: PaneLayout): PaneResize[] {
  return layout.splits.flatMap(split => {
    if (split.direction !== "down") return [];
    const descendants = layout.panes.filter(pane => contains(split.rect, pane.rect));
    const cut = split.rect.y + split.rect.height * split.ratio;
    const first = descendants.filter(pane => pane.rect.y + pane.rect.height / 2 < cut);
    const second = descendants.filter(pane => !first.includes(pane));
    if (first.length === 0 || second.length === 0) return [];
    const desiredRatio = first.length / descendants.length;
    const delta = desiredRatio - split.ratio;
    if (Math.abs(delta) < 0.000_001) return [];
    const growFirst = delta > 0;
    const candidates = growFirst ? first : second;
    const pane = candidates.reduce((selected: LayoutPane, candidate) => {
      const selectedEdge = growFirst ? selected.rect.y + selected.rect.height : selected.rect.y;
      const candidateEdge = growFirst ? candidate.rect.y + candidate.rect.height : candidate.rect.y;
      return growFirst ? candidateEdge > selectedEdge ? candidate : selected : candidateEdge < selectedEdge ? candidate : selected;
    });
    return [{
      paneId: pane.paneId,
      direction: growFirst ? "down" : "up",
      amount: Math.abs(delta),
    }];
  });
}

async function balancePaneRows(herdr: PaneLayoutPort, paneId: string): Promise<void> {
  if (!herdr.getPaneLayout || !herdr.resizePane) return;
  const layout = await herdr.getPaneLayout(paneId);
  for (const resize of balancedRowResizes(layout)) await herdr.resizePane(resize);
}

async function paneLayoutQueueKey(herdr: PaneLayoutPort, paneId: string): Promise<string> {
  if (!herdr.getPaneLayout) return `pane:${paneId}`;
  try {
    return `tab:${(await herdr.getPaneLayout(paneId)).tabId}`;
  } catch {
    return `pane:${paneId}`;
  }
}

function enqueuePaneLayoutUpdate<T>(key: string, update: () => Promise<T>): Promise<T> {
  const previous = paneLayoutQueues.get(key) ?? Promise.resolve();
  const result = previous.then(update);
  const tail = result.then(() => undefined, () => undefined);
  paneLayoutQueues.set(key, tail);
  void tail.then(() => {
    if (paneLayoutQueues.get(key) === tail) paneLayoutQueues.delete(key);
  });
  return result;
}

export async function splitBalancedPaneRow(herdr: PaneLayoutPort, input: {
  paneId: string;
  cwd: string;
}): Promise<Pane> {
  const queueKey = await paneLayoutQueueKey(herdr, input.paneId);
  return enqueuePaneLayoutUpdate(queueKey, async () => {
    let splitTarget = input.paneId;
    if (herdr.getPaneLayout) {
      try {
        splitTarget = paneForNextRow(await herdr.getPaneLayout(input.paneId), input.paneId);
      } catch {}
    }
    const pane = await herdr.splitPane({
      paneId: splitTarget,
      direction: "down",
      ratio: 0.5,
      cwd: input.cwd,
      focus: false,
    });
    try {
      await balancePaneRows(herdr, pane.paneId);
    } catch {}
    return pane;
  });
}
