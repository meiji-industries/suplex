/** @vitest-environment jsdom */
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { CostValue } from "../components/app/cost-value.js";
import { compact } from "../features/analytics/lib/analytics.js";
import { hasUsageValue, parseUsageDisplay, readUsageDisplay, saveUsageDisplay, usageDisplayOptions, usageDisplayStorageKey } from "../features/analytics/lib/usage-display.js";

beforeEach(() => {
  const stored = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } });
});
afterEach(() => { saveUsageDisplay("spend"); vi.unstubAllGlobals(); });

test("compact shows at most three significant digits", () => {
  expect([0, 900, 1_000, 80_200, 800_000, 99_200_000, 993_000_000, 1_020_000_000].map(compact))
    .toEqual(["0", "900", "1K", "80.2K", "800K", "99.2M", "993M", "1.02B"]);
  expect(compact(999_999)).toBe("1M");
});

test("usage display defaults to spend and saves to browser storage", () => {
  expect(usageDisplayOptions.map(option => option.label)).toEqual(["Spend", "Tokens"]);
  expect([null, "", "invalid", "spend", "tokens"].map(parseUsageDisplay)).toEqual(["spend", "spend", "spend", "spend", "tokens"]);
  expect(readUsageDisplay()).toBe("spend");
  expect(saveUsageDisplay("tokens")).toBe("tokens");
  expect(window.localStorage.getItem(usageDisplayStorageKey)).toBe("tokens");
  expect(readUsageDisplay()).toBe("tokens");
  expect(saveUsageDisplay("invalid")).toBe("spend");
});

test("task rows show unpriced usage only as tokens", () => {
  const unpriced = { cost: null, totalTokens: 12 };
  expect(hasUsageValue(unpriced, "spend")).toBe(false);
  expect(hasUsageValue(unpriced, "tokens")).toBe(true);
  expect(hasUsageValue({ cost: null, totalTokens: 0 }, "tokens")).toBe(false);
  expect(hasUsageValue({ cost: 1, totalTokens: 0 }, "spend")).toBe(true);
  expect(hasUsageValue(undefined, "tokens")).toBe(false);
});

test("mounted cost values follow the usage display", async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const container = document.createElement("div");
  const root = createRoot(container);
  const span = () => container.querySelector("span")!;
  try {
    await act(async () => root.render(<CostValue value={1.5} tokens={80_200} subsidized={false} partial suffix="+" />));
    expect(span().textContent).toBe("$1.50+");
    expect(span().title).toContain("Estimated cost (USD)");

    await act(async () => { saveUsageDisplay("tokens"); });
    expect(span().textContent).toBe("80.2K+");
    expect(span().title).toBe("Total tokens. Suplex counts input, output, reasoning, and cache tokens. Usage is partial.");
    expect(span().getAttribute("aria-label")).toBe(`80.2K. ${span().title}`);

    await act(async () => root.render(<CostValue value={null} tokens={null} subsidized={false} partial={false} />));
    expect(span().textContent).toBe("Not available");

    await act(async () => { saveUsageDisplay("spend"); });
    expect(span().textContent).toBe("Not available");
    expect(span().title).toContain("Estimated cost (USD)");
  } finally {
    await act(async () => root.unmount());
  }
});
