# task-diff-native parity fixture

At TypeScript source revision `6bb0a43f`, `readTaskDiff` resolved the published base through `git merge-base <published> HEAD`, read `git diff --no-ext-diff --no-textconv --no-color <merge-base> --`, and serialized `{available,patch,truncated}`. `readTaskDiffSummary` returned the raw bytes in `summary.json` for the three-file case. The Rust test derives the exact patch from the same authoritative Git tree and compares every response byte after redaction; dynamic commit IDs make a static patch fixture unsuitable.

SHA-256:

- `summary.json`: `196139e4731fa90d91f70ab532766f6410b5bf8e81e478aa1006520cf5dbf705`
