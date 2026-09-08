import { chromium } from "playwright";
import { nativeApp } from "./native-app.js";

export async function nativeBrowser(width = 1280, host = "127.0.0.1") {
  const value = await nativeApp();
  const browser = await chromium.launch({ headless: true, args: host === "127.0.0.1" ? [] : [`--host-resolver-rules=MAP ${host} 127.0.0.1`] });
  try {
    await value.app.listen({ host: "127.0.0.1", port: 0 });
    const address = value.app.server.address();
    if (!address || typeof address === "string") throw new Error("No browser test address");
    // The isolated server uses an ephemeral port, which is still a direct loopback origin.
    value.config.port = address.port;
    const base = `http://${host}:${address.port}`;
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addCookies(value.headers.cookie.split("; ").map(pair => {
      const index = pair.indexOf("=");
      return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: host, path: "/" };
    }));
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    return { ...value, browser, page, base, errors,
      async close() { await browser.close(); await value.close(); },
    };
  } catch (error) {
    await browser.close();
    await value.close();
    throw error;
  }
}
