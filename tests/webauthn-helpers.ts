import { createServer } from "node:net";

import type { CDPSession, ChromiumBrowserContext, Page } from "playwright";

export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("Could not determine free port")));
      }
    });
    server.on("error", reject);
  });
}

interface AuthenticatorConfig {
  hasResidentKey?: boolean;
  hasUserVerification?: boolean;
  isUserVerified?: boolean;
}

export async function addVirtualAuthenticator(page: Page, options: AuthenticatorConfig = {}): Promise<CDPSession> {
  const context = page.context() as ChromiumBrowserContext;
  const session = await context.newCDPSession(page);
  await session.send("WebAuthn.enable", { enableUI: true });
  await session.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "usb",
      hasResidentKey: options.hasResidentKey ?? true,
      hasUserVerification: options.hasUserVerification ?? true,
      isUserVerified: options.isUserVerified ?? true,
      automaticPresenceSimulation: true,
    },
  });
  return session;
}
