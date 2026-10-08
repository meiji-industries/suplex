// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Zap } from "lucide-react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { SceneIllustration, type Scene } from "../components/app/scene-illustration.js";

const Blank = () => null;
const scenes: Scene[] = [{ label: "One", loop: 2, Scene: Blank }, { label: "Two", loop: 3, Scene: Blank }, { label: "Three", loop: 4, Scene: Blank }];
let root: Root;

const current = () => Array.from(document.querySelectorAll("button")).find(dot => dot.getAttribute("aria-current") === "true")?.getAttribute("aria-label");
const visible = () => document.querySelector("svg[role=img][aria-hidden=false]")?.getAttribute("aria-label");
async function advance(ms: number) { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); }

beforeEach(async () => {
  vi.useFakeTimers();
  const node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  await act(async () => { root.render(<SceneIllustration scenes={scenes} icon={Zap} label="Demo" />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.replaceChildren();
  vi.useRealTimers();
});

test("auto-advance plays every scene once in order and then holds the last scene", async () => {
  expect([current(), visible()]).toEqual(["One", "One"]);
  await advance(2000);
  expect([current(), visible()]).toEqual(["Two", "Two"]);
  await advance(3000);
  expect([current(), visible()]).toEqual(["Three", "Three"]);
  await advance(60_000);
  expect([current(), visible()]).toEqual(["Three", "Three"]);
  expect(vi.getTimerCount()).toBe(0);
});

test("a chosen scene holds and auto-advance does not start again", async () => {
  await act(async () => { document.querySelector<HTMLButtonElement>("button[aria-label=Two]")!.click(); });
  expect([current(), visible()]).toEqual(["Two", "Two"]);
  await advance(60_000);
  expect([current(), visible()]).toEqual(["Two", "Two"]);
});
