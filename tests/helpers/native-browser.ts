// eslint-disable-next-line no-restricted-imports -- The isolated Rust API is a long-running test process; runCommand waits for exit.
import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { chromium } from "playwright";
import { nativeApp } from "./native-app.js";

async function loopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((accept, reject) => server.once("error", reject).listen(0, "127.0.0.1", accept));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No Rust browser test port");
  await new Promise<void>((accept, reject) => server.close(error => error ? reject(error) : accept()));
  return address.port;
}

async function startRustServer(root: string, port: number): Promise<() => Promise<void>> {
  const executable = resolve(process.env.SUPLEX_RUST_BIN ?? "rust/target/debug/suplex");
  const assets = resolve(process.env.SUPLEX_RUST_ASSETS_DIR ?? "dist/web");
  await stat(executable);
  await stat(resolve(assets, "suplex-ui.js"));
  const child = spawn(executable, [], {
    env: {
      ...process.env,
      SUPLEX_RUST_ROOT: root,
      SUPLEX_RUST_PORT: String(port),
      SUPLEX_RUST_ASSETS_DIR: assets,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  let failure: Error | undefined;
  child.once("error", error => { failure = error; });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + String(chunk)).slice(-8_000); });
  const exited = new Promise<void>(accept => child.once("close", () => accept()));
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.race([exited, new Promise<void>(accept => setTimeout(accept, 2_000))]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await exited;
    }
  };
  try {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (failure || child.exitCode !== null || child.signalCode !== null) throw new Error(`Rust browser API exited during startup: ${failure?.message ?? output}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/auth`, { signal: AbortSignal.timeout(500) });
        if (response.ok) return stop;
      } catch {
        // The isolated listener has not bound yet.
      }
      await new Promise(accept => setTimeout(accept, 100));
    }
    throw new Error(`Rust browser API did not listen on ${port}: ${output}`);
  } catch (error) {
    await stop();
    throw error;
  }
}

export async function nativeBrowser(width = 1280, host = "127.0.0.1", reachableAddress?: string) {
  const rust = process.env.SUPLEX_BROWSER_BACKEND === "rust";
  if (rust && host !== "127.0.0.1") throw new Error("Rust browser fixtures require a direct loopback origin");
  const port = rust ? (reachableAddress ? Number(new URL(reachableAddress).port) : await loopbackPort()) : undefined;
  const value = await nativeApp(rust
    ? { reachableAddress: `http://127.0.0.1:${port}`, rustLayout: true }
    : reachableAddress ? { reachableAddress } : {});
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  let stopRust: (() => Promise<void>) | undefined;
  try {
    browser = await chromium.launch({ headless: true, args: host === "127.0.0.1" ? [] : [`--host-resolver-rules=MAP ${host} 127.0.0.1`] });
    if (rust) stopRust = await startRustServer(value.directory, port!);
    else await value.app.listen({ host: "127.0.0.1", port: reachableAddress ? Number(new URL(reachableAddress).port) : 0 });
    const address = rust ? port : value.app.server.address();
    if (!address || typeof address === "string") throw new Error("No browser test address");
    // Each fixture uses an isolated loopback origin and database.
    value.config.port = typeof address === "number" ? address : address.port;
    const base = `http://${host}:${value.config.port}`;
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addCookies(value.headers.cookie.split("; ").map(pair => {
      const index = pair.indexOf("=");
      return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: host, path: "/" };
    }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    const openedBrowser = browser;
    return { ...value, browser, page, base, errors, backend: rust ? "rust" as const : "typescript" as const,
      async close() { try { await openedBrowser.close(); } finally { try { await stopRust?.(); } finally { await value.close(); } } },
    };
  } catch (error) {
    try { await browser?.close(); } finally { try { await stopRust?.(); } finally { await value.close(); } }
    throw error;
  }
}
