// pnpm desktop:dev: runs the Tauri shell against this checkout's development host.
//
// - Reuses this checkout's running dev stack (its /health reports this checkout's installation id), or starts
//   `pnpm dev:watch` and owns it. A listener for another checkout or program is never used or stopped.
// - Builds the shell with the dev bundle id dev.suplex.desktop.dev and data under .context/tauri-migration/.
// - Rebuilds the shell when desktop/src-tauri or the setup pages change, and restarts only the shell.
//   React edits reach the page through Vite HMR; host Rust edits go through the stack's own watcher.
// - On exit, stops the shell and, only if this launcher started it, the dev stack.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const desktop = resolve(import.meta.dirname, "..");
const root = resolve(desktop, "..");
const port = Number(process.env.SUPLEX_PORT ?? process.env.CONDUCTOR_PORT ?? 14111);
const origin = `http://127.0.0.1:${port}`;
const installation = resolve(process.env.SUPLEX_ROOT ?? `${root}/.suplex`, "installation-id");
const userData = process.env.SUPLEX_DESKTOP_USER_DATA ?? resolve(root, ".context/tauri-migration/desktop-dev-data");
const targetDir = resolve(desktop, "src-tauri/target/dev");
const shellBinary = resolve(targetDir, "debug/suplex-desktop");
const environment = { ...process.env };
delete environment.RUSTUP_TOOLCHAIN;

const log = (message) => process.stderr.write(`[desktop:dev] ${message}\n`);
const sleep = (ms) => new Promise((accept) => setTimeout(accept, ms));
const ours = () => (existsSync(installation) ? readFileSync(installation, "utf8").trim() : "");

/** "ours", "other", or "free": who answers on this checkout's dev port. */
async function listener() {
  try {
    const response = await fetch(`${origin}/health`, { redirect: "manual", signal: AbortSignal.timeout(2_000) });
    const served = response.headers.get("x-suplex-installation-id") ?? "";
    return served !== "" && served === ours() ? "ours" : "other";
  } catch {
    return "free";
  }
}

let stack = null;
let shell = null;
let closing = false;

async function startStack() {
  log(`starting this checkout's dev stack on ${origin}`);
  // Its own process group, so stopping it reaches its Vite and host children and nothing else.
  stack = spawn("pnpm", ["run", "dev:watch"], { cwd: root, env: environment, stdio: "inherit", detached: true });
  stack.once("exit", (code) => {
    stack = null;
    if (!closing) { log(`the dev stack exited (${code})`); void close(1); }
  });
  for (let waited = 0; waited < 600; waited += 1) {
    if ((await listener()) === "ours") return;
    if (!stack) throw new Error("The dev stack stopped while starting.");
    await sleep(500);
  }
  throw new Error(`The dev stack did not answer ${origin}/health within 5 minutes.`);
}

// SUPLEX_DESKTOP_DEV_FEATURES=native-test adds the test driver, for scripted checks of the dev loop.
const features = process.env.SUPLEX_DESKTOP_DEV_FEATURES ? ["--features", process.env.SUPLEX_DESKTOP_DEV_FEATURES] : [];
function build() {
  const result = spawnSync("cargo", ["build", "--manifest-path", resolve(desktop, "src-tauri/Cargo.toml"), ...features], {
    cwd: desktop,
    stdio: "inherit",
    env: { ...environment, CARGO_TARGET_DIR: targetDir, TAURI_CONFIG: JSON.stringify({ identifier: "dev.suplex.desktop.dev", productName: "Suplex Dev" }) },
  });
  return result.status === 0;
}

function startShell() {
  mkdirSync(userData, { recursive: true });
  // "This Mac" in the dev shell runs this checkout's debug host from its own data directory and port.
  const runtime = resolve(desktop, ".build/dev-runtime");
  mkdirSync(runtime, { recursive: true });
  writeFileSync(resolve(runtime, "manifest.json"), JSON.stringify({ version: JSON.parse(readFileSync(resolve(desktop, "package.json"), "utf8")).version }));
  const hostTarget = process.env.CARGO_TARGET_DIR ?? resolve(root, "rust/target");
  shell = spawn(shellBinary, [], {
    cwd: desktop,
    stdio: "inherit",
    env: {
      ...environment,
      SUPLEX_DESKTOP_USER_DATA: userData,
      SUPLEX_DESKTOP_URL: environment.SUPLEX_DESKTOP_URL ?? `${origin}/`,
      SUPLEX_DESKTOP_RUNTIME: environment.SUPLEX_DESKTOP_RUNTIME ?? runtime,
      SUPLEX_DESKTOP_BINARY: environment.SUPLEX_DESKTOP_BINARY ?? resolve(hostTarget, "debug/suplex"),
      SUPLEX_DESKTOP_PORT: environment.SUPLEX_DESKTOP_PORT ?? "4121",
    },
  });
  const running = shell;
  running.once("exit", () => {
    if (shell === running) { shell = null; if (!closing && !restarting) void close(0); }
  });
}

async function stopShell() {
  const running = shell;
  if (!running || running.exitCode !== null) return;
  const exited = new Promise((accept) => running.once("exit", accept));
  running.kill("SIGTERM");
  if (await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)])) return;
  running.kill("SIGKILL");
  await exited;
}

let restarting = false;
let changed = false;
async function restart() {
  changed = true;
  if (restarting || closing) return;
  restarting = true;
  try {
    while (changed && !closing) {
      changed = false;
      // Build before stopping the running shell, so a compile error leaves it usable.
      if (!build()) { log("shell build failed; the running shell stays up"); continue; }
      await stopShell();
      if (!closing) startShell();
    }
  } finally {
    restarting = false;
  }
}

async function close(code) {
  if (closing) return;
  closing = true;
  for (const watcher of watchers) watcher.close();
  await stopShell();
  if (stack?.pid) {
    const exited = new Promise((accept) => stack.once("exit", accept));
    try { process.kill(-stack.pid, "SIGTERM"); } catch { /* already gone */ }
    await Promise.race([exited, sleep(10_000)]);
    if (stack) try { process.kill(-stack.pid, "SIGKILL"); } catch { /* already gone */ }
  }
  process.exit(code);
}

const watchers = [];
process.once("SIGINT", () => { void close(0); });
process.once("SIGTERM", () => { void close(0); });
process.once("SIGHUP", () => { void close(0); });

const found = await listener();
if (found === "other") {
  log(`${origin} answers for another checkout or program. Stop it, or set SUPLEX_PORT to this checkout's dev port.`);
  process.exit(1);
}
if (found === "free") await startStack().catch(async (error) => { log(error.message); await close(1); });
else log(`reusing this checkout's dev stack on ${origin}`);
if (!build()) await close(1);
startShell();
let pending;
const schedule = () => { clearTimeout(pending); pending = setTimeout(() => { void restart(); }, 300); };
// Recursive (FSEvents) watches only: a single-file fs.watch on macOS fires `change` with no edit, which restarted the shell in a loop.
const shellSource = /^(src|capabilities)\/|^(Cargo\.toml|tauri\.conf\.json|build\.rs)$/;
watchers.push(watch(resolve(desktop, "src-tauri"), { recursive: true }, (_, file) => { if (file && shellSource.test(file)) schedule(); }));
watchers.push(watch(resolve(desktop, "src"), { recursive: true }, (_, file) => { if (file) schedule(); }));
