# CI performance

Historical measurements of the September 2026 TypeScript-backed workflow. The
current native Rust CI gate and test counts must be read from `.github/workflows/ci.yml`.

Measured on Blacksmith Ubuntu 24.04 on 2026-09-07. At the time, the workflow kept the `Test suite` check and ran lint, TypeScript, the production build, unit/integration tests, and browser tests.

The default is 8 vCPUs with eight Vitest workers. Manual workflow dispatch accepts a runner and worker count for future comparisons. A smaller runner remains a lower-compute option; 16 vCPUs gave little additional browser-test improvement.

## Initial comparisons

Durations are GitHub job `completedAt - startedAt`, including setup and cleanup but excluding queue time. All successful initial comparisons below use the same application and test sources. The corrected baseline is commit `d8e47041`, with the original workflow and both fixture fixes. Cold/warm refers to the browser cache; pnpm had an existing cache hit throughout.

| Configuration | Job duration | Unit/integration step | Browser step | Run |
| --- | ---: | ---: | ---: | --- |
| Original workflow, 4 vCPUs | 167s | 24.36s reported by Vitest | 74.85s reported by Vitest | [Baseline](https://github.com/meiji-industries/suplex/actions/runs/34166261817) |
| Sticky disk, cold, 4 vCPUs / default workers | 159s | 23s | 75s | [4 vCPUs](https://github.com/meiji-industries/suplex/actions/runs/34166264525) |
| Sticky disk, cold, 8 vCPUs / default workers | 112s | 12s | 40s | [8 vCPUs](https://github.com/meiji-industries/suplex/actions/runs/34166265554) |
| Sticky disk, cold, 16 vCPUs / default workers | 96s | 7s | 36s | [16 vCPUs](https://github.com/meiji-industries/suplex/actions/runs/34166266691) |
| Actions cache, cold, 8 vCPUs / default workers | 110s | 12s | 41s | [Cold Actions cache](https://github.com/meiji-industries/suplex/actions/runs/34166267728) |
| Sticky disk, warm, 8 vCPUs / default workers | 104s | 12s | 42s | [Warm sticky disk](https://github.com/meiji-industries/suplex/actions/runs/34166401366) |
| Actions cache, warm, 8 vCPUs / default workers | 104s | 12s | 41s | [Warm Actions cache](https://github.com/meiji-industries/suplex/actions/runs/34166402715) |
| Actions cache, warm, concurrent lint/build, 8 vCPUs / 8 workers | 94s | 10s | 39s | [8-worker candidate](https://github.com/meiji-industries/suplex/actions/runs/34166423976) |
| Actions cache, warm, concurrent lint/build, 4 vCPUs / 6 workers | 112s | 17s | 48s | [Lower-compute candidate](https://github.com/meiji-industries/suplex/actions/runs/34166425964) |
| Final workflow, version-keyed cache cold, 8 vCPUs / 8 workers | 102s | 11s | 39s | [Final cold cache](https://github.com/meiji-industries/suplex/actions/runs/34166527638) |

The 94-second candidate is 44% faster than the 167-second baseline and uses 752 versus 668 vCPU-seconds, about 13% more compute. The 4-vCPU/six-worker candidate takes 112 seconds and uses 448 vCPU-seconds, about 33% less compute. These are measured tradeoffs, not billing estimates.

The initial attempts exposed two existing test failures, which were corrected before collecting the successful baseline. `worker-environment.test.ts` now runs in the integration project because its real Git fixture needs that project's isolated environment. The recent-tasks browser mock now includes the archive contract's required `dirtyFilePaths`. Neither fix changes production code, removes an assertion, raises a timeout, or adds a retry. The initial successful runs execute 544 unit/integration tests and 60 browser tests, with the same one pre-existing unit/integration skip. Both fixes subsequently arrived on `main` in PR #149; the final branch uses those upstream fixes and has no test-source changes relative to `main`.

## Verification after updating from main

PR #149 merged while these comparisons were running. The final branch includes that change, so its larger suite is compared separately against the successful `main` run at `1e1c2cd0`. This suite contains 586 passing unit/integration tests, one existing skip, and 66 passing browser tests. Do not compare its phase durations directly with the smaller initial suite.

| Configuration | Job duration | Run |
| --- | ---: | --- |
| Updated main, original workflow, 4 vCPUs | 189s | [Updated baseline](https://github.com/meiji-industries/suplex/actions/runs/34166333307) |
| Final workflow, warm, 8 vCPUs / 8 workers | 119s | [Updated suite, warm run 1](https://github.com/meiji-industries/suplex/actions/runs/34166664199) |
| Final workflow, warm, 8 vCPUs / 8 workers | 118s | [Updated suite, warm run 2](https://github.com/meiji-industries/suplex/actions/runs/34166817539) |
| Final workflow, warm, 4 vCPUs / 6 workers | 142s | [Updated suite, lower compute](https://github.com/meiji-industries/suplex/actions/runs/34166818536) |

The two final 8-vCPU runs average 118.5 seconds, 37% below the updated 189-second baseline. Their average compute proxy is 948 vCPU-seconds versus 756, about 25% higher. Both restored the version-keyed browser cache in one second, downloaded no browser binaries, and passed all 652 tests with the same existing skip. The final workflow prioritizes feedback time. The smaller-runner alternative takes 142 seconds and uses 568 vCPU-seconds, about 25% less compute than the original baseline.

Validation also includes actionlint 1.7.12, local typechecking and focused fixture tests, and shell fault injection confirming that either a failed lint or failed build fails the combined step.

## Blacksmith features assessed

- **Colocated Actions cache:** already active for `actions/setup-node@v6`. Kept the maintained upstream action; Blacksmith's old language-specific forks are archived. Browser caching now uses the same backend. [Blacksmith cache documentation](https://docs.blacksmith.sh/blacksmith-caching/dependencies-actions).
- **Browser cache:** keyed by Ubuntu version, architecture and installed Playwright version. Unrelated lockfile updates do not invalidate it. Save follows successful browser installation, so a later failed test does not discard a useful cache. Linux system dependencies are still installed on each fresh runner. Both full Chromium and the headless shell remain available because the tests use both launch modes.
- **Sticky disks:** tested cold and warm. Both cache implementations produced 104-second warm jobs before the final concurrency change. Standard caching avoids extra sticky-disk storage and uses the organization's already-enabled Actions cache branch protection. Sticky-disk branch protection was off when inspected; no organization settings were changed. [Sticky disk documentation](https://docs.blacksmith.sh/blacksmith-caching/dependencies-sticky-disks).
- **Metrics and Test Analytics:** inspected the dashboard. The linked original job peaked at 2,131 MB RAM with CPU P90 at 77%. The successful 94-second candidate peaked at 3,995 MB with CPU P90 at 89%. JUnit reports are emitted separately for unit/integration and browser tests under `test-results/`; Blacksmith automatically collects them. Log ingestion and test failure PR comments were already enabled. [Metrics](https://docs.blacksmith.sh/blacksmith-observability/metrics), [JUnit ingestion](https://docs.blacksmith.sh/blacksmith-observability/test-analytics).
- **Git mirrors:** checkout takes 1 to 2 seconds. Adding a full mirror and sticky disk does not address a material bottleneck. [Checkout caching](https://docs.blacksmith.sh/blacksmith-caching/git-checkout-caching).
- **Docker layers/container snapshots and Bazel caching:** the workflow uses neither Docker nor Bazel. Adding a container-image build/publish lifecycle to save a short dependency-install step would add ongoing maintenance.
- **SSH, Testboxes and code-smith tuning:** optional interactive debugging tools, not prerequisites for this gate. Existing GitHub dispatch and Blacksmith metrics supported the measurements. SSH was off; it remains off. No extra credentials, permissions or external agents were added.

The pnpm install takes 2 to 4 seconds, so a second cache for `node_modules` was not added. ESLint uses type-aware and import-cycle rules; a cache invalidated only by each file's own content could miss errors introduced by changes in another file. Lint continues to check all files.

## Repeat the comparison

Dispatch `CI` on the same commit with the runner and worker inputs. Complete one run to populate its browser cache, then compare at least two warm runs. Do not compare failed runs with successful full runs. For the smaller-runner alternative, select `blacksmith-4vcpu-ubuntu-2404` and `6` workers.

```sh
gh workflow run ci.yml --ref <branch> -f runner=blacksmith-8vcpu-ubuntu-2404 -f workers=8
gh run view <run-id> --json headSha,conclusion,jobs
```

Record queue time separately, inspect cache-hit messages and browser downloads in the logs, and compare vCPU-seconds as well as wall time. vCPU-seconds are a compute proxy, not an invoice estimate. Blacksmith's Metrics and Tests tabs show resource usage and individual test history. Keep the full gate and zero retries while tuning.
