#!/usr/bin/env node
// Builds the addons.mozilla.org ("store") variant of the extension, lints it, and
// submits it for signing with `web-ext sign`.
//
//   npm run sign:amo                       listed: submit to AMO for review and listing
//   npm run sign:amo -- --channel=unlisted signed XPI for GitHub releases (not listed)
//   npm run sign:amo -- --dry-run          build + lint + check metadata; no Keychain, no upload
//   npm run sign:amo -- --with-source      also attach a source archive for reviewers
//
// The store variant is extension/ minus the developer-only files (DEV_ONLY below), with
// their manifest entries removed. Nothing else is transformed: every shipped file is the
// human-written source. Mozilla's policies forbid running code that isn't shipped in the
// add-on, so javascript_exec (extension/js-exec.js) stays in the developer build only.
//
// Credentials come from the macOS Keychain (service "ccfox-amo", accounts "jwt-issuer"
// and "jwt-secret") and reach web-ext only through WEB_EXT_API_KEY / WEB_EXT_API_SECRET
// in its environment: never argv, never printed.
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "extension");
const OUT = path.join(ROOT, "dist", "amo");
const STAGE = path.join(OUT, "extension"); // the clean upload directory
const WEB_EXT = path.join(ROOT, "node_modules", "web-ext", "bin", "web-ext.js");
const METADATA = path.join(ROOT, "store", "amo-metadata.json");
const REVIEWER_NOTES = path.join(ROOT, "store", "reviewer-notes.md");
const KEYCHAIN_SERVICE = "ccfox-amo";

// Files only the developer build ships (paths relative to extension/).
const DEV_ONLY = ["js-exec.js"];
// web-ext keeps these in the source dir between runs (resumable uploads); keep them.
const WEB_EXT_STATE = [".web-extension-id", ".amo-upload-uuid"];

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i < 0) return undefined;
  return argv[i].includes("=") ? argv[i].split("=").slice(1).join("=") : argv[i + 1];
};
const dryRun = flag("dry-run");
const withSource = flag("with-source");
const channel = opt("channel") || "listed";
if (!["listed", "unlisted"].includes(channel)) fail(`--channel must be "listed" or "unlisted", not "${channel}".`);

function fail(msg) {
  console.error(`\nsign:amo: ${msg}`);
  process.exit(1);
}
const step = (msg) => console.log(`\n== ${msg}`);

// ------------------------------------------------------------------ 1. versions agree
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const devManifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
if (devManifest.version !== pkg.version) fail(`extension/manifest.json is ${devManifest.version} but package.json is ${pkg.version}.`);
const gecko = devManifest.browser_specific_settings && devManifest.browser_specific_settings.gecko;
if (!gecko || !gecko.id) fail("extension/manifest.json has no browser_specific_settings.gecko.id.");
if (!gecko.data_collection_permissions) fail("extension/manifest.json has no data_collection_permissions.");

// ------------------------------------------------------------------ 2. clean upload directory
step(`Building the store variant of ccfox ${pkg.version} (${gecko.id}) in ${path.relative(ROOT, STAGE)}/`);
const kept = {};
for (const f of WEB_EXT_STATE) {
  const p = path.join(STAGE, f);
  if (fs.existsSync(p)) kept[f] = fs.readFileSync(p);
}
fs.rmSync(STAGE, { recursive: true, force: true });
fs.mkdirSync(STAGE, { recursive: true });

const shipped = [];
(function copyTree(rel) {
  for (const ent of fs.readdirSync(path.join(SRC, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.name.startsWith(".")) continue; // .DS_Store, editor files
    if (DEV_ONLY.includes(r)) continue;
    if (ent.isDirectory()) {
      fs.mkdirSync(path.join(STAGE, r), { recursive: true });
      copyTree(r);
    } else if (ent.isFile() && r !== "manifest.json") {
      fs.copyFileSync(path.join(SRC, r), path.join(STAGE, r));
      shipped.push(r);
    }
  }
})("");

// The manifest minus the developer-only entries.
const manifest = structuredClone(devManifest);
manifest.background.scripts = manifest.background.scripts.filter((s) => !DEV_ONLY.includes(s.replace(/^\//, "")));
fs.writeFileSync(path.join(STAGE, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
shipped.push("manifest.json");
for (const [f, data] of Object.entries(kept)) fs.writeFileSync(path.join(STAGE, f), data);

// Every script the manifest or a page names must exist, and the build must not contain
// dynamic code: no code strings for executeScript, no eval/new Function.
const missing = manifest.background.scripts.filter((s) => !fs.existsSync(path.join(STAGE, s)));
if (missing.length) fail(`manifest.json names missing scripts: ${missing.join(", ")}`);
const DYNAMIC = [
  [/executeScript\(\s*[\w.]+\s*,\s*\{\s*code\s*:/, "tabs.executeScript with a code string"],
  [/\bnew Function\s*\(/, "new Function"],
  [/(^|[^\w.])eval\s*\(/m, "eval"],
  [/\buserScripts\./, "the userScripts API"],
];
for (const f of shipped.filter((f) => f.endsWith(".js"))) {
  const text = fs.readFileSync(path.join(STAGE, f), "utf8");
  for (const [re, what] of DYNAMIC) if (re.test(text)) fail(`${f} contains ${what}; it can't ship to AMO.`);
}
for (const f of shipped.filter((f) => f.endsWith(".html"))) {
  const text = fs.readFileSync(path.join(STAGE, f), "utf8");
  if (/<script[^>]+src=["']?(https?:)?\/\//i.test(text)) fail(`${f} loads a remote script.`);
}
console.log(`${shipped.length} files (left out: ${DEV_ONLY.join(", ")})`);

// ------------------------------------------------------------------ 3. lint
step("web-ext lint");
const lint = spawnSync(process.execPath, [WEB_EXT, "lint", "--source-dir", STAGE, "--output", "json", "--no-config-discovery"], { cwd: ROOT, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
let report;
try {
  report = JSON.parse(lint.stdout.slice(lint.stdout.indexOf("{")));
} catch {
  fail(`web-ext lint didn't produce a report:\n${lint.stdout}\n${lint.stderr}`);
}
for (const kind of ["errors", "warnings", "notices"]) {
  for (const m of report[kind] || []) console.log(`${kind.slice(0, -1).toUpperCase().padEnd(7)} ${m.code}  ${m.file || ""}${m.line ? `:${m.line}` : ""}  ${m.message}`);
}
console.log(`errors ${report.summary.errors}, warnings ${report.summary.warnings}, notices ${report.summary.notices}`);
if (report.summary.errors > 0) fail("web-ext lint found errors.");

// ------------------------------------------------------------------ 4. listing metadata
step("Listing metadata");
const listing = JSON.parse(fs.readFileSync(METADATA, "utf8"));
const en = (field) => (listing[field] && listing[field]["en-US"]) || "";
if (!en("name") || en("name").length > 50) fail("amo-metadata.json: name is required, at most 50 characters.");
if (!en("summary") || en("summary").length > 250) fail("amo-metadata.json: summary is required, at most 250 characters.");
if (/https?:\/\//i.test(en("summary"))) fail("amo-metadata.json: AMO doesn't allow URLs in the summary.");
if (!Array.isArray(listing.categories) || !listing.categories.length) fail("amo-metadata.json: categories are required.");
if (!listing.version || !listing.version.license) fail("amo-metadata.json: version.license is required.");
// Reviewer notes travel as the version's approval notes (visible to Mozilla only).
const approvalNotes = fs.readFileSync(REVIEWER_NOTES, "utf8").trim();
if (approvalNotes.length > 3000) fail(`store/reviewer-notes.md is ${approvalNotes.length} characters; AMO allows 3000.`);
// An unlisted version needs no listing; send only the version fields.
const metadata = channel === "listed" ? structuredClone(listing) : { version: structuredClone(listing.version) };
metadata.version.approval_notes = approvalNotes;
const metadataFile = path.join(OUT, `amo-metadata.${channel}.json`);
fs.writeFileSync(metadataFile, JSON.stringify(metadata, null, 2) + "\n");
console.log(`${path.relative(ROOT, metadataFile)}: name "${en("name")}", summary ${en("summary").length}/250 chars, categories ${listing.categories.join(", ")}, license ${listing.version.license}`);

// ------------------------------------------------------------------ 5. optional source archive
let sourceZip = null;
if (withSource) {
  step("Source archive for reviewers");
  sourceZip = path.join(OUT, `ccfox-${pkg.version}-source.zip`);
  fs.rmSync(sourceZip, { force: true });
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], { cwd: ROOT, encoding: "utf8" })
    .split("\n")
    .filter((f) => f && fs.existsSync(path.join(ROOT, f)) && !f.startsWith("docs/"));
  execFileSync("zip", ["-q", "-X", sourceZip, "-@"], { cwd: ROOT, input: files.join("\n") });
  console.log(`${path.relative(ROOT, sourceZip)} (${files.length} files)`);
}

// ------------------------------------------------------------------ 6. sign
const artifacts = path.join(OUT, channel);
const args = [
  "sign",
  "--source-dir", STAGE,
  "--artifacts-dir", artifacts,
  "--channel", channel,
  "--amo-metadata", metadataFile,
  "--no-config-discovery",
  // A listed version waits for human review; don't block on it. Unlisted versions are
  // signed automatically, so wait for the signed XPI.
  ...(channel === "listed" ? ["--approval-timeout", "0"] : []),
  ...(sourceZip ? ["--upload-source-code", sourceZip] : []),
];
const shown = `WEB_EXT_API_KEY=… WEB_EXT_API_SECRET=… web-ext ${args.map((a) => (a.startsWith(ROOT) ? path.relative(ROOT, a) : a)).join(" ")}`;

if (dryRun) {
  step("Dry run: not reading the Keychain, not uploading");
  console.log(`would run: ${shown}`);
  console.log(`\nThe store build is in ${path.relative(ROOT, STAGE)}/. Submit for real with: npm run sign:amo${channel === "unlisted" ? " -- --channel=unlisted" : ""}`);
  process.exit(0);
}

if (process.platform !== "darwin") fail("Reading credentials needs the macOS Keychain (`security`).");
step(`Reading AMO API credentials from the Keychain (service "${KEYCHAIN_SERVICE}")`);
function keychain(account) {
  try {
    return execFileSync("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).replace(/\n$/, "");
  } catch {
    fail(`No Keychain item for service "${KEYCHAIN_SERVICE}", account "${account}". Add it with:\n  security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${account} -w`);
  }
}
// Terminals that report focus (ESC [ I / ESC [ O) or bracketed paste (ESC [ 200~ ... ESC [ 201~)
// leak those codes into `security ... -w` prompts, so strip control sequences, quotes and spaces.
const clean = (v) => v.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "").replace(/[\x00-\x1f\x7f\s"']/g, "");
const apiKey = clean(keychain("jwt-issuer"));
const apiSecret = clean(keychain("jwt-secret"));
if (!apiKey || !apiSecret) fail("The Keychain items are empty.");
if (!/^user:\d+:\d+$/.test(apiKey)) fail(`jwt-issuer should look like user:12345678:123. Re-save it with:\n  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a jwt-issuer -w`);
if (!/^[0-9a-f]{64}$/.test(apiSecret)) fail(`jwt-secret should be 64 hex characters (got ${apiSecret.length}). Re-save it with:\n  security add-generic-password -U -s ${KEYCHAIN_SERVICE} -a jwt-secret -w`);
console.log("found jwt-issuer and jwt-secret");

step(`web-ext sign (${channel})`);
console.log(shown);
const env = { ...process.env, WEB_EXT_API_KEY: apiKey, WEB_EXT_API_SECRET: apiSecret };
const res = spawnSync(process.execPath, [WEB_EXT, ...args], { cwd: ROOT, env, stdio: "inherit" });
if (res.status !== 0) fail(`web-ext sign exited with ${res.status}.`);
console.log(
  channel === "listed"
    ? "\nSubmitted. The version now waits for review on AMO; finish the listing in the Developer Hub (see store/listing.md)."
    : `\nSigned XPI in ${path.relative(ROOT, artifacts)}/ (attach it to the GitHub release).`,
);
