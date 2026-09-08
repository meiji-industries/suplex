import { expect, test, vi } from "vitest";

import type { HerdrClient, PaneLayout } from "../src/integrations/herdr/client.js";
import { balancedRowResizes, paneForNextRow, splitBalancedPaneRow } from "../src/tasks/execution/pane-layout.js";

const layout: PaneLayout = {
  workspaceId: "w1",
  tabId: "w1:t1",
  zoomed: false,
  focusedPaneId: "p1",
  area: { x: 0, y: 0, width: 120, height: 60 },
  panes: [
    { paneId: "p1", focused: false, rect: { x: 0, y: 0, width: 120, height: 15 } },
    { paneId: "p2", focused: false, rect: { x: 0, y: 15, width: 120, height: 15 } },
    { paneId: "p3", focused: true, rect: { x: 0, y: 30, width: 120, height: 30 } },
  ],
  splits: [
    { id: "root", direction: "down", ratio: 0.5, rect: { x: 0, y: 0, width: 120, height: 60 } },
    { id: "top", direction: "down", ratio: 0.5, rect: { x: 0, y: 0, width: 120, height: 30 } },
  ],
};

test("chooses a tallest row and balances split ratios by descendant pane counts", () => {
  expect(paneForNextRow(layout, "fallback")).toBe("p3");
  const [resize] = balancedRowResizes(layout);
  expect(resize).toMatchObject({ paneId: "p2", direction: "down" });
  expect(resize?.amount).toBeCloseTo(1 / 6);
});

test("breaks equal-height ties with the shallowest leaf to keep the split tree balanced", () => {
  const equalRows: PaneLayout = {
    ...layout,
    panes: [
      { paneId: "p1", focused: false, rect: { x: 0, y: 0, width: 120, height: 20 } },
      { paneId: "p2", focused: false, rect: { x: 0, y: 20, width: 120, height: 20 } },
      { paneId: "p3", focused: true, rect: { x: 0, y: 40, width: 120, height: 20 } },
    ],
    splits: [
      { id: "root", direction: "down", ratio: 2 / 3, rect: { x: 0, y: 0, width: 120, height: 60 } },
      { id: "top", direction: "down", ratio: 0.5, rect: { x: 0, y: 0, width: 120, height: 40 } },
    ],
  };

  expect(paneForNextRow(equalRows, "fallback")).toBe("p3");
});

test("splits downward and keeps layout maintenance presentation-only", async () => {
  const splitPane = vi.fn(async () => ({ paneId: "p4" }));
  const herdr: Pick<HerdrClient, "getPaneLayout" | "resizePane" | "splitPane"> = {
    getPaneLayout: vi.fn()
      .mockResolvedValueOnce(layout)
      .mockResolvedValueOnce(layout)
      .mockRejectedValueOnce(new Error("layout unavailable")),
    resizePane: vi.fn(),
    splitPane,
  };

  await expect(splitBalancedPaneRow(herdr, { paneId: "p1", cwd: "/repo" })).resolves.toEqual({ paneId: "p4" });
  expect(splitPane).toHaveBeenCalledWith({ paneId: "p3", direction: "down", ratio: 0.5, cwd: "/repo", focus: false });
});

test("falls back to the known pane when the layout cannot be observed", async () => {
  const splitPane = vi.fn(async () => ({ paneId: "p2" }));
  const herdr: Pick<HerdrClient, "getPaneLayout" | "resizePane" | "splitPane"> = {
    getPaneLayout: vi.fn(async () => { throw new Error("layout unavailable"); }),
    resizePane: vi.fn(),
    splitPane,
  };

  await splitBalancedPaneRow(herdr, { paneId: "p1", cwd: "/repo" });
  expect(splitPane).toHaveBeenCalledWith({ paneId: "p1", direction: "down", ratio: 0.5, cwd: "/repo", focus: false });
});

test("serializes concurrent layout updates in the same tab", async () => {
  let resolveFirstSplit: (pane: { paneId: string }) => void = () => undefined;
  const firstSplit = new Promise<{ paneId: string }>(resolve => {
    resolveFirstSplit = resolve;
  });
  let nextPane = 4;
  const splitPane = vi.fn(() => {
    if (splitPane.mock.calls.length === 1) return firstSplit;
    return Promise.resolve({ paneId: `p${nextPane++}` });
  });
  const herdr: Pick<HerdrClient, "getPaneLayout" | "resizePane" | "splitPane"> = {
    getPaneLayout: vi.fn(async () => layout),
    resizePane: vi.fn(),
    splitPane,
  };

  const additions = [
    splitBalancedPaneRow(herdr, { paneId: "p1", cwd: "/repo" }),
    splitBalancedPaneRow(herdr, { paneId: "p1", cwd: "/repo" }),
  ];
  await vi.waitFor(() => expect(splitPane).toHaveBeenCalledTimes(1));
  expect(splitPane).toHaveBeenCalledTimes(1);

  resolveFirstSplit({ paneId: "p4" });
  await expect(Promise.all(additions)).resolves.toHaveLength(2);
  expect(splitPane).toHaveBeenCalledTimes(2);
});

test("continues the tab queue after a split fails", async () => {
  const splitPane = vi.fn()
    .mockRejectedValueOnce(new Error("split failed"))
    .mockResolvedValueOnce({ paneId: "p4" });
  const herdr: Pick<HerdrClient, "getPaneLayout" | "resizePane" | "splitPane"> = {
    getPaneLayout: vi.fn(async () => layout),
    resizePane: vi.fn(),
    splitPane,
  };

  await expect(splitBalancedPaneRow(herdr, { paneId: "p1", cwd: "/repo" })).rejects.toThrow("split failed");
  await expect(splitBalancedPaneRow(herdr, { paneId: "p1", cwd: "/repo" })).resolves.toEqual({ paneId: "p4" });
});
