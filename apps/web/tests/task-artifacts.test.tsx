// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, test, vi } from "vitest";

import type { Task } from "../contracts/tasks.js";
import { TaskArtifacts } from "../features/tasks/task-artifacts.js";

Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true });

type ArtifactTask = Pick<Task, "id" | "artifacts">;

const image = { artifactId: "image-1", filename: "result.png", mimeType: "image/png", byteSize: 2048 };
const video = { artifactId: "video-1", filename: "demo.mp4", mimeType: "video/mp4", byteSize: 4096 };
const report = { artifactId: "report-1", filename: "report.json", mimeType: "application/json", byteSize: 512 };

const roots: Root[] = [];

function mount(task: ArtifactTask) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (nextTask = task) => {
    await act(async () => { root.render(<TaskArtifacts task={nextTask} />); });
  };
  return { container, render };
}

function thumbnail(filename: string): HTMLElement {
  const value = document.querySelector<HTMLElement>(`[role="button"][aria-label="Open ${filename}"]`);
  if (!value) throw new Error(`Thumbnail was not rendered for ${filename}`);
  return value;
}

async function click(element: HTMLElement) {
  await act(async () => { element.click(); });
}

afterEach(async () => {
  await act(async () => { roots.splice(0).forEach(root => root.unmount()); });
  document.body.replaceChildren();
});

test("an image thumbnail opens the image preview and the close button restores its focus", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const view = mount({ id: "task-1", artifacts: [image] });
  try {
    await view.render();
    const trigger = thumbnail(image.filename);

    await click(trigger);

    const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain(image.filename);
    expect(dialog?.querySelector<HTMLImageElement>(`img[src="/api/tasks/task-1/artifacts/${image.artifactId}"]`)?.alt).toBe(image.filename);
    expect(dialog?.querySelector<HTMLAnchorElement>(`a[href="/api/tasks/task-1/artifacts/${image.artifactId}"]`)?.textContent).toBe("Open original");
    expect(errors).not.toHaveBeenCalled();

    const close = dialog?.querySelector<HTMLElement>('[data-slot="dialog-close"]');
    if (!close) throw new Error("The preview close button was not rendered");
    await click(close);
    await act(async () => { await new Promise(resolve => window.setTimeout(resolve, 0)); });

    expect(document.querySelector('[data-slot="dialog-content"] img')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  } finally {
    errors.mockRestore();
  }
});

test("a video preview has native playback controls and unmounts when it closes", async () => {
  const view = mount({ id: "task-1", artifacts: [video] });
  await view.render();
  await click(thumbnail(video.filename));

  const media = document.querySelector<HTMLVideoElement>('[data-slot="dialog-content"] video');
  expect(media?.controls).toBe(true);
  expect(media?.hasAttribute("playsinline")).toBe(true);
  expect(media?.autoplay).toBe(false);
  expect(media?.getAttribute("src")).toBe(`/api/tasks/task-1/artifacts/${video.artifactId}`);

  const close = document.querySelector<HTMLElement>('[data-slot="dialog-close"]');
  if (!close) throw new Error("The preview close button was not rendered");
  await click(close);
  expect(document.querySelector('[data-slot="dialog-content"] video')).toBeNull();
});

test("switching visual artifacts unmounts the active video", async () => {
  const view = mount({ id: "task-1", artifacts: [video, image] });
  await view.render();
  await click(thumbnail(video.filename));
  expect(document.querySelector('[data-slot="dialog-content"] video')).not.toBeNull();

  const next = document.querySelector<HTMLElement>('button[aria-label="Open next artifact"]');
  if (!next) throw new Error("The next artifact button was not rendered");
  await click(next);

  const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  expect(dialog?.querySelector("video")).toBeNull();
  expect(dialog?.querySelector<HTMLImageElement>(`img[src="/api/tasks/task-1/artifacts/${image.artifactId}"]`)?.alt).toBe(image.filename);
});

test("a generic artifact remains a direct download instead of a broken media preview", async () => {
  const view = mount({ id: "task-1", artifacts: [report] });
  await view.render();

  const link = view.container.querySelector<HTMLAnchorElement>(`a[href="/api/tasks/task-1/artifacts/${report.artifactId}"]`);
  expect(link?.textContent).toBe(report.filename);
  expect(link?.download).toBe(report.filename);
  expect(view.container.querySelector("img, video")).toBeNull();
});

test("the card stays hidden without artifacts and updates when artifacts change", async () => {
  const view = mount({ id: "task-1", artifacts: [] });
  await view.render();
  expect(view.container.querySelector('[aria-label="Artifacts"]')).toBeNull();

  await view.render({ id: "task-1", artifacts: [image] });
  expect(view.container.querySelector('[aria-label="Artifacts"]')).not.toBeNull();
  expect(thumbnail(image.filename)).not.toBeNull();

  await view.render({ id: "task-1", artifacts: [video, report] });
  expect(document.querySelector(`[aria-label="Open ${image.filename}"]`)).toBeNull();
  expect(thumbnail(video.filename)).not.toBeNull();
  expect(view.container.textContent).toContain(report.filename);
});

test("a failed image thumbnail shows its filename", async () => {
  const view = mount({ id: "task-1", artifacts: [image] });
  await view.render();
  const previewImage = thumbnail(image.filename).querySelector("img");
  if (!previewImage) throw new Error("The image thumbnail was not rendered");

  await act(async () => { previewImage.dispatchEvent(new Event("error")); });

  expect(thumbnail(image.filename).textContent).toContain(image.filename);
  expect(thumbnail(image.filename).querySelector("img")).toBeNull();
});

test("a failed full image preview keeps an understandable fallback and the original action", async () => {
  const view = mount({ id: "task-1", artifacts: [image] });
  await view.render();
  await click(thumbnail(image.filename));
  const previewImage = document.querySelector<HTMLImageElement>('[data-slot="dialog-content"] img');
  if (!previewImage) throw new Error("The full image preview was not rendered");

  await act(async () => { previewImage.dispatchEvent(new Event("error")); });

  const dialog = document.querySelector<HTMLElement>('[data-slot="dialog-content"]');
  expect(dialog?.querySelector('[role="status"]')?.textContent).toBe(`Preview not available for ${image.filename}.`);
  expect(dialog?.querySelector<HTMLAnchorElement>(`a[href="/api/tasks/task-1/artifacts/${image.artifactId}"]`)?.textContent).toBe("Open original");
});
