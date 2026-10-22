// Renders a scene frame by frame: node render-scene.mjs <scene.html> stills 1 4 9  |  node render-scene.mjs <scene.html> video out.mp4
import { chromium } from "playwright";
import { spawn } from "node:child_process";
import path from "node:path";

const [scene, mode, ...args] = process.argv.slice(2);
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
await page.goto("file://" + path.resolve(scene));
await page.evaluate(() => document.fonts.ready);

if (mode === "stills") {
  for (const t of args) {
    await page.evaluate(t => window.render(t), Number(t));
    await page.screenshot({ path: `still-${t}.png` });
  }
} else {
  const fps = 30, dur = await page.evaluate(() => window.DUR);
  const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
    "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart", args[0] ?? "out.mp4"], { stdio: ["pipe", "inherit", "inherit"] });
  for (let f = 0; f < Math.round(dur * fps); f++) {
    await page.evaluate(t => window.render(t), f / fps);
    ff.stdin.write(await page.screenshot({ type: "png" }));
  }
  ff.stdin.end();
  await new Promise(r => ff.on("close", r));
}
await browser.close();
