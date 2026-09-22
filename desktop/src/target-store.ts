import { readFile, unlink, writeFile } from "node:fs/promises";
import { parseSuplexTarget, type SuplexTarget } from "./suplex-target";

/** The remembered Suplex origins. `current` is always one of `targets`, or null when nothing is chosen. */
export interface TargetRegistry {
  readonly current: SuplexTarget | null;
  readonly targets: readonly SuplexTarget[];
}

const LIMIT = 8;
const EMPTY: TargetRegistry = { current: null, targets: [] };

/** Only an origin (root path, no query) is ever remembered; a first page such as an invitation link is not. */
function originTarget(value: unknown): SuplexTarget | null {
  if (typeof value !== "string") return null;
  try {
    const target = parseSuplexTarget(value);
    return target.url === `${target.origin}/` ? target : null;
  } catch {
    return null;
  }
}

function asOrigin(target: SuplexTarget): SuplexTarget {
  return parseSuplexTarget(`${target.origin}/`);
}

async function write(file: string, registry: TargetRegistry): Promise<TargetRegistry> {
  await writeFile(file, JSON.stringify({ current: registry.current?.url ?? null, targets: registry.targets.map((target) => target.url) }));
  return registry;
}

/** Reads and revalidates the remembered origins. Invalid entries are dropped; a file with none left is deleted. Old `{ url }` files migrate. */
export async function readTargets(file: string): Promise<TargetRegistry> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch {
    return EMPTY;
  }
  let data: { url?: unknown; current?: unknown; targets?: unknown };
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) throw new Error("not an object");
    data = parsed as typeof data;
  } catch {
    await clearTargets(file);
    return EMPTY;
  }
  const listed: unknown[] = Array.isArray(data.targets) ? data.targets : [data.url];
  const targets: SuplexTarget[] = [];
  for (const entry of listed.map(originTarget)) {
    if (entry && !targets.some((target) => target.origin === entry.origin)) targets.push(entry);
  }
  if (targets.length === 0) {
    await clearTargets(file);
    return EMPTY;
  }
  const wanted = originTarget(data.current ?? data.url);
  const current = wanted ? (targets.find((target) => target.origin === wanted.origin) ?? null) : null;
  return { current, targets: targets.slice(0, LIMIT) };
}

/** Makes the target's origin current, adding it to the list when new. Returns the updated registry. */
export async function rememberTarget(file: string, target: SuplexTarget): Promise<TargetRegistry> {
  const entry = asOrigin(target);
  const others = (await readTargets(file)).targets.filter((known) => known.origin !== entry.origin);
  return write(file, { current: entry, targets: [entry, ...others].slice(0, LIMIT) });
}

/** Removes one origin. When it was current, nothing is current afterwards. */
export async function forgetTarget(file: string, origin: string): Promise<TargetRegistry> {
  const registry = await readTargets(file);
  const targets = registry.targets.filter((target) => target.origin !== origin);
  const current = registry.current?.origin === origin ? null : registry.current;
  if (targets.length === 0) {
    await clearTargets(file);
    return EMPTY;
  }
  return write(file, { current, targets });
}

export async function clearTargets(file: string): Promise<void> {
  await unlink(file).catch(() => undefined);
}
