const feed = process.env.FORGE_DESKTOP_UPDATE_URL;
if (feed && (!URL.canParse(feed) || new URL(feed).protocol !== "https:")) throw new Error("FORGE_DESKTOP_UPDATE_URL must be a valid HTTPS URL");

// Notarize only when Apple credentials are present (pnpm dist:signed loads them from 1Password).
// Without them electron-builder still signs with the Developer ID it finds in the login keychain, or ad-hoc if none.
const notarize = Boolean(process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);

module.exports = {
  appId: "dev.forge.desktop",
  productName: "Forge",
  directories: { output: "release" },
  files: ["dist/src/**"],
  publish: feed ? [{ provider: "generic", url: feed }] : null,
  dmg: { sign: true },
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }],
    hardenedRuntime: true,
    entitlements: "build/entitlements.mac.plist",
    entitlementsInherit: "build/entitlements.mac.plist",
    notarize,
    category: "public.app-category.developer-tools",
  },
};
