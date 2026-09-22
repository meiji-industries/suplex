import { readFile } from "node:fs/promises";

import type { FastifyPluginAsync } from "fastify";

async function readFrontendAsset(filename: string): Promise<Buffer> {
  const locations = [new URL(`../../../web/${filename}`, import.meta.url), new URL(`../../../dist/web/${filename}`, import.meta.url)];
  for (const location of locations) {
    try {
      return Buffer.from(await readFile(location));
    } catch {
      // Try the source-tree location when running through tsx, then the compiled location.
    }
  }
  throw new Error(`Frontend asset is not built: ${filename}`);
}

const assets: FastifyPluginAsync = async (app) => {
  app.get("/suplex-ui.js", async (_request, reply) => {
    try {
      return reply.type("text/javascript; charset=utf-8").send(await readFrontendAsset("suplex-ui.js"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Suplex UI asset is not built");
    }
  });
  app.get("/suplex-ui.css", async (_request, reply) => {
    try {
      return reply.type("text/css; charset=utf-8").send(await readFrontendAsset("suplex-ui.css"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Suplex UI asset is not built");
    }
  });
  app.get<{ Params: { filename: string } }>("/:filename", async (request, reply) => {
    const { filename } = request.params;
    if (!/^[a-zA-Z0-9._-]+$/.test(filename)) return reply.code(404).send("Not found");
    try {
      const type = filename.endsWith(".js") ? "text/javascript; charset=utf-8" : filename.endsWith(".woff2") ? "font/woff2" : "application/octet-stream";
      return reply.type(type).send(await readFrontendAsset(filename));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Suplex UI asset is not built");
    }
  });
};

export default assets;
