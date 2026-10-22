---
name: feature-clips
description: Make Suplex feature clips — animated product demo videos, brand-kit renders, and launch-post copy. Use when asked for a feature video, demo clip, social or launch post, or to re-render the brand kit.
---

Read [`docs/media/feature-clips/README.md`](../../../docs/media/feature-clips/README.md) first. It holds the workflow, the source-clip table, and the posting rules.

1. **Pin the claim.** Write what the clip shows in one sentence and check it against `docs/product.md` and the code before you draw anything. Done when every on-screen claim has a source.
2. **Scene.** Build or edit a scene in `scenes/` from the closest existing one, matching the real component in `apps/web`. Done when stills at the key beats look like the app.
3. **Raw clip.** Render it to `clips/`. Done when you have reviewed a 1 fps contact sheet of the whole clip.
4. **Brand.** Add the segment to a campaign config and run `kit/render.mjs` for 4:5 and 16:9. Done when a contact sheet of each output shows the label, headline, and end card intact.
5. **Copy.** Draft post text in the campaign's `posts/`, one file per post, each reply within 280 characters. Show the user drafts before rendering captions into video.

Ask the user one question at a time when a choice is theirs: clip content, headline wording, which format to post.
