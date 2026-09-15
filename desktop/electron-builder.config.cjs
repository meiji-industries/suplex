const feed = process.env.FORGE_DESKTOP_UPDATE_URL;
if (feed && (!URL.canParse(feed) || new URL(feed).protocol !== "https:")) throw new Error("FORGE_DESKTOP_UPDATE_URL must be a valid HTTPS URL");

module.exports = {
  appId: "dev.forge.desktop",
  productName: "Forge",
  directories: { output: "release" },
  files: ["dist/src/**"],
  publish: feed ? [{ provider: "generic", url: feed }] : null,
  mac: {
    target: [{ target: "dmg", arch: ["arm64"] }, { target: "zip", arch: ["arm64"] }],
    hardenedRuntime: false,
    notarize: false,
    category: "public.app-category.developer-tools",
  },
};
