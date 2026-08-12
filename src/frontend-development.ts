import middie from "@fastify/middie";
import type { FastifyInstance } from "fastify";
import { createServer as createViteServer, type ViteDevServer } from "vite";

import { createAppServer, registerAppRoutes, type AppDependencies } from "./app.js";

export interface DevelopmentApp {
  app: FastifyInstance;
  vite: ViteDevServer;
}

export async function createDevelopmentApp(dependencies: AppDependencies): Promise<DevelopmentApp> {
  const app = createAppServer(dependencies);
  const reachableHost = new URL(dependencies.config.reachableAddress).hostname;
  let vite: ViteDevServer | undefined;
  try {
    vite = await createViteServer({
      appType: "custom",
      configLoader: "native",
      server: {
        allowedHosts: [reachableHost],
        middlewareMode: { server: app.server },
        ws: { server: app.server },
      },
    });
    await app.register(middie);
    app.use(vite.middlewares);
    app.addHook("onClose", async () => vite?.close());
    registerAppRoutes(app, {
      ...dependencies,
      frontendDevelopment: {
        transformIndexHtml: (url, html) => vite!.transformIndexHtml(url, html),
      },
    });
    return { app, vite };
  } catch (error) {
    await vite?.close();
    await app.close().catch(() => undefined);
    throw error;
  }
}
