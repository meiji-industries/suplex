"use strict";
// Stands in for the packaged supervisor: it answers /health on FORGE_PORT and nothing else.
const { createServer } = require("node:http");

const port = Number(process.env.FORGE_PORT ?? 4111);
const server = createServer((request, response) => {
  process.stdout.write(`${request.method} ${request.url}\n`);
  if (request.url === "/health") { response.writeHead(200, { "content-type": "text/plain" }); response.end("ok"); return; }
  response.writeHead(200, { "content-type": "text/html" });
  response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Forge fixture</title></head><body style="background:#0a0a0a;color:#e5e5e5;font:13px -apple-system,system-ui,sans-serif"><p id="fixture">Forge fixture server on port ${port}</p></body></html>`);
});
server.listen(port, "127.0.0.1", () => { process.stdout.write(`fixture supervisor listening on ${port} (data ${process.env.FORGE_DATA_ROOT ?? ""})\n`); });
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(() => { process.exit(0); }); });
