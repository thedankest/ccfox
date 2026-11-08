// Workflow recording end-to-end test. Launches Zen headless with a throwaway profile
// and a temporary copy of the extension with the panel test hook (as panel-e2e.mjs),
// and drives the page with real, trusted input through WebDriver BiDi
// (input.performActions): the recorder only listens to event.isTrusted input, which
// the page agent's synthetic events are not. Then it reviews and saves the workflow
// from the real panel UI. Skills go to a throwaway skills folder (CCFOX_SKILLS_DIR and
// skillsDir in the throwaway CCFOX_HOME config), never ~/.claude/skills. Costs no
// tokens: the skill catalog comes from Claude Code's initialize handshake.
// Requires `npm run install-host`.
//   node test/record-e2e.mjs [--headed]
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webExt from "web-ext";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const headed = process.argv.includes("--headed");
const REAL_SKILLS = path.join(os.homedir(), ".claude", "skills");

// Throwaway bridge, workspace and skills folder. The skills folder sits in the chat
// workspace's .claude/skills, so the catalog (run in that workspace) lists what we save.
const zcHome = fs.mkdtempSync(path.join("/tmp", "zcr-"));
const skillsDir = path.join(zcHome, "workspace", ".claude", "skills");
fs.mkdirSync(skillsDir, { recursive: true });
process.env.CCFOX_HOME = zcHome;
process.env.CCFOX_SKILLS_DIR = skillsDir;
const realCfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".ccfox", "config.json"), "utf8"));
fs.writeFileSync(path.join(zcHome, "config.json"), JSON.stringify({ ...realCfg, skillsDir }));
const SLUG = `ccfox-test-${Math.random().toString(36).slice(2, 7)}`;
assert.ok(!fs.existsSync(path.join(REAL_SKILLS, SLUG)));

// Test copy of the extension with the panel hook (needs 'unsafe-eval', which the
// shipped extension doesn't have). Only this copy has these hooks.
const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "zcext-"));
fs.cpSync(path.join(ROOT, "extension"), extDir, { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extDir, "manifest.json"), "utf8"));
manifest.background.scripts.push("test-hook-bg.js");
manifest.content_security_policy = "script-src 'self' 'unsafe-eval'; object-src 'self'";
fs.writeFileSync(path.join(extDir, "manifest.json"), JSON.stringify(manifest, null, 2));
fs.writeFileSync(
  path.join(extDir, "test-hook-bg.js"),
  `TOOLS.__panel_eval = async ({ code }) => ({ text: JSON.stringify(await browser.runtime.sendMessage({ zcTest: code })) });
TOOLS.__rec = async () => ({ text: JSON.stringify(Workflow.debug()) });
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

const pages = { "/fixture": "fixture.html", "/fixture2.html": "fixture2.html" };
const httpServer = http.createServer((req, res) => {
  const file = pages[new URL(req.url, "http://x").pathname];
  res.writeHead(file ? 200 : 404, { "content-type": "text/html" });
  res.end(file ? fs.readFileSync(path.join(ROOT, "test", file)) : "nope");
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${httpServer.address().port}`;

// WebDriver BiDi: Zen's remote agent, for trusted mouse and keyboard input.
const bidiPort = 9300 + Math.floor(Math.random() * 600);
console.log("launching Zen…");
const runner = await webExt.cmd.run(
  {
    sourceDir: extDir,
    firefox: "/Applications/Zen.app/Contents/MacOS/zen",
    noReload: true,
    noInput: true,
    args: [...(headed ? [] : ["-headless"]), "--remote-debugging-port", String(bidiPort)],
    pref: { "zen.welcome-screen.seen": true, "zen.updates.show-update-notification": false },
  },
  { shouldExitProgram: false },
);

let ws;
let bidiId = 0;
const bidiWaits = new Map();
async function bidiConnect() {
  for (let i = 0; i < 60 && !ws; i++) {
    try {
      const s = new WebSocket(`ws://127.0.0.1:${bidiPort}/session`);
      await new Promise((res, rej) => { s.onopen = res; s.onerror = () => rej(new Error("no BiDi")); });
      ws = s;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  if (!ws) throw new Error(`couldn't reach Zen's WebDriver BiDi on port ${bidiPort}`);
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    const w = bidiWaits.get(d.id);
    if (!w) return;
    bidiWaits.delete(d.id);
    d.type === "error" ? w.rej(new Error(`${d.error}: ${d.message}`)) : w.res(d.result);
  };
  await bidi("session.new", { capabilities: {} });
}
function bidi(method, params = {}) {
  return new Promise((res, rej) => {
    const id = ++bidiId;
    bidiWaits.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function contextFor(urlPart) {
  for (let i = 0; i < 40; i++) {
    const { contexts } = await bidi("browsingContext.getTree", {});
    const c = contexts.find((x) => x.url.includes(urlPart));
    if (c) return c.context;
    await sleep(250);
  }
  throw new Error(`no browsing context for ${urlPart}`);
}
async function evalIn(ctx, expression) {
  const r = await bidi("script.evaluate", { expression, target: { context: ctx }, awaitPromise: true });
  if (r.type === "exception") throw new Error(`page eval: ${JSON.stringify(r.exceptionDetails && r.exceptionDetails.text)}`);
  return r.result.value;
}
// A real click in the middle of the element: pointer move, down, up.
async function realClick(ctx, selector) {
  const rect = JSON.parse(await evalIn(ctx, `(() => { const e = document.querySelector(${JSON.stringify(selector)}); e.scrollIntoView({ block: "center" }); return JSON.stringify(e.getBoundingClientRect()); })()`));
  await bidi("input.performActions", {
    context: ctx,
    actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: [
      { type: "pointerMove", x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) },
      { type: "pointerDown", button: 0 },
      { type: "pointerUp", button: 0 },
    ] }],
  });
  await bidi("input.releaseActions", { context: ctx });
}
const KEYS = { Tab: "\uE004", Enter: "\uE007", End: "\uE010" }; // WebDriver key codes
async function realType(ctx, text) {
  const actions = [];
  for (const ch of text.match(/\{\w+\}|./gu)) {
    const v = ch.startsWith("{") ? KEYS[ch.slice(1, -1)] : ch;
    actions.push({ type: "keyDown", value: v }, { type: "keyUp", value: v });
  }
  await bidi("input.performActions", { context: ctx, actions: [{ type: "key", id: "kbd", actions }] });
  await bidi("input.releaseActions", { context: ctx });
}

// ------------------------------------------------------------------ bridge client (as panel-e2e)
let sock;
let nextId = 1;
const waiting = new Map();
async function bridgeConnect() {
  const p = path.join(zcHome, "bridge.sock");
  for (let i = 0; i < 100 && !fs.existsSync(p); i++) await sleep(200);
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
    await sleep(300);
  }
  const dump = await panelEval("[ui.rec.status, ...(ui.rec.steps || []).map((s, i) => `${i + 1}. [${s.kind}] ${s.text}`)].join('\\n')").catch(() => "");
  throw new Error(`timed out waiting for ${what}\n--- ui.rec ---\n${String(dump).slice(0, 3000)}`);
}
const recSteps = async () => (JSON.parse((await tool("__rec")).text) || { steps: [] }).steps;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ the helper app on its own
// Speaks the native messaging framing to a fresh host process, to check what it refuses.
async function hostSave(payloads) {
  const home = fs.mkdtempSync(path.join("/tmp", "zch-"));
  const dir = path.join(home, "skills");
  fs.mkdirSync(dir);
  const child = spawn(process.execPath, [path.join(ROOT, "host", "native-host.mjs")], { env: { ...process.env, CCFOX_HOME: home, CCFOX_SKILLS_DIR: dir }, stdio: ["pipe", "pipe", "ignore"] });
  let buf = Buffer.alloc(0);
  const replies = [];
  child.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const len = buf.readUInt32LE(0);
      replies.push(JSON.parse(buf.subarray(4, 4 + len).toString("utf8")));
      buf = buf.subarray(4 + len);
    }
  });
  const write = (o) => {
    const b = Buffer.from(JSON.stringify(o));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(b.length, 0);
    child.stdin.write(Buffer.concat([h, b]));
  };
  const out = [];
  for (const p of typeof payloads === "function" ? payloads(dir) : payloads) {
    const reqId = `t${out.length}`;
    write({ type: "skill.save", reqId, ...p });
    for (let i = 0; i < 50 && !replies.some((r) => r.reqId === reqId); i++) await sleep(50);
    out.push(replies.find((r) => r.reqId === reqId) || null);
  }
  child.stdin.end();
  child.kill();
  const files = fs.readdirSync(dir, { recursive: true });
  fs.rmSync(home, { recursive: true, force: true });
  return { out, files };
}

const results = [];
let failures = 0;
const step = async (name, fn) => {
  try {
    await fn();
    results.push(`ok   ${name}`);
  } catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${e.message.split("\n").slice(0, 20).join("\n       ")}`);
  }
};

let skillText = "";
try {
  await step("helper refuses unsafe names, symlinks and silent overwrites", async () => {
    const doc = (slug) => `---\nname: ${slug}\ndescription: "x"\n---\n\nThe user recorded this workflow in the browser with ccfox.\n`;
    const { out, files } = await hostSave((dir) => {
      fs.mkdirSync(path.join(dir, "..", "elsewhere"));
      fs.symlinkSync(path.join(dir, "..", "elsewhere"), path.join(dir, "linked"));
      return [
        { slug: "../evil", content: doc("../evil") },
        { slug: "Bad Name", content: doc("Bad Name") },
        { slug: "linked", content: doc("linked") },
        { slug: "fine", content: "no frontmatter" },
        { slug: "fine", content: doc("fine") },
        { slug: "fine", content: doc("fine") },
        { slug: "fine", content: doc("fine"), overwrite: true },
      ];
    });
    assert.equal(out[0].ok, false, "../evil refused");
    assert.equal(out[1].ok, false, "spaces and capitals refused");
    assert.equal(out[2].ok, false, "symlinked folder refused");
    assert.match(out[2].error, /isn't a plain folder/);
    assert.equal(out[3].ok, false, "content must start with the skill's frontmatter");
    assert.equal(out[4].ok, true, "a new skill is written");
    assert.deepEqual([out[5].ok, out[5].exists, out[5].recorded], [false, true, true], "an existing skill is not replaced without overwrite");
    assert.equal(out[6].ok, true, "overwrite after confirmation");
    assert.ok(files.includes(path.join("fine", "SKILL.md")) && !files.some((f) => String(f).includes("evil")), String(files));
  });

  await bridgeConnect();
  await bidiConnect();
  const fixtureTab = Number((await tool("tabs_create", { url: `${base}/fixture` })).text.match(/Created tab (\d+)/)[1]);
  await tool("__open_panel");
  await sleep(1000);
  const page = (code) => tool("javascript_exec", { tabId: fixtureTab, code }).then((r) => JSON.parse(r.text));

  await step("panel connects; the + menu offers Record a workflow", async () => {
    await waitFor("ui.conn && ui.conn.connected && document.getElementById('targetTitle').textContent === 'ccfox Fixture'", 20000, "connection");
    await panelEval("(document.getElementById('btnAttach').click(), true)");
    await waitFor("!document.getElementById('attachMenu').hidden", 3000, "menu");
    assert.match(await panelEval("document.getElementById('miRecord').innerText"), /Record a workflow/);
  });

  await step("start recording: recording bar, composer hidden, pill on the page", async () => {
    await panelEval("(document.getElementById('miRecord').click(), true)");
    await waitFor("ui.rec.status === 'recording' && !document.getElementById('recbar').hidden && document.getElementById('composer').hidden", 5000, "recording bar");
    await sleep(300);
    assert.match(await panelEval("document.getElementById('announceUrgent').textContent"), /Recording started/);
    assert.equal(await panelEval("document.activeElement.id"), "btnRecStop", "focus moves to Stop");
    await sleep(500);
    const pill = await page("(() => { const h = document.querySelector('ccfox-recording'); return h ? getComputedStyle(h.openOrClosedShadowRoot.querySelector('.pill')).opacity + '|' + h.openOrClosedShadowRoot.querySelector('.label').textContent : 'none'; })()");
    assert.equal(pill, "1|Recording your steps");
    const steps = await recSteps();
    assert.equal(steps[0].kind, "open");
    assert.match(steps[0].url, /\/fixture$/);
  });

  const ctx = await contextFor("/fixture");
  await bidi("browsingContext.activate", { context: ctx });

  await step("records real clicks; ignores synthetic ones", async () => {
    await realClick(ctx, "#counter");
    await waitFor("ui.rec.steps.length === 2", 5000, "click step");
    assert.equal(await page("document.getElementById('counter').textContent"), "Clicked 1");
    await page("(document.getElementById('counter').click(), true)"); // isTrusted === false
    await page("(document.getElementById('fake').dispatchEvent(new MouseEvent('click', { bubbles: true })), true)");
    await sleep(600);
    const steps = await recSteps();
    assert.equal(steps.length, 2, "synthetic clicks must not be recorded");
    assert.equal(steps[1].kind, "click");
    assert.deepEqual([steps[1].target.role, steps[1].target.name], ["button", "Click me"]);
    assert.match(await panelEval("document.getElementById('recLast').textContent"), /Click the button “Click me”/);
    assert.equal(await panelEval("document.getElementById('recCount').textContent"), "2 steps");
  });

  await step("one step per field with the final value; focus clicks dropped", async () => {
    await realClick(ctx, "#name");
    await realType(ctx, "Ada");
    await realType(ctx, " Lovelace{Tab}");
    await waitFor("ui.rec.steps.length === 3", 5000, "type step");
    const s = (await recSteps())[2];
    assert.equal(s.kind, "type");
    assert.equal(s.value, "Ada Lovelace");
    assert.equal(s.target.name, "Your name");
    // Editing the same field again updates that step rather than adding one.
    await realClick(ctx, "#name");
    await realType(ctx, "{End}!{Tab}");
    await sleep(500);
    const steps = await recSteps();
    assert.equal(steps.length, 3);
    assert.equal(steps[2].value, "Ada Lovelace!");
  });

  await step("password and card values are never stored", async () => {
    await realClick(ctx, "#pw");
    await realType(ctx, "hunter2-secret{Tab}");
    await realClick(ctx, "#card");
    await realType(ctx, "4242424242424242{Tab}");
    await waitFor("ui.rec.steps.length === 5", 5000, "secret steps");
    const steps = await recSteps();
    assert.deepEqual([steps[3].kind, steps[3].sensitive, steps[3].value], ["type", "password", undefined]);
    assert.deepEqual([steps[4].kind, steps[4].sensitive, steps[4].value], ["type", "card number", undefined]);
    const all = JSON.stringify(steps) + JSON.stringify(await panelEval("ui.rec"));
    assert.ok(!all.includes("hunter2") && !all.includes("4242"), "secret values leaked into the recording");
    assert.match(steps[3].text || (await panelEval("ui.rec.steps[3].text")), /The user enters their password .*\(ask the user; never stored\)/);
  });

  await step("checkbox via its label is one step", async () => {
    await realClick(ctx, "label:has(#agree)");
    await waitFor("ui.rec.steps.length === 6", 5000, "check step");
    await sleep(300);
    const steps = await recSteps();
    assert.equal(steps.length, 6);
    assert.deepEqual([steps[5].kind, steps[5].target.name], ["check", "I agree"]);
  });

  await step("a link to the second page: navigation, token hidden, pill follows", async () => {
    await realClick(ctx, "#next");
    for (let i = 0; i < 40 && !String(await evalIn(ctx, "location.href").catch(() => "")).includes("fixture2"); i++) await sleep(150);
    await waitFor("ui.rec.steps.length === 7 && !!ui.rec.steps[6].leadsTo", 5000, "link step leading to page 2");
    const s = (await recSteps())[6];
    assert.deepEqual([s.kind, s.target.role, s.target.name], ["click", "link", "Next page"]);
    assert.match(s.leadsTo, /\/fixture2\.html\?token=…&step=2$/);
    assert.ok(!JSON.stringify(await recSteps()).includes("abc123"), "URL tokens are masked");
    await sleep(800);
    const pill = await evalIn(ctx, "!!document.querySelector('ccfox-recording')");
    assert.equal(pill, true, "the pill is shown on the new page too");
  });

  await step("second page: click, type + Enter submits", async () => {
    await realClick(ctx, "#approve");
    await realClick(ctx, "#comment");
    await realType(ctx, "Looks good{Enter}");
    await waitFor("ui.rec.steps.length === 10 && ui.rec.steps[9].submits", 5000, "Enter step that submits");
    assert.equal(await evalIn(ctx, "document.getElementById('posted').textContent"), "posted Looks good");
    const steps = await recSteps();
    assert.deepEqual(steps.slice(7).map((s) => s.kind), ["click", "type", "key"]);
    assert.equal(steps[8].value, "Looks good");
    assert.equal(steps[9].key, "Enter");
  });

  await step("pause records nothing; resume continues", async () => {
    await panelEval("(document.getElementById('btnRecPause').click(), true)");
    await waitFor("ui.rec.status === 'paused' && document.getElementById('btnRecPause').textContent === 'Resume'", 3000, "paused");
    await sleep(300);
    await realClick(ctx, "#approve");
    await sleep(500);
    assert.equal((await recSteps()).length, 10, "nothing recorded while paused");
    assert.equal(await evalIn(ctx, "document.querySelector('ccfox-recording') ? 'yes' : 'no'"), "yes");
    await panelEval("(document.getElementById('btnRecPause').click(), true)");
    await waitFor("ui.rec.status === 'recording'", 3000, "resumed");
  });

  await step("stop opens the review sheet with the steps in plain language", async () => {
    await panelEval("(document.getElementById('btnRecStop').click(), true)");
    await waitFor("ui.rec.status === 'review' && !document.getElementById('reviewSheet').hidden", 5000, "review sheet");
    assert.equal(await panelEval("document.activeElement.id"), "wfName");
    const rows = await panelEval("[...document.querySelectorAll('#wfSteps .wf-step')].map((li) => li.querySelector('.wf-text').textContent)");
    assert.equal(rows.length, 10);
    assert.match(rows[0], /^Start on 127\.0\.0\.1:\d+\/fixture/);
    assert.match(rows[2], /^Type “Ada Lovelace!” into the field “Your name”/);
    assert.match(rows[6], /^Click the link “Next page”.*; it goes to 127\.0\.0\.1:\d+\/fixture2\.html/);
    assert.match(rows[9], /^Press Enter in the field “Comment”.* to submit the form/);
    assert.equal(await panelEval("document.querySelectorAll('#wfSteps .wf-lock').length"), 2, "two secret steps marked never stored");
    await sleep(500);
    assert.equal(await evalIn(ctx, "document.querySelector('ccfox-recording') ? 'yes' : 'no'"), "no", "pill goes away on stop");
  });

  await step("review: Ask each time, delete a step, name it", async () => {
    await panelEval("(document.querySelector('#wfSteps .wf-step:nth-child(3) .wf-ask').click(), true)");
    await waitFor("ui.rec.steps[2].ask === true && document.querySelector('#wfSteps .wf-step:nth-child(3) .wf-ask').getAttribute('aria-pressed') === 'true'", 3000, "ask toggled");
    await panelEval("(document.querySelector('#wfSteps .wf-step:nth-child(2) [data-role=del]').click(), true)");
    await waitFor("ui.rec.steps.length === 9", 3000, "step deleted");
    assert.ok(await panelEval("document.activeElement.dataset.role === 'del'"), "focus stays on a delete button");
    await panelEval(`(() => { const n = document.getElementById('wfName'); n.value = ${JSON.stringify(SLUG.replace(/-/g, " ").toUpperCase())}; n.dispatchEvent(new Event('input')); const d = document.getElementById('wfDesc'); d.value = 'Fill in the fixture form and approve on page two'; d.dispatchEvent(new Event('input')); const t = document.getElementById('wfNote'); t.value = 'The comment may differ each time.'; t.dispatchEvent(new Event('input')); return true; })()`);
    assert.equal(await panelEval("document.querySelector('#wfSlug code').textContent"), `/${SLUG}`);
  });

  await step("save writes SKILL.md to the skills folder; Run it now inserts the command", async () => {
    await waitFor("ui.catalog.commands.length > 5", 40000, "first catalog load");
    await panelEval("(document.getElementById('wfSave').click(), true)");
    await waitFor(`!document.getElementById('toast').hidden && document.getElementById('toastText').textContent.includes('Saved /${SLUG}')`, 10000, "saved toast");
    const file = path.join(skillsDir, SLUG, "SKILL.md");
    assert.ok(fs.existsSync(file), `${file} written`);
    assert.ok(!fs.existsSync(path.join(REAL_SKILLS, SLUG)), "never in the real ~/.claude/skills");
    skillText = fs.readFileSync(file, "utf8");
    assert.match(skillText, new RegExp(`^---\\nname: ${SLUG}\\ndescription: "Fill in the fixture form and approve on page two"\\ndisable-model-invocation: true\\nargument-hint: "\\[your-name\\]"\\n---\\n`));
    assert.match(skillText, /recorded this workflow in the browser with ccfox/);
    assert.match(skillText, /## Notes from the user\n\nThe comment may differ each time\./);
    assert.match(skillText, /- \*\*Your name\*\* \(step 2/);
    assert.match(skillText, /Their password \(step 3\): never stored/);
    assert.match(skillText, /mcp__browser__\*.*mcp__ccfox__\*/);
    assert.match(skillText, /Confirm with the user before this step/);
    assert.doesNotMatch(skillText, /Ada Lovelace|hunter2|4242|abc123|Click the button “Click me”/);
    await panelEval("(document.getElementById('toastAction').click(), true)");
    assert.equal(await panelEval("document.getElementById('input').value"), `/${SLUG} `);
    assert.equal(await panelEval("ui.rec.status"), "idle");
    assert.ok(await panelEval("document.getElementById('reviewSheet').hidden && document.getElementById('recbar').hidden && !document.getElementById('composer').hidden"));
  });

  await step("the new skill shows up in the / picker under Your skills", async () => {
    await waitFor(`ui.catalog.commands.some((c) => c.name === '${SLUG}')`, 60000, "catalog with the new skill");
    await panelEval(`(() => { const t = document.getElementById('input'); t.value = '/${SLUG.slice(0, 10)}'; t.focus(); t.dispatchEvent(new Event('input')); return true; })()`);
    const group = await waitFor(`(() => { const o = [...document.querySelectorAll('#pickerList [role=option]')].find((x) => x.textContent.startsWith('/${SLUG}')); return o ? o.closest('[role=group]').querySelector('.p-group span').textContent : null; })()`, 5000, "picker entry");
    assert.equal(group, "Your skills");
    await panelEval("(() => { const t = document.getElementById('input'); t.value = ''; t.dispatchEvent(new Event('input')); return true; })()");
  });

  await step("saving under an existing name asks first; Replace overwrites", async () => {
    await bidi("browsingContext.navigate", { context: ctx, url: `${base}/fixture`, wait: "complete" });
    await panelEval("(startRecording(), true)");
    await waitFor("ui.rec.status === 'recording'", 5000, "recording again");
    await sleep(400);
    await realClick(ctx, "#counter");
    await waitFor("ui.rec.steps.length === 2", 5000, "a step");
    await panelEval("(document.getElementById('btnRecStop').click(), true)");
    await waitFor("!document.getElementById('reviewSheet').hidden", 5000, "review");
    await panelEval(`(() => { const n = document.getElementById('wfName'); n.value = '${SLUG}'; n.dispatchEvent(new Event('input')); return true; })()`);
    await panelEval("(document.getElementById('wfSave').click(), true)");
    await waitFor("!document.getElementById('wfConflict').hidden", 5000, "overwrite question");
    assert.match(await panelEval("document.getElementById('wfConflictText').textContent"), /already have a recorded workflow/);
    assert.equal(fs.readFileSync(path.join(skillsDir, SLUG, "SKILL.md"), "utf8"), skillText, "not replaced before confirming");
    await panelEval("(document.getElementById('wfReplace').click(), true)");
    await waitFor("ui.rec.status === 'idle'", 5000, "saved");
    assert.match(fs.readFileSync(path.join(skillsDir, SLUG, "SKILL.md"), "utf8"), /Click the button “Click me”/);
  });

  await step("Cancel discards the recording", async () => {
    await panelEval("(startRecording(), true)");
    await waitFor("ui.rec.status === 'recording'", 5000, "recording");
    await realClick(ctx, "#counter");
    await waitFor("ui.rec.steps.length === 2", 5000, "a step");
    await panelEval("(document.getElementById('btnRecCancel').click(), true)");
    await waitFor("ui.rec.status === 'idle' && document.getElementById('recbar').hidden", 3000, "idle");
    assert.equal(await tool("__rec").then((r) => r.text), "null");
    await sleep(500);
    assert.equal(await evalIn(ctx, "document.querySelector('ccfox-recording') ? 'yes' : 'no'"), "no");
  });
} catch (e) {
  failures++;
  results.push(`FAIL setup: ${e.stack || e}`);
} finally {
  if (skillText) console.log(`\n--- SKILL.md as first saved ---\n${skillText}`);
  console.log("\n" + results.join("\n"));
  if (failures) {
    try { console.log("\n--- host.log tail ---\n" + fs.readFileSync(path.join(zcHome, "host.log"), "utf8").split("\n").slice(-15).join("\n")); } catch {}
  }
  try { ws?.close(); } catch {}
  try { sock?.end(); } catch {}
  try { await runner.exit(); } catch {}
  httpServer.close();
  fs.rmSync(zcHome, { recursive: true, force: true });
  fs.rmSync(extDir, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
