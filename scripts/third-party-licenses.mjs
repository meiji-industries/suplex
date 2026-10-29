#!/usr/bin/env node
// Writes the license notices of every third-party package that Suplex builds ship:
// the Rust crates that the workspace links (no dev or build dependencies) and the
// production npm dependencies of the web client. Pass one or more output paths.
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const root = resolve(dirname(new URL(import.meta.url).pathname), "..");
const outputs = process.argv.slice(2);
if (outputs.length === 0) {
  console.error("usage: node scripts/third-party-licenses.mjs <output>...");
  process.exit(1);
}

const env = { ...process.env };
delete env.RUSTUP_TOOLCHAIN;
const run = (command, args) => execFileSync(command, args, { cwd: root, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
const noticeFile = /^(licen[cs]e|copying|notice|copyright)([-._].*)?$/i;
const noticeTexts = directory => readdirSync(directory, { withFileTypes: true })
  .filter(entry => entry.isFile() && noticeFile.test(entry.name))
  .sort((a, b) => a.name.localeCompare(b.name))
  .map(entry => readFileSync(join(directory, entry.name), "utf8").trim());

const packages = [];

const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--locked"]));
const byId = new Map(metadata.packages.map(item => [item.id, item]));
const nodes = new Map(metadata.resolve.nodes.map(node => [node.id, node]));
const workspace = new Set(metadata.workspace_members);
const linked = new Set();
const pending = [...workspace];
while (pending.length > 0) {
  const node = nodes.get(pending.pop());
  for (const dep of node?.deps ?? []) {
    if (!dep.dep_kinds.some(kind => kind.kind === null) || linked.has(dep.pkg)) continue;
    linked.add(dep.pkg);
    pending.push(dep.pkg);
  }
}
for (const id of linked) {
  if (workspace.has(id)) continue;
  const item = byId.get(id);
  packages.push({ name: item.name, version: item.version, license: item.license ?? "see license file", texts: noticeTexts(dirname(item.manifest_path)) });
}

const npm = JSON.parse(run("pnpm", ["--filter", "suplex-web", "licenses", "list", "--prod", "--json"]));
for (const [license, items] of Object.entries(npm)) {
  for (const item of items) {
    item.versions.forEach((version, index) => {
      packages.push({ name: item.name, version, license, texts: noticeTexts(item.paths[index] ?? item.paths[0]) });
    });
  }
}

// Group packages by notice text so each text appears once.
const groups = new Map();
for (const item of packages.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
  const texts = item.texts.length > 0 ? item.texts : [`Licensed under ${item.license}. The package includes no license file.`];
  for (const text of texts) groups.set(text, [...groups.get(text) ?? [], `${item.name} ${item.version} (${item.license})`]);
}

const separator = "-".repeat(80);
const body = [
  "Third-party software notices for Suplex",
  "",
  "Suplex is licensed under the Elastic License 2.0. It includes the third-party",
  "software below, which is licensed under the terms that follow each list.",
  "THIRD_PARTY_NOTICES.md in the Suplex source lists copied source and fonts.",
  ...[...groups].flatMap(([text, names]) => ["", separator, "", ...names, "", text]),
  "",
].join("\n");

for (const output of outputs) {
  mkdirSync(dirname(resolve(output)), { recursive: true });
  writeFileSync(resolve(output), body);
}
console.log(`Wrote notices for ${packages.length} packages to ${outputs.join(", ")}`);
