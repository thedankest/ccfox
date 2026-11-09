// Fill in the parts of the AMO listing that `web-ext sign` can't send: screenshots with
// captions (store/screenshots/*.png) and the privacy policy (store/privacy-policy.md).
// Then print what AMO has, so you can check the icon and reviewer notes.
//   npm run amo:listing            # upload whatever is missing
//   npm run amo:listing -- --check # only report
//   --replace-screenshots           # delete AMO's screenshots and upload store/screenshots again
//   --skip-screenshots              # only the privacy policy and icon
// Credentials come from the macOS Keychain (service "ccfox-amo"), as in sign-amo.mjs.
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const API = "https://addons.mozilla.org/api/v5";
const ADDON = "ccfox@thedankest";
const checkOnly = process.argv.includes("--check");
const skipShots = process.argv.includes("--skip-screenshots");
const replaceShots = process.argv.includes("--replace-screenshots");
const SHOTS = [
  ["01-side-panel.png", "Claude Code, right next to the page: it reads the page, and asks before it clicks, types or runs a command."],
  ["02-tab-group.png", "Tabs Claude opens go into an orange \"Claude\" tab group; the tab it's working in glows."],
  ["03-context.png", "Attach files, a screenshot or other tabs, and pick skills, plugins and agents with /."],
  ["04-workflow-recording.png", "Record a task once and save it as a Claude Code skill."],
  ["05-mcp.png", "Add ccfox as an MCP server and Claude Code can use your browser."],
];

const fail = (msg) => {
  console.error(`amo:listing: ${msg}`);
  process.exit(1);
};

// Same cleaning as sign-amo.mjs: terminals can leak focus/paste codes into `security -w` prompts.
const clean = (v) => v.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, "").replace(/[\x00-\x1f\x7f\s"']/g, "");
function keychain(account) {
  try {
    return clean(execFileSync("security", ["find-generic-password", "-s", "ccfox-amo", "-a", account, "-w"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
  } catch {
    fail(`No Keychain item ccfox-amo/${account}.`);
  }
}
const issuer = keychain("jwt-issuer");
const secret = keychain("jwt-secret");
if (!/^user:\d+:\d+$/.test(issuer) || !/^[0-9a-f]{64}$/.test(secret)) fail("The Keychain credentials don't look like an AMO JWT issuer and secret.");

const b64 = (o) => Buffer.from(typeof o === "string" ? o : JSON.stringify(o)).toString("base64url");
function token() {
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ iss: issuer, jti: crypto.randomUUID(), iat: now, exp: now + 60 })}`;
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}
async function api(method, url, body) {
  const headers = { Authorization: `JWT ${token()}` };
  if (body && !(body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(body);
  }
  let res = await fetch(`${API}${url}`, { method, headers, body });
  for (let tries = 0; res.status === 429 && tries < 5; tries++) {
    const wait = Number((await res.text()).match(/(\d+) seconds?/)?.[1] ?? 60) + 2;
    if (wait > 15 * 60) fail(`AMO's rate limit asks for a ${Math.round(wait / 3600)}h wait (likely a daily quota). Run this again later; it picks up where it stopped.`);
    console.log(`  AMO asked to slow down; waiting ${wait}s…`);
    await new Promise((r) => setTimeout(r, wait * 1000));
    headers.Authorization = `JWT ${token()}`;
    res = await fetch(`${API}${url}`, { method, headers, body });
  }
  const text = await res.text();
  if (!res.ok) fail(`${method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

const id = encodeURIComponent(ADDON);
let addon = await api("GET", `/addons/addon/${id}/`);
console.log(`${addon.name?.["en-US"] ?? addon.slug} (${addon.slug}), status ${addon.status}`);

// Screenshots
let have = [...(addon.previews ?? [])].sort((a, b) => a.position - b.position);
if (replaceShots && !checkOnly && !skipShots) {
  for (const p of have) await api("DELETE", `/addons/addon/${id}/previews/${p.id}/`);
  console.log(`screenshots: removed ${have.length} old ones`);
  have = [];
}
const uncaptioned = have.filter((p) => !p.caption?.["en-US"]).length;
if (skipShots) console.log("screenshots: skipped");
else if (have.length >= SHOTS.length && !uncaptioned) console.log(`screenshots: ${have.length} already on AMO`);
else if (checkOnly) console.log(`screenshots: ${have.length} of ${SHOTS.length}, ${uncaptioned} without a caption`);
else {
  for (const [i, [file, caption]] of SHOTS.entries()) {
    if (i < have.length) {
      if (!have[i].caption?.["en-US"]) {
        await api("PATCH", `/addons/addon/${id}/previews/${have[i].id}/`, { caption: { "en-US": caption } });
        console.log(`screenshot ${i + 1}: caption added`);
      }
      continue;
    }
    const form = new FormData();
    form.append("image", new Blob([fs.readFileSync(path.join(ROOT, "store", "screenshots", file))], { type: "image/png" }), file);
    form.append("position", String(i));
    const p = await api("POST", `/addons/addon/${id}/previews/`, form);
    await api("PATCH", `/addons/addon/${id}/previews/${p.id}/`, { caption: { "en-US": caption } });
    console.log(`screenshot ${i + 1}: uploaded ${file}`);
  }
}

// Privacy policy
const eula = await api("GET", `/addons/addon/${id}/eula_policy/`);
const policy = fs.readFileSync(path.join(ROOT, "store", "privacy-policy.md"), "utf8").trim();
if (eula.privacy_policy?.["en-US"]?.trim() === policy) console.log("privacy policy: already set");
else if (checkOnly) console.log(`privacy policy: ${eula.privacy_policy ? "set, but differs from store/privacy-policy.md" : "missing"}`);
else {
  await api("PATCH", `/addons/addon/${id}/eula_policy/`, { privacy_policy: { "en-US": policy } });
  console.log("privacy policy: set");
}

// Icon: AMO shows a default until one is uploaded to the listing.
if (!/default-\d+\.png/.test(addon.icon_url ?? "")) console.log("icon: already set");
else if (checkOnly) console.log("icon: AMO default");
else {
  const form = new FormData();
  form.append("icon", new Blob([fs.readFileSync(path.join(ROOT, "extension", "icons", "icon-128.png"))], { type: "image/png" }), "icon-128.png");
  await api("PATCH", `/addons/addon/${id}/`, form);
  console.log("icon: uploaded the pixel fox");
}

// Report
addon = await api("GET", `/addons/addon/${id}/`);
console.log(`icon: ${addon.icon_url}`);
console.log(`screenshots on AMO: ${(addon.previews ?? []).length}`);
const versions = await api("GET", `/addons/addon/${id}/versions/?filter=all_with_unlisted`);
for (const v of versions.results ?? []) {
  const full = await api("GET", `/addons/addon/${id}/versions/${v.id}/`);
  const notes = full.approval_notes;
  console.log(`version ${v.version} (${v.channel}): file ${v.file?.status ?? "?"}, reviewer notes ${notes == null ? "not returned by the API" : `${notes.length} chars`}`);
}
