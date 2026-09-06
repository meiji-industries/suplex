export type ForgeUrl = string & { readonly __brand: "ForgeUrl" };

export interface ForgeTarget {
  readonly url: ForgeUrl;
  readonly origin: string;
}

export type NavigationDecision =
  | { readonly kind: "internal"; readonly url: ForgeUrl }
  | { readonly kind: "external"; readonly url: string }
  | { readonly kind: "blocked"; readonly reason: string };

export type TargetSource = "argument" | "environment" | "persisted";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * Validates one external string as a Forge target. Throws with a short reason.
 * https anywhere, or http on the loopback host where Forge signs in the local operator.
 * The path and query are kept as the first page to load (an invitation link);
 * the origin is what every later same-origin check compares against.
 */
export function parseForgeTarget(value: string): ForgeTarget {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("The value is not an absolute URL.");
  }
  if (url.username !== "" || url.password !== "") throw new Error("The URL must not contain credentials.");
  if (url.hash !== "") throw new Error("The URL must not contain a fragment.");
  if (url.protocol === "http:") {
    if (!LOOPBACK_HOSTS.has(url.hostname)) throw new Error("http is accepted only for localhost.");
  } else if (url.protocol !== "https:") {
    throw new Error("Only https URLs are accepted.");
  }
  return { url: url.href as ForgeUrl, origin: url.origin };
}

/**
 * Finds `--url=<value>` or `--url <value>`. A second launch reaches the running app through Chromium,
 * which reorders the command line so switches come first and positionals last; a bare `--url` then
 * takes the last positional that is an absolute URL.
 */
function argumentValue(argv: readonly string[]): string | undefined {
  const assigned = argv.find((entry) => entry.startsWith("--url="));
  if (assigned !== undefined) return assigned.slice("--url=".length);
  const index = argv.indexOf("--url");
  if (index === -1) return undefined;
  const next = argv[index + 1];
  if (next !== undefined && !next.startsWith("-")) return next;
  return [...argv].reverse().find((entry) => /^https?:\/\//.test(entry)) ?? "";
}

/** Argument, then environment, then persisted. An explicit invalid value throws; it never falls through. */
export function resolveForgeTarget(input: {
  readonly argv: readonly string[];
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly persisted: string | null;
}): { readonly source: TargetSource; readonly target: ForgeTarget } | null {
  const explicit: ReadonlyArray<[TargetSource, string | undefined]> = [
    ["argument", argumentValue(input.argv)],
    ["environment", input.environment.FORGE_DESKTOP_URL],
  ];
  for (const [source, value] of explicit) {
    if (value === undefined) continue;
    try {
      return { source, target: parseForgeTarget(value) };
    } catch (error) {
      throw new Error(`${source === "argument" ? "--url" : "FORGE_DESKTOP_URL"} is not valid: ${(error as Error).message}`);
    }
  }
  if (input.persisted === null) return null;
  try {
    return { source: "persisted", target: parseForgeTarget(input.persisted) };
  } catch {
    return null;
  }
}

/** Decides where a navigation or popup goes relative to the configured origin. Fails closed. */
export function classifyNavigation(url: string, origin: string | null): NavigationDecision {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { kind: "blocked", reason: "not a URL" };
  }
  if (origin !== null && parsed.origin === origin) return { kind: "internal", url: parsed.href as ForgeUrl };
  if (parsed.protocol === "http:" || parsed.protocol === "https:") return { kind: "external", url: parsed.href };
  return { kind: "blocked", reason: `${parsed.protocol} is not allowed` };
}
