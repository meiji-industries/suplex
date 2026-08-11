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
  app.get("/forge-ui.js", async (_request, reply) => {
    try {
      return reply.type("text/javascript; charset=utf-8").send(await readFrontendAsset("forge-ui.js"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Forge UI asset is not built");
    }
  });
  app.get("/forge-ui.css", async (_request, reply) => {
    try {
      return reply.type("text/css; charset=utf-8").send(await readFrontendAsset("forge-ui.css"));
    } catch {
      return reply.code(404).type("text/plain; charset=utf-8").send("Forge UI asset is not built");
    }
  });
};

export default assets;
