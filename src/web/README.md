# suplex-web

The Cloudflare Worker behind [suplex.sh](https://suplex.sh). It serves the install script and redirects `/download` to the latest release. Every other path redirects to the website at [getsuplex.ai](https://getsuplex.ai), which is a Framer site and is edited in Framer.

```sh
npm run dev
```

## Deploying

Cloudflare CI/CD builds this directory (root directory `src/web`) from the suplex repo. A push to `main` that changes `src/web` deploys the Worker, so pushing is the only step.

## Analytics

Each download sends an anonymous `download_started` event to the PostHog project the app reports to. [`docs/telemetry.md`](../../docs/telemetry.md) lists the app's events.
