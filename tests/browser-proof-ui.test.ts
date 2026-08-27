import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, test } from "vitest";

import { TaskBrowserProof } from "../src/frontend/components/app/task-browser-proof.js";

function task(mode: "off" | "capture" | "required", proof: unknown[] = []) {
  return { id: "task-1", executionControls: { visualEvidence: mode }, browserProof: proof } as never;
}

test("omits disabled proof and gives enabled empty proof a compact state", () => {
  expect(renderToStaticMarkup(createElement(TaskBrowserProof, { task: task("off") }))).toBe("");
  const html = renderToStaticMarkup(createElement(TaskBrowserProof, { task: task("capture") }));
  expect(html).toContain("No proof attached"); expect(html).toContain('aria-label="Browser proof"');
});

test("renders shipped thumbnail trigger, provenance, capture metadata, and task-scoped download", () => {
  const executionId = `developer_${"long".repeat(40)}`;
  const html = renderToStaticMarkup(createElement(TaskBrowserProof, { task: task("required", [{ version: 1, manifestArtifactId: "manifest-1", taskId: "task-1", companyId: "company-1", developerExecutionId: executionId, resultCommit: "a".repeat(40), resultTree: "b".repeat(40), summary: "Desktop proof", createdAt: "2026-08-26T12:30:00.000Z", images: [{ artifactId: "image-1", sha256: "c".repeat(64), filename: "screen.png", mimeType: "image/png", byteSize: 45, caption: "Narrow layout", viewport: { width: 390, height: 844, deviceScaleFactor: 2 }, capturedAt: "2026-08-26T12:00:00.000Z" }] }]) }));
  expect(html).toContain('data-browser-proof="true"');
  expect(html).toContain('data-slot="dialog-trigger"'); expect(html).toContain('data-variant="outline"');
  expect(html).toContain("Narrow layout"); expect(html).toContain("390×844 @2x");
  expect(html).toContain('dateTime="2026-08-26T12:00:00.000Z"');
  expect(html).toContain(`/api/tasks/task-1/artifacts/image-1`); expect(html).toContain('download="screen.png"');
  expect(html).toContain('class="max-w-full truncate"'); expect(html).toContain(`title="${executionId}"`);
});
