export default {
	async fetch(request, env, ctx) {
		const url = new URL(request.url);
		if (url.pathname === "/download") {
			const response = await download(url);
			if (response.status === 302) ctx.waitUntil(track(request, env, url));
			return response;
		}
		if (url.pathname === "/install.sh" || url.pathname === "/install.ps1") return env.ASSETS.fetch(request);
		// The website is a Framer site on its own domain.
		return Response.redirect("https://getsuplex.ai/", 302);
	},
};

// Counts downloads in the PostHog project the app reports to (docs/telemetry.md).
// Each event is anonymous: a fresh ID and no person profile. A failed send never affects the download.
async function track(request, env, url) {
	if (!env.POSTHOG_KEY || request.headers.get("DNT") === "1") return;
	const event = {
		event: "download_started",
		distinct_id: crypto.randomUUID(),
		properties: {
			$lib: "suplex-web",
			$process_person_profile: false,
			$geoip_disable: true,
			platform: url.searchParams.get("platform") ?? "macos-arm64",
			source: /^curl\/|PowerShell\//.test(request.headers.get("user-agent") ?? "") ? "install_script" : "browser",
		},
	};
	await fetch("https://us.i.posthog.com/batch/", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ api_key: env.POSTHOG_KEY, batch: [event] }),
	}).catch(() => {});
}

// Each feed lists its release files in a manifest; the first format is the default download.
const feeds = {
	"macos-arm64": { url: "https://downloads.meiji.industries/stable/mac/arm64/", manifest: "latest-mac.yml", formats: ["dmg", "zip"] },
	"macos-x64": { url: "https://downloads.meiji.industries/stable/mac/x64/", manifest: "latest-mac.yml", formats: ["dmg", "zip"] },
	"linux-arm64": { url: "https://downloads.meiji.industries/stable/linux/arm64/", manifest: "latest-linux.yml", formats: ["tar.gz"] },
	"linux-x64": { url: "https://downloads.meiji.industries/stable/linux/x64/", manifest: "latest-linux.yml", formats: ["tar.gz"] },
	"linux-desktop-arm64": { url: "https://downloads.meiji.industries/stable/linux/arm64/", manifest: "latest-linux-desktop.yml", formats: ["deb", "rpm"] },
	"linux-desktop-x64": { url: "https://downloads.meiji.industries/stable/linux/x64/", manifest: "latest-linux-desktop.yml", formats: ["deb", "rpm"] },
	"windows-arm64": { url: "https://downloads.meiji.industries/stable/windows/arm64/", manifest: "latest-windows.yml", formats: ["exe"] },
	"windows-x64": { url: "https://downloads.meiji.industries/stable/windows/x64/", manifest: "latest-windows.yml", formats: ["exe"] },
};

// Redirects to the file named in the live release manifest, so the link follows each release.
async function download(url) {
	const feed = feeds[url.searchParams.get("platform") ?? "macos-arm64"];
	if (!feed) return new Response("Unknown platform.", { status: 404 });
	const format = url.searchParams.get("format") ?? feed.formats[0];
	if (!feed.formats.includes(format)) return new Response("Unknown format.", { status: 404 });
	const manifest = await fetch(feed.url + feed.manifest, { cf: { cacheTtl: 60 } });
	if (!manifest.ok) return new Response("No release is published.", { status: 502 });
	const file = new RegExp(`url:\\s*(\\S+\\.${format.replace(".", "\\.")})`).exec(await manifest.text())?.[1];
	if (!file) return new Response(`No ${format} in the latest release.`, { status: 502 });
	return Response.redirect(feed.url + file, 302);
}
