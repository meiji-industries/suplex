const feed = process.env.SUPLEX_DESKTOP_UPDATE_URL;
if (feed && (!URL.canParse(feed) || new URL(feed).protocol !== "https:")) throw new Error("SUPLEX_DESKTOP_UPDATE_URL must be a valid HTTPS URL");

// Notarize only when Apple credentials are present (pnpm dist:signed loads them from 1Password).
// Without them electron-builder still signs with the Developer ID it finds in the login keychain, or ad-hoc if none.
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

module.exports = {
  appId: "dev.suplex.desktop",
  productName: "Suplex",
  directories: { output: "release" },
  files: ["dist/src/**"],
  extraResources: [{ from: "runtime", to: "runtime" }],
  publish: feed ? [{ provider: "generic", url: feed, useMultipleRangeRequest: false }] : null,
  dmg: {
    sign: true,
    background: "build/background.png",
    window: { width: 540, height: 380 },
    contents: [
      { x: 130, y: 220, type: "file" },
      { x: 410, y: 220, type: "link", path: "/Applications" },
    ],
  },
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }],
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize,
    category: "public.app-category.developer-tools",
  },
};
