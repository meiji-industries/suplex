/** Stack frames for PostHog Error Tracking, reduced to what holds no user content. */

export type ExceptionFrame = {
  platform: "web:javascript";
  filename: string;
  function: string;
  lineno: number;
  colno: number;
  in_app: true;
  resolved: true;
};

const maxFrames = 30;
// Script paths of this application: a file at the root, a bundle under `/assets`, or a source directory the
// development server serves. Any other path could carry an ID, and none carries a query.
const sourcePath = /^\/(?:(?:assets|features|shell|components|lib|contracts|hooks|node_modules)\/(?:[A-Za-z0-9._@-]+\/)*)?[A-Za-z0-9._@-]+\.(?:m?js|[jt]sx?)$/;
const v8Frame = /^\s*at (?:async )?(?:(?:new )?([^\s(]+) )?\(?(.+?):(\d+):(\d+)\)?\s*$/;
const geckoFrame = /^([^@\s]*)@(.+?):(\d+):(\d+)$/;

function functionName(raw: string | undefined): string {
  const name = (raw ?? "").replace(/^(?:async |new )/, "").split(".").slice(-2).join(".");
  return /^[A-Za-z_$][A-Za-z0-9_$.<>]{0,99}$/.test(name) ? name : "<anonymous>";
}

/** `app://suplex/<path>` for a same-origin bundle or source file, else `undefined`. */
export function normalizeFilename(url: string, origin: string): string | undefined {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return undefined; }
  if (parsed.origin !== origin || !sourcePath.test(parsed.pathname)) return undefined;
  return `app://suplex${parsed.pathname}`;
}

/** Frames from an `Error.stack`, innermost first. Frames from other origins, and lines that are not frames, are dropped. */
export function parseStack(stack: unknown, origin: string): ExceptionFrame[] {
  if (typeof stack !== "string") return [];
  const frames: ExceptionFrame[] = [];
  for (const line of stack.split("\n")) {
    const match = v8Frame.exec(line) ?? geckoFrame.exec(line.trim());
    if (!match) continue;
    const [, name, url, lineno, colno] = match;
    const filename = normalizeFilename(url!, origin);
    if (!filename) continue;
    frames.push({
      platform: "web:javascript",
      filename,
      function: functionName(name),
      lineno: Number(lineno),
      colno: Number(colno),
      in_app: true,
      resolved: true,
    });
    if (frames.length >= maxFrames) break;
  }
  return frames;
}
