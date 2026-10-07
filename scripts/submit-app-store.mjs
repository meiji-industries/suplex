// Submits an uploaded iOS build for App Review: waits until Apple has processed the build, points the
// editable App Store version at it, and submits that version. The first submission also needs the
// product page, App Privacy, and App Review details, which are set once in App Store Connect.
// Usage: node scripts/submit-app-store.mjs <version>; SUPLEX_APP_STORE_WHATS_NEW sets the update notes.
import { api } from "./app-store-connect.mjs";

const version = process.argv[2];
const whatsNew = process.env.SUPLEX_APP_STORE_WHATS_NEW || "Fixes and improvements.";
const editable = ["PREPARE_FOR_SUBMISSION", "DEVELOPER_REJECTED", "REJECTED", "METADATA_REJECTED", "INVALID_BINARY"];

const { data: [app] } = await api("v1/apps?filter[bundleId]=sh.suplex.mobile");
if (!app) throw new Error("App Store Connect has no app for sh.suplex.mobile.");

// Apple takes a few minutes, sometimes much longer, to process an upload.
let build;
for (let attempt = 0; ; attempt++) {
  ({ data: [build] } = await api(`v1/builds?filter[app]=${app.id}&filter[version]=${version}&filter[preReleaseVersion.platform]=IOS`));
  const state = build?.attributes.processingState;
  if (state === "VALID") break;
  if (state === "FAILED" || state === "INVALID") throw new Error(`Apple could not process build ${version} (${state}).`);
  if (attempt === 120) throw new Error(`Build ${version} is not processed after an hour. Run this script again later.`);
  if (attempt % 10 === 0) console.log(`Waiting for Apple to process build ${version}${state ? ` (${state})` : ""}`);
  await new Promise((resolve) => setTimeout(resolve, 30_000));
}

const { data: versions } = await api(`v1/apps/${app.id}/appStoreVersions?filter[platform]=IOS&limit=200`);
let appStoreVersion = versions.find((v) => editable.includes(v.attributes.appStoreState));
if (appStoreVersion && appStoreVersion.attributes.versionString !== version) {
  await api(`v1/appStoreVersions/${appStoreVersion.id}`, { method: "PATCH", body: { data: { type: "appStoreVersions", id: appStoreVersion.id, attributes: { versionString: version } } } });
} else if (!appStoreVersion) {
  ({ data: appStoreVersion } = await api("v1/appStoreVersions", {
    method: "POST",
    body: { data: { type: "appStoreVersions", attributes: { platform: "IOS", versionString: version }, relationships: { app: { data: { type: "apps", id: app.id } } } } },
  }));
}
await api(`v1/appStoreVersions/${appStoreVersion.id}/relationships/build`, { method: "PATCH", body: { data: { type: "builds", id: build.id } } });

// The first version has no update notes; every later version must have them.
if (versions.some((v) => v.id !== appStoreVersion.id)) {
  const { data: localizations } = await api(`v1/appStoreVersions/${appStoreVersion.id}/appStoreVersionLocalizations`);
  for (const localization of localizations.filter((l) => !l.attributes.whatsNew)) {
    await api(`v1/appStoreVersionLocalizations/${localization.id}`, { method: "PATCH", body: { data: { type: "appStoreVersionLocalizations", id: localization.id, attributes: { whatsNew } } } });
  }
}

// Reuse a draft submission from an earlier failed run; Apple allows one per platform.
const { data: drafts } = await api(`v1/reviewSubmissions?filter[app]=${app.id}&filter[platform]=IOS&filter[state]=READY_FOR_REVIEW`);
let submission = drafts[0];
if (!submission) {
  ({ data: submission } = await api("v1/reviewSubmissions", {
    method: "POST",
    body: { data: { type: "reviewSubmissions", attributes: { platform: "IOS" }, relationships: { app: { data: { type: "apps", id: app.id } } } } },
  }));
}
const { data: items } = await api(`v1/reviewSubmissions/${submission.id}/items?include=appStoreVersion`);
if (!items.some((item) => item.relationships?.appStoreVersion?.data?.id === appStoreVersion.id)) {
  await api("v1/reviewSubmissionItems", {
    method: "POST",
    body: { data: { type: "reviewSubmissionItems", relationships: { reviewSubmission: { data: { type: "reviewSubmissions", id: submission.id } }, appStoreVersion: { data: { type: "appStoreVersions", id: appStoreVersion.id } } } } },
  });
}
await api(`v1/reviewSubmissions/${submission.id}`, { method: "PATCH", body: { data: { type: "reviewSubmissions", id: submission.id, attributes: { submitted: true } } } });
console.log(`Submitted Suplex ${version} for App Review.`);
