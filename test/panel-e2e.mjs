// Side-panel end-to-end test. Launches Zen headless with a throwaway profile and a
// temporary copy of the extension that carries a small test hook, opens the real
// panel page in a tab next to a fixture page, and drives the panel's DOM while a real
// local `claude` (Haiku) does the work. Uses your Claude Code login and costs a few
// cents. Requires `npm run install-host`.
//   node test/panel-e2e.mjs [--headed]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webExt from "web-ext";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const headed = process.argv.includes("--headed");

// Isolated bridge + chat workspace, but the installed host/runtime (outside ~/Documents).
const zcHome = fs.mkdtempSync(path.join("/tmp", "zcp-"));
process.env.CCFOX_HOME = zcHome;
const realCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".ccfox", "config.json"), "utf8"));
fs.writeFileSync(path.join(zcHome, "config.json"), JSON.stringify(realCfg));

// Test copy of the extension: adds a hook that lets the test evaluate code in the
// panel page (needs 'unsafe-eval', which the shipped extension doesn't have).
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcext-"));
fs.cpSync(path.join(ROOT, "extension"), extDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
manifest.background.scripts.push("test-hook-bg.js");
manifest.content_security_policy = "script-src 'self' 'unsafe-eval'; object-src 'self'";
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(
  path.join(extDir, "test-hook-bg.js"),
  `TOOLS.__panel_eval = async ({ code }) => ({ text: JSON.stringify(await browser.runtime.sendMessage({ zcTest: code })) });
TOOLS.__shot = async ({ tabId }) => { const t = tabId ? { id: tabId } : (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0]; return { text: await browser.tabs.captureTab(t.id, { format: "png", scale: 1 }) }; };
TOOLS.__hl = async () => ({ text: JSON.stringify(Highlight.debug()) });
TOOLS.__open_panel = async () => { await browser.tabs.create({ url: browser.runtime.getURL("sidebar/panel.html") }); return { text: "ok" }; };\n`,
);
fs.writeFileSync(
  path.join(extDir, "sidebar", "test-hook-panel.js"),
  `browser.runtime.onMessage.addListener((m) => {
    if (!m || !m.zcTest) return undefined;
    return (async () => { try { return { v: await new Function("return (async () => (" + m.zcTest + "))()")() }; } catch (e) { return { e: String(e) }; } })();
  });\n`,
);
const panelHtml = path.join(extDir, "sidebar", "panel.html");
fs.writeFileSync(panelHtml, fs.readFileSync(panelHtml, "utf8").replace("</body>", '<script src="test-hook-panel.js"></script>\n</body>'));

const fixture = fs.readFileSync(path.join(ROOT, "test", "fixture.html"));
const httpServer = http.createServer((req, res) => {
  res.writeHead(req.url.startsWith("/fixture") ? 200 : 404, { "content-type": "text/html" });
  res.end(req.url.startsWith("/fixture") ? fixture : "nope");
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${httpServer.address().port}`;

console.log("launching Zen…");
const runner = await webExt.cmd.run(
  {
    sourceDir: extDir,
    firefox: "/Applications/Zen.app/Contents/MacOS/zen",
    noReload: true,
    noInput: true,
    args: headed ? [] : ["-headless"],
  },
  { shouldExitProgram: false },
);

// ------------------------------------------------------------------ bridge client
let sock;
let nextId = 1;
const waiting = new Map();
async function bridgeConnect() {
  const p = path.join(zcHome, "bridge.sock");
  for (let i = 0; i < 100 && !fs.existsSync(p); i++) await new Promise((r) => setTimeout(r, 200));
  sock = net.createConnection(p);
  await new Promise((res, rej) => { sock.once("connect", res); sock.once("error", rej); });
  let buf = "";
  sock.setEncoding("utf8");
  sock.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const m = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      const w = waiting.get(m.id);
      if (!w) continue;
      waiting.delete(m.id);
      m.ok ? w.res(m.result) : w.rej(new Error(m.error));
    }
  });
  sock.write(JSON.stringify({ type: "hello" }) + "\n");
}
function tool(name, args = {}) {
  const id = nextId++;
  sock.write(JSON.stringify({ id, tool: name, args }) + "\n");
  return new Promise((res, rej) => waiting.set(id, { res, rej }));
}
async function panelEval(code) {
  const r = JSON.parse((await tool("__panel_eval", { code })).text);
  if (!r) throw new Error("panel didn't answer (is it open?)");
  if (r.e) throw new Error(`panel eval: ${r.e}`);
  return r.v;
}
async function waitFor(code, timeoutMs, what) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await panelEval(code).catch(() => null);
    if (v) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
  const dump = await panelEval("document.getElementById('messages').innerText").catch(() => "");
  throw new Error(`timed out waiting for ${what}\n--- panel ---\n${dump}`);
}

// Optional screenshots of the panel at sidebar width (set ZC_SHOT_DIR).
async function shot(name, tabId) {
  if (!process.env.ZC_SHOT_DIR) return;
  if (!tabId) await panelEval("(document.documentElement.style.cssText = 'width:380px;height:720px;overflow:hidden;border-right:1px solid #ccc', true)");
  const url = (await tool("__shot", { tabId })).text;
  const out = path.join(process.env.ZC_SHOT_DIR, `ccfox-panel-${name}.png`);
  fs.writeFileSync(out, Buffer.from(url.split(",")[1], "base64"));
  console.log(`screenshot: ${out}`);
}

const results = [];
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${e.message.split("\n").slice(0, 16).join("\n       ")}`);
  }
};

try {
  await bridgeConnect();
  const fixtureTab = Number((await tool("tabs_create", { url: `${base}/fixture` })).text.match(/Created tab (\d+)/)[1]);
  await tool("__open_panel");
  await new Promise((r) => setTimeout(r, 1000));
  if (process.env.ZC_DEBUG) console.log((await tool("tabs_context")).text);

  const counter = async () => JSON.parse((await tool("javascript_exec", { tabId: fixtureTab, code: "document.getElementById('counter').textContent" })).text);
  const sendMsg = (text) =>
    panelEval(`(() => { const t = document.getElementById('input'); t.value = ${JSON.stringify(text)}; t.dispatchEvent(new Event('input')); document.getElementById('btnSend').click(); return true; })()`);
  const pendingCard = `document.querySelector('#dock:not([hidden]) .approval') ? document.querySelector('#dock .approval').innerText : null`;
  const permCount = () => panelEval("ui.chat.items.filter((i) => i.role === 'permission').length");
  const idleWith = (n) => `document.getElementById('btnStop').hidden && document.querySelectorAll('.msg-assistant').length >= ${n}`;
  const lastReply = () => panelEval("[...document.querySelectorAll('.msg-assistant')].pop()?.innerText || ''");

  await step("panel connects and targets the fixture tab", async () => {
    await waitFor("ui.conn && ui.conn.connected && document.getElementById('banner').hidden", 15000, "connection");
    await waitFor("document.getElementById('targetTitle').textContent === 'ccfox Fixture'", 5000, "target chip showing the fixture");
    await panelEval("(post({ cmd: 'settings', patch: { model: 'haiku' } }), true)");
  });

  await step("loads your real skills and commands (no tokens)", async () => {
    await waitFor("ui.catalog.commands.length > 5", 40000, "skill catalog");
    await panelEval("(() => { const t = document.getElementById('input'); t.value = '/'; t.focus(); t.dispatchEvent(new Event('input')); return true; })()");
    await waitFor("!document.getElementById('picker').hidden && document.querySelectorAll('#pickerList [role=option]').length > 5", 5000, "picker list");
    await panelEval("(() => { const t = document.getElementById('input'); t.value = ''; t.dispatchEvent(new Event('input')); return true; })()");
  });

  await step("picker groups entries by source: your skills, plugins, agents, built-in", async () => {
    await waitFor("ui.catalog.plugins && ui.catalog.plugins.length > 0", 40000, "plugin list");
    await panelEval("(() => { const t = document.getElementById('input'); t.value = '/'; t.focus(); t.dispatchEvent(new Event('input')); return true; })()");
    const groups = await waitFor(
      "(() => { const g = [...document.querySelectorAll('#pickerList [role=group]')].map((x) => [x.querySelector('.p-group span').textContent, x.querySelectorAll('[role=option]').length]); return g.length > 2 ? g : null; })()",
      5000,
      "picker groups",
    );
    console.log("picker groups:", groups.map(([l, n]) => `${l} (${n})`).join(", "));
    const labels = groups.map((g) => g[0]);
    assert.ok(labels.includes("Agents"), "an Agents group");
    assert.ok(labels.includes("Built-in commands"), "a built-in commands group");
    assert.ok(labels.some((l) => / plugin$/.test(l)), "at least one plugin group");
    assert.ok(await panelEval("document.querySelector('#pickerList [role=group]').getAttribute('aria-labelledby') !== null"), "groups are labelled");
    await shot("picker");
    // "@" after a space lists agents; Enter inserts the mention Claude Code understands.
    await panelEval("(() => { const t = document.getElementById('input'); t.value = 'Ask @Expl'; t.setSelectionRange(9, 9); t.dispatchEvent(new Event('input')); return true; })()");
    await waitFor("!document.getElementById('picker').hidden && document.getElementById('pickerTitle').textContent.length > 0 && document.querySelector('#pickerList [role=option][aria-selected=true]')?.textContent.startsWith('@agent-Explore')", 5000, "agent picker");
    await panelEval("(document.getElementById('input').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })), true)");
    assert.equal(await panelEval("document.getElementById('input').value"), "Ask @agent-Explore ");
    await panelEval("(() => { const t = document.getElementById('input'); t.value = ''; t.dispatchEvent(new Event('input')); return true; })()");
  });

  await step("reads the page without asking", async () => {
    await sendMsg("What is the main heading on this page? Use read_page or find, then answer in a few words.");
    await waitFor(idleWith(1), 150000, "first reply");
    assert.match(await lastReply(), /Fixture Page/);
    assert.equal(await permCount(), 0, "a read should not need approval");
  });

  await step("asks before clicking; Allow once runs it", async () => {
    await sendMsg("Click the button labelled 'Click me' on this page once, then tell me its new label.");
    const card = await waitFor(pendingCard, 150000, "approval card");
    assert.match(card, /Claude wants to/);
    assert.match(card, /Click/);
    assert.doesNotMatch(card, /ref_\d/);
    assert.match(card, /on 127\.0\.0\.1/);
    assert.notEqual(await panelEval("document.activeElement && document.activeElement.className"), "btn primary", "Allow once must never be auto-focused");
    await shot("approval");
    if (process.env.ZC_DEBUG) console.log("highlight state:", (await tool("__hl")).text);
    const overlay = JSON.parse((await tool("javascript_exec", { tabId: fixtureTab, code: "(() => { const h = document.querySelector('ccfox-overlay'); if (!h) return 'none'; const r = h.openOrClosedShadowRoot; return getComputedStyle(r.querySelector('.glow')).opacity + ' | ' + r.querySelector('.label').textContent + ' | stop=' + (getComputedStyle(r.querySelector('button')).display !== 'none'); })()" })).text);
    assert.equal(overlay, "1 | Claude is working in this tab | stop=true", "the tab the panel chat works in should be highlighted with a Stop button");
    await panelEval("(document.querySelector('#dock .btn.primary').click(), true)");
    await waitFor(idleWith(2), 150000, "reply after click");
    assert.equal(await counter(), "Clicked 1");
    assert.ok(await panelEval("ui.chat.items.some((i) => i.role === 'tool' && i.approval === 'once')"), "step should record the approval");
  });

  await step("Deny is respected", async () => {
    await sendMsg("Click that same button one more time.");
    await waitFor(pendingCard, 150000, "approval card");
    await panelEval("([...document.querySelectorAll('#dock .btn')].find((b) => b.textContent === 'Deny').click(), true)");
    await waitFor(idleWith(3), 150000, "reply after deny");
    assert.equal(await counter(), "Clicked 1", "denied click must not run");
  });

  await step("Always allow on site, then no more prompts there", async () => {
    await sendMsg("I changed my mind: please click that button once now. I'll approve it.");
    await waitFor(pendingCard, 150000, "approval card");
    await panelEval("(document.querySelector('#dock .btn.always').click(), true)");
    await waitFor(idleWith(4), 150000, "reply");
    assert.equal(await counter(), "Clicked 2");
    const before = await permCount();
    await sendMsg("Click it once more.");
    await waitFor(idleWith(5), 150000, "reply");
    assert.equal(await counter(), "Clicked 3");
    assert.equal(await permCount(), before, "allowed site should not prompt");
    assert.equal(await panelEval("document.getElementById('trustWrap').dataset.trust"), "site", "trust chip should show the site as always allowed");
  });

  // Files go through the real file input, as if picked in the file dialog.
  const attach = (js) =>
    panelEval(`(async () => { const f = await (${js}); const dt = new DataTransfer(); dt.items.add(f); const i = document.getElementById('fileInput'); i.files = dt.files; i.dispatchEvent(new Event('change')); return true; })()`);
  const replies = () => panelEval("document.querySelectorAll('.msg-assistant').length");

  await step("screenshot of this tab attaches an image chip; × removes it", async () => {
    await panelEval("(document.getElementById('btnAttach').click(), true)");
    await waitFor("!document.getElementById('attachMenu').hidden && document.activeElement && document.activeElement.id === 'miUpload'", 3000, "menu with focus on its first item");
    await panelEval("(document.getElementById('miShot').click(), true)");
    await waitFor("ui.attachments.length === 1 && ui.attachments[0].kind === 'screenshot' && !!ui.attachments[0].thumb", 15000, "screenshot chip");
    assert.match(await panelEval("document.getElementById('attachList').innerText"), /Screenshot of 127\.0\.0\.1/);
    await panelEval("(document.querySelector('#attachList .att-x').click(), true)");
    assert.equal(await panelEval("ui.attachments.length"), 0);
    assert.equal(await panelEval("document.activeElement.id"), "input", "focus returns to the message box");
  });

  await step("an attached image reaches Claude as an image", async () => {
    await attach(`new Promise((res) => { const c = document.createElement('canvas'); c.width = 640; c.height = 260; const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 640, 260); g.fillStyle = '#000'; g.font = 'bold 150px sans-serif'; g.fillText('ZEBRA', 40, 190); c.toBlob((b) => res(new File([b], 'word.png', { type: 'image/png' })), 'image/png'); })`);
    await waitFor("ui.attachments.length === 1 && !!ui.attachments[0].thumb", 5000, "image chip with thumbnail");
    const n = await replies();
    await sendMsg("What word is written in the attached image? Reply with just that word.");
    await waitFor(idleWith(n + 1), 150000, "reply about the image");
    assert.match(await lastReply(), /ZEBRA/i);
    assert.equal(await panelEval("ui.attachments.length"), 0, "the composer is cleared after sending");
    assert.ok(await panelEval("!!document.querySelector('.msg-user .sent-att img')"), "the transcript shows the image");
    const saved = await panelEval("[...ui.chat.items].reverse().find((i) => i.role === 'user').attachments[0].path");
    assert.ok(saved && saved.includes("/workspace/uploads/") && fs.existsSync(saved), `saved under uploads/: ${saved}`);
    await shot("attachments");
  });

  await step("an attached text file is read from its saved path", async () => {
    await attach(`new File(['Meeting notes\\nThe secret code word is PERIWINKLE-42.\\n'], 'notes.txt', { type: 'text/plain' })`);
    const n = await replies();
    const perms = await permCount();
    await sendMsg("What is the secret code word in the attached notes.txt? Reply with just the code word.");
    await waitFor(idleWith(n + 1), 150000, "reply about the file");
    assert.match(await lastReply(), /PERIWINKLE-42/);
    assert.ok(await panelEval("ui.chat.items.some((i) => i.role === 'tool' && i.name === 'Read' && /uploads/.test(JSON.stringify(i.input)))"), "Claude opened the file with Read");
    assert.equal(await permCount(), perms, "reading an upload needs no approval");
    assert.match(await panelEval("document.querySelector('.msg-user:last-of-type .sent-att')?.innerText || [...document.querySelectorAll('.sent-att')].pop().innerText"), /notes\.txt/);
  });

  await step("history lists the chat; settings show the allowed site", async () => {
    await panelEval("(document.getElementById('btnHistory').click(), true)");
    await waitFor("document.querySelectorAll('#historyList .open').length >= 1", 5000, "history entry");
    await panelEval("(document.getElementById('btnSettings').click(), true)");
    await waitFor("document.getElementById('siteList').innerText.includes('127.0.0.1')", 5000, "allowed site");
    assert.match(await panelEval("document.getElementById('facts').innerText"), /Skills/);
    assert.ok(await panelEval("document.querySelectorAll('#pluginList .plugin-name').length > 0"), "settings list your plugins");
    await panelEval("(document.querySelector('#settingsSheet [data-close]').click(), true)");
    await shot("transcript");
  });

  await step("reopening the chat from history restores the transcript", async () => {
    await panelEval("(document.getElementById('btnNew').click(), true)");
    await waitFor("document.querySelectorAll('.msg-assistant').length === 0", 5000, "new chat");
    await panelEval("(document.getElementById('btnHistory').click(), document.querySelector('#historyList .open').click(), true)");
    await waitFor("document.querySelectorAll('.msg-assistant').length >= 5", 5000, "restored transcript");
  });
} catch (e) {
  failures++;
  results.push(`FAIL setup: ${e.stack || e}`);
} finally {
  console.log("\n" + results.join("\n"));
  if (failures) {
    try { console.log("\n--- host.log tail ---\n" + fs.readFileSync(path.join(zcHome, "host.log"), "utf8").split("\n").slice(-15).join("\n")); } catch {}
  }
  try { sock?.end(); } catch {}
  try { await runner.exit(); } catch {}
  httpServer.close();
  fs.rmSync(zcHome, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
