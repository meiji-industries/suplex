import { chromium } from "playwright";
import { nativeApp } from "./native-app.js";

export async function nativeBrowser(width = 1280) {
  const value = await nativeApp();
  const browser = await chromium.launch({ headless: true });
  try {
    await value.app.listen({ host: "127.0.0.1", port: 0 });
    const address = value.app.server.address();
    if (!address || typeof address === "string") throw new Error("No browser test address");
    const base = `http://127.0.0.1:${address.port}`;
    const context = await browser.newContext({ viewport: { width, height: 844 } });
    await context.addCookies(value.headers.cookie.split("; ").map(pair => {
      const index = pair.indexOf("=");
      return { name: pair.slice(0, index), value: pair.slice(index + 1), domain: "127.0.0.1", path: "/" };
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
