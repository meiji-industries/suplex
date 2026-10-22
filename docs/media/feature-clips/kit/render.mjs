#!/usr/bin/env node
// Suplex clip renderer: node render.mjs [reel.json]
// 1. Renders the frame layers with Chromium (Playwright): background, clip mask, overlays, end cards.
// 2. Builds each clip with ffmpeg: background → clip (cropped, rounded) → overlay → progress fill.
// 3. "mode": "separate" (default) → one video per clip, each ending on the end card in the opposite colour.
//    "mode": "reel"               → one video with every clip in sequence, ending on one end card.
// Grounds alternate dark, lime, dark… unless a clip sets "theme": "dark" | "lime".
import { chromium } from 'playwright';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdirSync, existsSync, copyFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const cfgPath = resolve(process.argv[2] || 'reel.json');
const root = dirname(cfgPath);                      // clips, outDir: relative to the config
const kit = dirname(fileURLToPath(import.meta.url)); // card.html: next to this script
const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'));
const FPS = cfg.fps || 30, T = cfg.transition ?? 0.4, MODE = cfg.mode || 'separate';
const WIDE = cfg.format === '16x9';                  // "format": "16x9" → 1920×1080, clip on the right
const W = WIDE ? 1920 : 1080, H = WIDE ? 1080 : 1350;
const [SX, SY, SW, SH] = WIDE ? [712, 180, 1152, 747] : [56, 200, 968, 628];          // clip slot
const BX = 56, BY = 44, BH = 4, GAP = 8;              // progress bars
const segs = cfg.segments.map((s, i) => ({ ...s, theme: s.theme || (i % 2 ? 'lime' : 'dark') }));
const opposite = th => (th === 'lime' ? 'dark' : 'lime');
const BAR = { dark: { track: '0x3a3a39', fill: '0xd5ff40' }, lime: { track: '0xb0d336', fill: '0x0a0a0a' } };
const outDir = resolve(root, cfg.outDir || 'out'); mkdirSync(outDir, { recursive: true });
const layersDir = resolve(outDir, 'layers'); mkdirSync(layersDir, { recursive: true });
const tmp = resolve(root, '.reel-tmp'); mkdirSync(tmp, { recursive: true });
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

const ff = args => {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', ...args], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed: ' + args.join(' '));
};

// 1 · layers
const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
const page = await browser.newPage({ viewport: { width: W, height: H } });
const layer = async (data, name) => {
  const url = pathToFileURL(resolve(kit, 'card.html')).href + '#' + encodeURIComponent(JSON.stringify(data));
  await page.goto('about:blank'); await page.goto(url);
  await page.waitForSelector('body[data-ready="1"]');
  const file = `${tmp}/${name}.png`;
  await page.screenshot({ path: file, omitBackground: true, clip: { x: 0, y: 0, width: W, height: H } });
  copyFileSync(file, `${layersDir}/${name}.png`);
  return file;
};
const bg = { dark: await layer({ type: 'bg', theme: 'dark', format: cfg.format }, 'background-dark'), lime: await layer({ type: 'bg', theme: 'lime', format: cfg.format }, 'background-lime') };
const end = { dark: await layer({ type: 'end', format: cfg.format, theme: 'dark', label: cfg.end.label, headline: cfg.end.headline, url: cfg.url }, 'end-card-dark'),
              lime: await layer({ type: 'end', format: cfg.format, theme: 'lime', label: cfg.end.label, headline: cfg.end.headline, url: cfg.url }, 'end-card-lime') };
const mask = await layer({ type: 'mask', format: cfg.format }, 'clip-mask');
const overlays = [];
for (const [i, s] of segs.entries()) {
  const bars = MODE === 'reel' ? { index: i, count: segs.length } : { index: 0, count: 1 };
  overlays.push(await layer({ type: 'overlay', format: cfg.format, theme: s.theme, ...bars, label: s.label, headline: s.headline, url: cfg.url },
    `overlay-${String(i + 1).padStart(2, '0')}-${s.theme}`));
}
await browser.close();

// 2 · clips
const n = MODE === 'reel' ? segs.length : 1;
const BW = Math.round((W - 2 * BX - (n - 1) * GAP) / n);
const parts = [];
for (const [i, s] of segs.entries()) {
  const D = s.duration, SP = s.speed || 1, X0 = BX + (MODE === 'reel' ? i : 0) * (BW + GAP);
  const clip = resolve(root, s.clip);
  if (!existsSync(clip)) throw new Error('Missing clip: ' + clip);
  const crop = s.crop ? `crop=${s.crop[2]}:${s.crop[3]}:${s.crop[0]}:${s.crop[1]},` : '';
  const f = `${tmp}/seg${i}.mp4`;
  const loop = file => ['-loop', '1', '-framerate', String(FPS), '-i', file];
  ff([
    ...loop(bg[s.theme]),
    '-ss', String(s.start || 0), '-t', String(D * SP), '-i', clip,
    ...loop(mask),
    ...loop(overlays[i]),
    '-f', 'lavfi', '-i', `color=c=${BAR[s.theme].track}:s=${BW}x${BH}:r=${FPS}:d=${D}`,
    '-f', 'lavfi', '-i', `color=c=${BAR[s.theme].fill}:s=${BW}x${BH}:r=${FPS}:d=${D}`,
    '-filter_complex',
    `[1:v]setpts=(PTS-STARTPTS)/${SP},${crop}scale=${SW}:${SH}:force_original_aspect_ratio=increase:flags=lanczos,crop=${SW}:${SH},fps=${FPS},format=rgba,tpad=stop_mode=clone:stop_duration=${D}[v0];` +
    `[2:v]crop=${SW}:${SH}:${SX}:${SY},format=gray[m];[v0][m]alphamerge[v];` +
    `[0:v][v]overlay=${SX}:${SY}[a];[a][3:v]overlay=0:0[b];` +
    `[4:v][5:v]overlay=x='-${BW}+${BW}*min(t/${D}\\,1)':y=0:eval=frame[p];` +
    `[b][p]overlay=${X0}:${BY},format=yuv420p[o]`,
    '-map', '[o]', '-t', String(D), '-r', String(FPS), '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', f,
  ]);
  parts.push({ f, D, theme: s.theme, name: `${String(i + 1).padStart(2, '0')}-${slug(s.label.replace(/^\d+\s*—\s*/, ''))}` });
}
const E = cfg.end.duration || 3;
const endClip = {};
for (const th of ['dark', 'lime']) {
  endClip[th] = `${tmp}/end-${th}.mp4`;
  ff(['-loop', '1', '-framerate', String(FPS), '-i', end[th], '-t', String(E), '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'fast', '-crf', '14', endClip[th]]);
}

// 3 · join with fades
const join = (list, file) => {
  const inputs = list.flatMap(p => ['-i', p.f]);
  let chain = '', last = '[0:v]', t = 0;
  for (let k = 1; k < list.length; k++) {
    t += list[k - 1].D - T;
    const lbl = k === list.length - 1 ? '[o]' : `[x${k}]`;
    chain += `${last}[${k}:v]xfade=transition=fade:duration=${T}:offset=${t.toFixed(3)}${lbl};`;
    last = lbl;
  }
  ff([...inputs, '-filter_complex', chain.replace(/;$/, ''), '-map', '[o]', '-r', String(FPS),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '20', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
  console.log('→', file);
};
if (MODE === 'reel') {
  join([...parts, { f: endClip[opposite(parts.at(-1).theme)], D: E }], resolve(outDir, cfg.output || 'suplex-reel.mp4'));
} else {
  for (const p of parts) join([p, { f: endClip[opposite(p.theme)], D: E }], resolve(outDir, `${p.name}.mp4`));
}
console.log('layers →', layersDir);
