# Feature clips

Short product videos for launches, social posts, and the site. A clip goes through two stages:

1. **Scene → raw clip.** A scene is an HTML page that draws the Suplex app (and any other app in the shot) as a pure function of time, `render(t)`. `scenes/render-scene.mjs` captures every frame with Playwright and encodes a 1920×1080, 30 fps MP4.
2. **Raw clip → branded video.** `kit/render.mjs` frames a raw clip in the brand look: lime and charcoal grounds, progress bar, mono label, headline, and end card. It renders 1080×1350 by default and 1920×1080 with `"format": "16x9"`. [`kit/README.md`](kit/README.md) documents the config.

| Path | Holds |
|---|---|
| `scenes/` | Scenes, `render-scene.mjs`, and `shared/` (Suplex window chrome, sidebar, icons, helpers). |
| `kit/` | The brand kit: layer template, renderer, fonts. |
| `clips/` | Raw 1920×1080 clips that the kit reads. Git ignores videos. |
| `campaigns/<name>/` | One folder per launch: kit configs, post copy, and the thread. Renders go to `out/`, which git ignores. |

## Source clips

Git stores no video. Get the raw clips from the [Suplex shared drive](https://drive.google.com/drive/folders/0AB0-8AlWGAUXUk9PVA) and put them in `clips/`. Upload a clip there once it is final.

| Clip | Shows | Source |
|---|---|---|
| `new-task.mp4` | Writing a task on the board | Recording, no scene |
| `run-to-pr.mp4` | Coordinator plans, Worker builds, draft PR opens | Recording, no scene |
| `delivery.mp4` | Review and repair on PR #14: 6/10, repair, 9/10, merged | Recording, no scene |
| `double-plans.mp4` | Plan A and Plan B combined | Recording, no scene |
| `quick-shell.mp4` | Board, then Ctrl+` quick shell | Recording, no scene |
| `meeting-queue.mp4` | Notes copied into Claude Code, takeaways table, tasks queue on the board | Recording, no scene; `scenes/claude-to-suplex.html` draws the same story |
| `moves.mp4` | Recommend moves, import, start Scale workers, live run | `scenes/moves-runbooks.html` |

Upload new raw clips to the same folder. When you record a new clip, build it as a scene so later sessions can change it.

## Make a scene

1. Copy the closest scene. `claude-to-suplex.html` covers a terminal, an app switch, and the board. `moves-runbooks.html` covers pages, dialogs, and a live run inside Suplex.
2. Draw the real UI. Read the component in `apps/web` for its copy and structure, for example `apps/web/features/moves/start-move-dialog.tsx`. Demo data lives in one world: company Acme, project `checkout-api`, user Dana Reyes.
3. Keep every frame a function of `t`: a timeline object `T`, camera keyframes `[t, x, y, scale]`, cursor keyframes, and `keyed()` from `shared/chrome.js`. Frames come from calling `render(t)`, so timers and CSS animations do not appear.
4. Check stills before a full render: `node scenes/render-scene.mjs scenes/<scene>.html stills 2 8 14`.
5. Render: `node scenes/render-scene.mjs scenes/<scene>.html video clips/<clip>.mp4`, then review a contact sheet: `ffmpeg -i clips/<clip>.mp4 -vf "fps=1,scale=480:-1,tile=6x5" -frames:v 1 sheet.png`.

Gotchas:

- Terminals use Menlo, a macOS system font; it has the box-drawing glyphs Claude Code tables need. Set table rows to `line-height: 17px` so the borders join.
- The app-switcher icon is local: `sips -s format png -Z 256 /Applications/Ghostty.app/Contents/Resources/Ghostty.icns --out scenes/shared/local/ghostty-icon.png`.
- This ffmpeg build has no `drawtext`. Draw text as an HTML layer and overlay the PNG.
- Each scene loads `shared/suplex.css` and `shared/chrome.js` and calls `Suplex.mount()` first. Mark the sidebar with `<div data-slot="side" data-nav="Board"></div>`.

## Brand a clip

Add a segment to a campaign config, then run `node kit/render.mjs campaigns/<name>/<config>.json`. Each campaign keeps a `"separate"` config (one video per clip) and a `"reel"` config (all clips in one video), in both formats.

Copy rules for headlines: short declarative fragments that end in a period, sentence case, no exclamation marks, emoji, or hype words. Only the mono labels are uppercase.

## Post on X

What the 2026-10 launch settled (`campaigns/2026-10-launch/thread.md`):

- Post the 4:5 videos. X shows video uncropped up to 3:4 in the feed, so 4:5 fills more of a phone than 16:9. Use 16:9 on the site, LinkedIn, and YouTube.
- Put the website link only in the last reply; a link in the first post cuts its reach. Tag the brand account in the hook.
- Keep replies to 280 characters so they show in full. A Premium hook can run longer; put the turn of the story near the 280-character fold.
- Check every product claim against [`docs/product.md`](../../product.md) and the code. A merged PR is not a deploy. Moves have no scheduling. The 9/10 loop belongs to Review and repair, not every workflow.
