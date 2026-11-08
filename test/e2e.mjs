// End-to-end test: launches Zen (or Firefox) headless with a throwaway profile and
// the extension loaded temporarily, then drives it through the real MCP server.
// Your normal profile is untouched. Requires `npm run install-host` first.
//   node test/e2e.mjs [--headed] [--firefox /path/to/binary]
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import webExt from "web-ext";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const headed = argv.includes("--headed");
const fxIdx = argv.indexOf("--firefox");
const firefox = fxIdx >= 0 ? argv[fxIdx + 1] : "/Applications/Zen.app/Contents/MacOS/zen";

// Isolated bridge socket so a real Zen with the extension isn't disturbed.
// (Unix socket paths max out around 104 bytes on macOS, so keep it short.)
const zcHome = fs.mkdtempSync(path.join("/tmp", "zc-"));
process.env.CCFOX_HOME = zcHome;

const fixture = fs.readFileSync(path.join(ROOT, "test", "fixture.html"));
const httpServer = http.createServer((req, res) => {
  if (req.url === "/" || req.url.startsWith("/fixture")) {
    res.writeHead(200, { "content-type": "text/html" });
    res.end(fixture);
  } else {
    res.writeHead(404);
    res.end("nope");
  }
});
await new Promise((r) => httpServer.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${httpServer.address().port}`;

console.log(`launching ${firefox}${headed ? "" : " (headless)"}…`);
const runner = await webExt.cmd.run(
  {
    sourceDir: path.join(ROOT, "extension"),
    firefox,
    noReload: true,
    noInput: true,
    args: headed ? [] : ["-headless"],
    browserConsole: false,
  },
  { shouldExitProgram: false },
);

let client;
let failures = 0;
const results = [];

async function cleanup() {
  try { await client?.close(); } catch {}
  try { await runner.exit(); } catch {}
  httpServer.close();
  fs.rmSync(zcHome, { recursive: true, force: true });
}

try {
  const sock = path.join(zcHome, "bridge.sock");
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 200));
  assert.ok(fs.existsSync(sock), `native host never created ${sock} — is the host installed (npm run install-host)? See ${zcHome}/host.log`);

  client = new Client({ name: "ccfox-e2e", version: "0.0.0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "server", "mcp-server.mjs")], env: { ...process.env } }));

  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    if (r.isError) throw new Error(`${name} failed: ${text}`);
    return { text, images: r.content.filter((c) => c.type === "image"), raw: r };
  };
  const js = async (code) => (await call("javascript_exec", { code })).text;
  const step = async (name, fn) => {
    try {
      await fn();
      results.push(`ok   ${name}`);
    } catch (e) {
      failures++;
      results.push(`FAIL ${name}: ${e.message.split("\n").slice(0, 6).join("\n       ")}`);
    }
  };

  const tools = (await client.listTools()).tools.map((t) => t.name);
  await step("lists tools", () => assert.ok(tools.includes("computer") && tools.includes("read_page"), tools.join(",")));

  await step("tabs_create + load", async () => {
    const r = await call("tabs_create", { url: `${base}/fixture` });
    assert.match(r.text, /Created tab \d+/);
  });

  await step("tabs_context", async () => {
    const r = await call("tabs_context");
    assert.match(r.text, /current, claude/);
    assert.match(r.text, /ccfox Fixture/);
  });

  let tree = "";
  const ref = (re) => {
    const m = tree.match(re);
    if (!m) throw new Error(`no ref for ${re} in:\n${tree.slice(0, 1500)}`);
    return m[1];
  };

  await step("read_page outline", async () => {
    tree = (await call("read_page")).text;
    assert.match(tree, /heading "Fixture Page" \[ref_\d+\] level=1/);
    assert.match(tree, /button "Click me" \[ref_\d+\]/);
    assert.match(tree, /textbox "Your name" \[ref_\d+\]/);
    assert.match(tree, /combobox \[ref_\d+\] selected="Red"|combobox "[^"]*" \[ref_\d+\] selected="Red"/);
    assert.match(tree, /clickable "Div button"/);
  });

  await step("read_page interactive filter", async () => {
    const t = (await call("read_page", { filter: "interactive" })).text;
    assert.doesNotMatch(t, /heading/);
    assert.match(t, /checkbox "I agree"/);
  });

  await step("click by ref", async () => {
    const r = await call("computer", { action: "left_click", ref: ref(/button "Click me" \[(ref_\d+)\]/) });
    assert.match(r.text, /Clicked button "Click me"/);
    assert.equal(await js("document.getElementById('counter').textContent"), '"Clicked 1"');
  });

  await step("click cursor:pointer div", async () => {
    await call("computer", { action: "left_click", ref: ref(/clickable "Div button" \[(ref_\d+)\]/) });
    assert.equal(await js("document.getElementById('fake').textContent"), '"Div clicked"');
  });

  await step("screenshot", async () => {
    const r = await call("computer", { action: "screenshot" });
    assert.equal(r.images.length, 1);
    assert.ok(r.images[0].data.length > 1000, "image too small");
    assert.match(r.text, /CSS px viewport/);
    const shot = path.join(process.env.ZC_SHOT_DIR || os.tmpdir(), "ccfox-e2e-shot." + r.images[0].mimeType.split("/")[1]); fs.writeFileSync(shot, Buffer.from(r.images[0].data, "base64")); console.log("screenshot saved to " + shot);
  });

  await step("click by coordinate (from element rect)", async () => {
    const rect = JSON.parse(JSON.parse(await js("JSON.stringify(document.getElementById('counter').getBoundingClientRect())")));
    await call("computer", { action: "left_click", coordinate: [Math.round(rect.x + rect.width / 2), Math.round(rect.y + rect.height / 2)] });
    assert.equal(await js("document.getElementById('counter').textContent"), '"Clicked 2"');
  });

  await step("type into focused input fires input events", async () => {
    await call("computer", { action: "left_click", ref: ref(/textbox "Your name" \[(ref_\d+)\]/) });
    await call("computer", { action: "type", text: "Ada Lovelace" });
    assert.equal(await js("document.getElementById('name').value"), '"Ada Lovelace"');
    assert.equal(await js("document.getElementById('mirror').textContent"), '"mirror:Ada Lovelace"');
  });

  await step("key Backspace + ctrl+a", async () => {
    await call("computer", { action: "key", text: "Backspace", repeat: 9 });
    assert.equal(await js("document.getElementById('name').value"), '"Ada"');
  });

  await step("key Enter submits form", async () => {
    await call("computer", { action: "key", text: "Enter" });
    assert.equal(await js("document.getElementById('submitted').textContent"), '"submitted Ada"');
  });

  await step("key Escape reaches page listener", async () => {
    await call("computer", { action: "key", text: "Escape" });
    assert.match(await js("document.getElementById('keys').textContent"), /Escape/);
  });

  await step("form_input select / checkbox / email / textarea / contenteditable", async () => {
    await call("form_input", { ref: ref(/combobox[^\[]*\[(ref_\d+)\]/), value: "Blue" });
    await call("form_input", { ref: ref(/checkbox "I agree" \[(ref_\d+)\]/), value: true });
    await call("form_input", { ref: ref(/textbox "Email" \[(ref_\d+)\]/), value: "ada@example.com" });
    await call("form_input", { ref: ref(/textbox "Notes" \[(ref_\d+)\]/), value: "line1\nline2" });
    await call("form_input", { ref: ref(/textbox "Rich editor" \[(ref_\d+)\]/), value: "rich text" });
    assert.equal(await js("document.getElementById('color').value"), '"b"');
    assert.equal(await js("document.getElementById('agree').checked"), "true");
    assert.equal(await js("document.getElementById('email').value"), '"ada@example.com"');
    assert.equal(await js("document.getElementById('notes').value"), '"line1\\nline2"');
    assert.equal(await js("document.getElementById('rich').innerText.trim()"), '"rich text"');
  });

  await step("find", async () => {
    const r = await call("find", { query: "section" });
    assert.match(r.text, /link "Jump to section" \[ref_\d+\]/);
  });

  await step("scroll page + scroll_to", async () => {
    await call("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 5, coordinate: [5, 300] });
    assert.ok(Number(await js("scrollY")) > 0, "page did not scroll");
    const t2 = (await call("find", { query: "Section two" })).text;
    const r2 = t2.match(/\[(ref_\d+)\]/)[1];
    await call("computer", { action: "scroll_to", ref: r2 });
    assert.ok(Number(await js("scrollY")) > 1500);
  });

  await step("javascript_exec: statements, await, page globals", async () => {
    assert.equal(await js("const a = 2; await new Promise(r => setTimeout(r, 10)); return a * 21;"), "42");
    assert.equal(await js("window.wrappedJSObject.pageGlobal"), '"hello from page"');
    await assert.rejects(() => call("javascript_exec", { code: "throw new Error('boom')" }), /boom/);
  });

  await step("get_page_text", async () => {
    const r = await call("get_page_text");
    assert.match(r.text, /Title: ccfox Fixture/);
    assert.match(r.text, /Section two/);
  });

  await step("console capture across reload", async () => {
    await call("navigate", { url: "reload" });
    const r = await call("read_console_messages");
    assert.match(r.text, /WARN: fixture loaded/);
    assert.match(r.text, /ERROR: fixture error \{"code":42\}/);
    const e = await call("read_console_messages", { onlyErrors: true });
    assert.doesNotMatch(e.text, /fixture loaded/);
  });

  await step("network log", async () => {
    const r = await call("read_network_requests");
    assert.match(r.text, /GET 404 xmlhttprequest .*\/api\/missing|GET 404 \w+ .*\/api\/missing/);
    assert.match(r.text, /GET 200 main_frame/);
  });

  await step("zoom", async () => {
    const r = await call("computer", { action: "zoom", region: [0, 0, 200, 100] });
    assert.equal(r.images.length, 1);
  });

  await step("navigate + back", async () => {
    await call("navigate", { url: `${base}/fixture?second` });
    let r = await call("navigate", { url: "back" });
    assert.doesNotMatch(r.text, /second/);
  });

  await step("stale ref gives a clear error", async () => {
    await assert.rejects(() => call("computer", { action: "left_click", ref: "ref_99999" }), /no longer exists/);
  });

  await step("privileged page error is explained", async () => {
    await assert.rejects(() => call("navigate", { url: "about:config" }), /aren't allowed to open about:config/);
  });

  await step("second tab + tabs_select switches current tab", async () => {
    const a = Number((await call("tabs_create", { url: `${base}/fixture?b` })).text.match(/Created tab (\d+)/)[1]);
    assert.match(await js("location.search"), /\?b/);
    const ctx = (await call("tabs_context", { claude_only: true })).text;
    const other = [...ctx.matchAll(/tabId=(\d+)/g)].map((m) => Number(m[1])).find((id) => id !== a);
    await call("tabs_select", { tabId: other });
    assert.doesNotMatch(await js("location.search"), /\?b/);
    await call("tabs_close", { tabId: a });
  });

  await step("console capture on first load of a new tab", async () => {
    await call("tabs_create", { url: `${base}/fixture?fresh` });
    const r = await call("read_console_messages");
    assert.match(r.text, /fixture loaded/);
  });

  await step("highlights the tab Claude works in (foreground and background)", async () => {
    const probe = "(() => { const h = document.querySelector('ccfox-overlay'); if (!h) return 'none'; const r = h.openOrClosedShadowRoot; return getComputedStyle(r.querySelector('.glow')).opacity + ' | stop=' + (getComputedStyle(r.querySelector('button')).display !== 'none'); })()";
    await call("navigate", { url: `${base}/fixture?hl` });
    await call("read_page", { filter: "interactive" });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(JSON.parse((await call("javascript_exec", { code: probe })).text), "1 | stop=false", "foreground tab should glow, with no Stop button for a Claude Code session");
    const bg = Number((await call("tabs_create", { url: `${base}/fixture?bg`, active: false })).text.match(/Created tab (\d+)/)[1]);
    await call("read_page", { tabId: bg, filter: "interactive" });
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(JSON.parse((await call("javascript_exec", { tabId: bg, code: probe })).text), "1 | stop=false", "background tab should glow too");
    const shot = await call("computer", { action: "screenshot", tabId: bg });
    assert.equal(shot.images.length, 1);
    await call("tabs_close", { tabId: bg });
  });

  await step("tabs Claude opens go into the Claude tab group", async () => {
    const id = Number((await call("tabs_create", { url: `${base}/fixture?grp`, active: false })).text.match(/Created tab (\d+)/)[1]);
    await new Promise((r) => setTimeout(r, 500));
    const line = (await call("tabs_context")).text.split("\n").find((l) => l.includes(`tabId=${id} `));
    assert.match(line, /group \d+/, "created tab should be grouped");
    await call("tabs_close", { tabId: id });
  });

  await step("tabs_close", async () => {
    const ctx = (await call("tabs_context", { claude_only: true })).text;
    const id = Number(ctx.match(/tabId=(\d+)/)[1]);
    await call("tabs_close", { tabId: id });
  });
} catch (e) {
  failures++;
  results.push(`FAIL setup: ${e.stack || e}`);
  try { results.push(fs.readFileSync(path.join(zcHome, "host.log"), "utf8")); } catch {}
} finally {
  console.log("\n" + results.join("\n"));
  await cleanup();
  console.log(failures ? `\n${failures} failure(s)` : "\nall passed");
  process.exit(failures ? 1 : 0);
}
