import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { resolve } from "node:path";
import { createServer } from "vite";

// This process owns development tooling; the native supervisor owns the engine.
const root = resolve(import.meta.dirname, "..");
const port = Number(process.env.SUPLEX_PORT ?? process.env.SUPLEX_RUST_PORT ?? Number(process.env.CONDUCTOR_PORT ?? 4111) + 2);
if (!Number.isInteger(port) || port < 1 || port > 65534) throw new Error("Development port must be between 1 and 65534 (Vite uses port + 1).");
const installation = resolve(process.env.SUPLEX_RUST_ROOT ?? `${root}/.suplex-rust`);
const environment: NodeJS.ProcessEnv = {
  ...process.env,
  SUPLEX_RUST_ROOT: installation,
  SUPLEX_ENV_FILE: process.env.SUPLEX_ENV_FILE ?? `${installation}/suplex.env`,
  SUPLEX_PORT: String(port),
  SUPLEX_ACCESS_MODE: process.env.SUPLEX_ACCESS_MODE ?? "local",
  SUPLEX_BIND_ADDRESS: process.env.SUPLEX_BIND_ADDRESS ?? "127.0.0.1",
  SUPLEX_DEVELOPMENT_AUTO_LOGIN: "1",
  SUPLEX_FRONTEND_DEV_URL: `http://127.0.0.1:${port + 1}`,
};
delete environment.RUSTUP_TOOLCHAIN;
const binary = resolve(root, "rust", process.env.CARGO_TARGET_DIR ?? "target", "debug/suplex");

function completed(child: ChildProcess): Promise<number> {
  return new Promise((accept, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => accept(code ?? (signal ? 1 : 0)));
  });
}

async function build(): Promise<void> {
  const code = await completed(spawn("cargo", ["build", "--bin", "suplex"], { cwd: `${root}/rust`, env: environment, stdio: "inherit" }));
  if (code !== 0) throw new Error(`Rust build failed (${code}).`);
  if (process.env.SUPLEX_CODESIGN_IDENTITY) {
    const signed = await completed(spawn("codesign", ["--force", "--sign", process.env.SUPLEX_CODESIGN_IDENTITY, binary], { stdio: "inherit" }));
    if (signed !== 0) throw new Error(`Code signing failed (${signed}).`);
  }
}

const command = process.argv[2];
if (command !== "--stop" || !existsSync(binary)) await build();
if (command === "--stop" || command === "--desktop" || command === "--migrate") {
  process.exit(await completed(spawn(binary, [command.slice(2)], { cwd: root, env: environment, stdio: "inherit" })));
}
const vite = await createServer({
  root,
  appType: "custom",
  server: { host: "127.0.0.1", port: port + 1, strictPort: true, cors: { origin: /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/ } },
});
await vite.listen();
let server: ChildProcess;
let stopped: Promise<number>;
let closing = false;
let restarting = false;
let changed = false;

function start(): void {
  server = spawn(binary, ["start", "--foreground"], { cwd: root, env: environment, stdio: "inherit" });
  stopped = completed(server);
  void stopped.then(code => { if (!closing && !restarting) void close(code); }, error => { console.error(error); void close(1); });
}

async function restart(): Promise<void> {
  changed = true;
  if (restarting || closing) return;
  restarting = true;
  try {
    while (changed && !closing) {
      changed = false;
      // Build before stopping the working server so compile errors leave it usable.
      await build();
      if (closing) break;
      server.kill("SIGTERM");
      await stopped;
      start();
    }
  } catch (error) {
    console.error(error);
  } finally {
    restarting = false;
  }
}

const watchers = process.argv.includes("--watch") ? ["rust/src", "migrations"].map(path => watch(resolve(root, path), { recursive: true }, () => { void restart(); })) : [];
async function close(code: number): Promise<void> {
  if (closing) return;
  closing = true;
  for (const watcher of watchers) watcher.close();
  server.kill("SIGTERM");
  await stopped;
  await vite.close();
  process.exitCode = code;
}
process.once("SIGINT", () => { void close(0); });
process.once("SIGTERM", () => { void close(0); });
start();
