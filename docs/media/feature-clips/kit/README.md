# Suplex feature clips

Turns the UI clips into 1080×1350 portrait videos in the Suplex brand look. Each clip becomes its own video, and each one ends on the end card.

## Look

- **Grounds:** Clips alternate between charcoal (#111, clips 1, 3, 5) and lime (#d5ff40, clips 2, 4, 6), both with fine grain. Each video's end card uses the opposite ground. No blurred gradients.
- **Frame:**
  - a progress bar across the top that fills while the clip plays;
  - a mono label (`01 — NEW TASK`) on the left and a thin plus mark on the right;
  - the clip inset at 56, 200 (968×628) with 14 px rounded corners and a soft drop shadow;
  - the headline below the clip;
  - the wordmark and GETSUPLEX.AI at the bottom.
- **Type:** Inter Medium for headlines and Geist Mono uppercase for labels. Both fonts are in `fonts/`.
- **Motion:** a 0.4 s fade into the end card, nothing else.

## Run it

You need Node 18+, ffmpeg on your PATH, and Playwright with Chromium.

```bash
npm i playwright && npx playwright install chromium
node render.mjs ../campaigns/2026-10-launch/feature-clips-4x5.json
```

The command writes these files to `out/`:

- `01-new-task.mp4`, `02-pr-review.mp4`, …, one video per clip;
- `out/layers/`, holding every PNG layer (backgrounds, overlays, clip mask, both end cards), for use in a video editor instead of this script.

## Edit `reel.json`

| key | what it does |
|---|---|
| `format` | Leave it off for 1080×1350 portrait. `"16x9"` makes 1920×1080 videos: the clip on the right (1152×747 at 712, 180) and the headline in the left column. `reel-16x9.json` and `reel-thread-16x9.json` use it. |
| `mode` | `"separate"` (default) makes one video per clip. `"reel"` makes one video with every clip in a row, a progress bar per clip, and one end card. |
| `label` | Mono label top-left: `NN — Name`. It is uppercased for you. |
| `headline` | Up to 3 lines. It shrinks if it runs long. Use `\n` to force a line break. |
| `theme` | Optional `"dark"` or `"lime"`. If you leave it out, clips alternate dark, lime, dark… |
| `clip` | Path to the UI clip (1920×1080 expected). |
| `start` | Where to start in the source clip, in seconds. |
| `duration` | Length of this clip in the output video, in seconds. |
| `speed` | Playback speed. The video uses `duration × speed` seconds of source. |
| `crop` | `[x, y, w, h]` in source pixels. `[204, 50, 1512, 980]` crops our feature clips to the app window, which drops the blurred wallpaper. Leave it off for clips with more than one window. |

`end` sets the end card's `label`, `headline` and `duration`.

## Copy rules

- Write short declarative fragments that end in a period: `Heavy tasks. Light work.`
- Use sentence case. No exclamation marks, emoji or hype words.
- Only the mono labels are uppercase.

To check a layer without rendering, open `card.html` in a browser with the data in the hash:
`card.html#{"type":"overlay","theme":"lime","label":"02 — PR review","headline":"Tag a PR.","preview":true}`
