// Preload with `tsx --import` so one interop script exits 2 after SUPLEX_JOURNEY_TIMEOUT_MS.
const timeoutMs = Number(process.env.SUPLEX_JOURNEY_TIMEOUT_MS ?? 300_000);
setTimeout(() => {
  console.error(`[interop] ${process.argv[1]} timed out after ${timeoutMs} ms`);
  process.exit(2);
}, timeoutMs).unref();
