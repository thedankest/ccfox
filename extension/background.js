// ccfox background script. Connects to the native host ("ccfox"),
// receives tool requests from MCP clients and executes them in the browser.
"use strict";

const HOST_NAME = "ccfox";
const MAX_NET = 500;

const state = {
  port: null,
  connected: false,
  lastError: null,
  clients: 0,
  retryMs: 1000,
  controlled: new Set(), // tab ids Claude has touched
  currentTab: new Map(), // MCP client id -> tab id it is working in
  network: new Map(), // tab id -> request log
};

// ------------------------------------------------------------------ native port
function connect() {
  let port;
  try {
    port = browser.runtime.connectNative(HOST_NAME);
  } catch (e) {
    state.lastError = String(e);
    scheduleReconnect();
    return;
  }
  state.port = port;
  port.onMessage.addListener((msg) => {
    if (!state.connected) {
      state.connected = true;
      state.lastError = null;
      state.retryMs = 1000;
      updateBadge();
    }
    onHostMessage(msg);
  });
  port.onDisconnect.addListener((p) => {
    state.lastError = (p.error && p.error.message) || "native host exited";
    console.warn("[ccfox] native host disconnected:", state.lastError);
    state.port = null;
    state.connected = false;
    state.clients = 0;
    updateBadge();
    Chat.onConnection();
    scheduleReconnect();
  });
  port.postMessage({ type: "hello", version: browser.runtime.getManifest().version });
}

function scheduleReconnect() {
  const ms = state.retryMs;
  state.retryMs = Math.min(state.retryMs * 2, 30000);
  setTimeout(connect, ms);
}

function send(msg) {
  if (state.port) state.port.postMessage(msg);
}

function updateBadge() {
  const on = state.connected && state.clients > 0;
  const waiting = typeof Chat !== "undefined" && Chat.pendingApprovals() > 0;
  browser.browserAction.setBadgeText({ text: waiting ? "?" : on ? String(state.clients) : state.connected ? "" : "!" });
  browser.browserAction.setBadgeBackgroundColor({ color: waiting || on ? "#D97757" : "#888" });
  browser.browserAction.setTitle({
    title: !state.connected
      ? `ccfox: native host not connected (${state.lastError || "starting"})`
      : on
        ? `ccfox: ${state.clients} Claude session(s) connected`
        : "ccfox: ready, no Claude session connected",
  });
}

async function onHostMessage(msg) {
  if (msg.type === "clients") {
    state.clients = msg.count;
    updateBadge();
    return;
  }
  if (msg.type === "host.info") {
    state.hostInfo = msg;
    Chat.onConnection();
    return;
  }
  if (msg.type === "catalog") {
    Chat.onCatalog(msg);
    return;
  }
  if (msg.type === "skill.saved") {
    Workflow.onHostReply(msg);
    return;
  }
  if (msg.type === "chat.event") {
    Chat.onHostEvent(msg.chatId, msg.event);
    return;
  }
  if (msg.type !== "request") return;
  const { id, clientId, chatId, tool, args } = msg;
  try {
    const handler = TOOLS[tool];
    if (!handler) throw new Error(`Unknown tool: ${tool}`);
    const result = await handler(args || {}, { clientId, chatId });
    send({ type: "response", id, ok: true, result });
  } catch (e) {
    send({ type: "response", id, ok: false, error: friendlyError(e) });
  }
}

function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (/Missing host permission|Cannot access|not allowed|restricted/i.test(m)) {
    return `${m} — Firefox doesn't let extensions script this page (about:, view-source:, addons.mozilla.org, reader mode, or other privileged pages). Navigate to a normal web page.`;
  }
  return m;
}

// ------------------------------------------------------------------ tab helpers
async function resolveTab(args, ctx, { mark = true } = {}) {
  let tab;
  if (args.tabId !== undefined && args.tabId !== null) {
    try {
      tab = await browser.tabs.get(Number(args.tabId));
    } catch {
      throw new Error(`No tab with id ${args.tabId}. Call tabs_context to list tabs.`);
    }
  } else {
    const cur = state.currentTab.get(sessionKey(ctx));
    if (cur !== undefined) tab = await browser.tabs.get(cur).catch(() => null);
    if (!tab) {
      const [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
      if (!active) throw new Error("No active tab found. Create one with tabs_create.");
      tab = active;
    }
  }
  if (mark) {
    claim(tab.id, ctx);
    Highlight.touch(tab.id, sessionKey(ctx));
  }
  return tab;
}

// Claude Code sessions are keyed by bridge client; side-panel chats by chat id, so a
// chat keeps targeting the panel's tab even if its MCP server reconnects.
function sessionKey(ctx) {
  return ctx.chatId ? `chat:${ctx.chatId}` : ctx.clientId;
}

function claim(tabId, ctx) {
  state.currentTab.set(sessionKey(ctx), tabId);
  if (!state.controlled.has(tabId)) {
    state.controlled.add(tabId);
    // Start console capture now; later page loads are covered by syncConsoleHook().
    browser.tabs.executeScript(tabId, { file: "/content/console-hook.js", runAt: "document_start" }).catch(() => {});
    syncConsoleHook();
  }
}

// Console capture has to run before the page's own scripts, which only a registered
// content script guarantees. To avoid hooking the user's whole browser, the hook is
// registered just for the sites (scheme + host) currently open in Claude's tabs, and
// unregistered when Claude lets go of them.
let hookReg = null;
let hookKey = "";
let hookChain = Promise.resolve();
function syncConsoleHook() {
  hookChain = hookChain.then(async () => {
    const patterns = new Set();
    for (const id of state.controlled) {
      const t = await browser.tabs.get(id).catch(() => null);
      if (!t || !t.url) continue;
      try {
        const u = new URL(t.url);
        if (u.protocol === "http:" || u.protocol === "https:") patterns.add(`${u.protocol}//${u.hostname}/*`);
      } catch {}
    }
    const key = [...patterns].sort().join(" ");
    if (key === hookKey) return;
    hookKey = key;
    if (hookReg) {
      await hookReg.unregister().catch(() => {});
      hookReg = null;
    }
    if (patterns.size) {
      hookReg = await browser.contentScripts
        .register({ matches: [...patterns], js: [{ file: "/content/console-hook.js" }], runAt: "document_start" })
        .catch((e) => (console.warn("[ccfox] console hook registration failed", e), null));
    }
  });
  return hookChain;
}

async function ensureAgent(tabId) {
  const [present] = await browser.tabs.executeScript(tabId, {
    code: "typeof globalThis.__zcAgent === 'object'",
    runAt: "document_start",
  });
  if (present) return;
  await browser.tabs.executeScript(tabId, { file: "/content/console-hook.js", runAt: "document_start" }).catch(() => {});
  await browser.tabs.executeScript(tabId, { file: "/content/naming.js", runAt: "document_end" });
  await browser.tabs.executeScript(tabId, { file: "/content/agent.js", runAt: "document_end" });
}

async function agent(tabId, cmd, args = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await ensureAgent(tabId);
      const res = await browser.tabs.sendMessage(tabId, { zc: true, cmd, args }, { frameId: 0 });
      if (!res) throw new Error("Receiving end does not exist");
      if (res.error) throw new AgentError(res.error);
      return res.result;
    } catch (e) {
      if (e instanceof AgentError) throw e;
      const m = String(e && e.message);
      // Page was navigating / agent not yet in the new document: retry.
      if (attempt < 2 && /Receiving end does not exist|Could not establish connection|Message manager disconnected|No matching message handler|context unloaded|has been destroyed/i.test(m)) {
        await sleep(400);
        continue;
      }
      // A click that navigates can tear the page down before the reply arrives.
      if (/Message manager disconnected|context unloaded|has been destroyed/i.test(m) && ["click", "key", "type", "form_input"].includes(cmd)) {
        return { text: "Action sent; the page navigated or reloaded before replying." };
      }
      throw e;
    }
  }
}

class AgentError extends Error {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function waitForLoad(tabId, timeoutMs = 20000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (how) => {
      if (done) return;
      done = true;
      browser.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve(how);
    };
    const listener = (id, info) => {
      if (id === tabId && info.status === "complete") finish("complete");
    };
    browser.tabs.onUpdated.addListener(listener);
    const timer = setTimeout(() => finish("timeout"), timeoutMs);
    // It may already be complete (e.g. same-document navigation).
    setTimeout(() => browser.tabs.get(tabId).then((t) => t.status === "complete" && finish("complete")).catch(() => finish("closed")), 300);
  });
}

function tabLine(t, ctx) {
  const flags = [];
  if (t.active) flags.push("active");
  if (state.currentTab.get(sessionKey(ctx)) === t.id) flags.push("current");
  if (state.controlled.has(t.id)) flags.push("claude");
  if (t.pinned) flags.push("pinned");
  if (t.hidden) flags.push("hidden");
  if (t.discarded) flags.push("unloaded");
  if (typeof t.groupId === "number" && t.groupId !== -1) flags.push(`group ${t.groupId}`);
  return `- tabId=${t.id} window=${t.windowId}${flags.length ? ` [${flags.join(", ")}]` : ""} "${(t.title || "").slice(0, 100)}" ${t.url}`;
}

function normalizeUrl(u) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return u;
  if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/.test(u)) return `http://${u}`;
  return `https://${u}`;
}

// ------------------------------------------------------------------ screenshots
async function capture(tab, { rect, scale } = {}) {
  const vp = await agent(tab.id, "viewport").catch(() => null);
  const opts = { format: "png" };
  if (rect) {
    opts.rect = rect;
    opts.scale = scale || Math.min(2, (vp && vp.dpr) || 1);
  } else {
    opts.scale = 1; // CSS pixels: screenshot pixels == click coordinates
  }
  await Highlight.suspend(tab.id, true);
  let dataUrl;
  try {
    dataUrl = await browser.tabs.captureTab(tab.id, opts);
    if (dataUrl.length > 1_800_000) dataUrl = await browser.tabs.captureTab(tab.id, { ...opts, format: "jpeg", quality: 80 });
  } finally {
    await Highlight.suspend(tab.id, false);
  }
  const [head, data] = dataUrl.split(",");
  const mimeType = head.slice(5, head.indexOf(";"));
  return { data, mimeType, vp };
}

// ------------------------------------------------------------------ network log
browser.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || !state.controlled.has(d.tabId)) return;
    let log = state.network.get(d.tabId);
    if (!log) state.network.set(d.tabId, (log = []));
    log.push({ id: d.requestId, url: d.url, method: d.method, type: d.type, start: d.timeStamp, status: null, error: null });
    if (log.length > MAX_NET) log.splice(0, log.length - MAX_NET);
  },
  { urls: ["<all_urls>"] },
);

function updateReq(d, patch) {
  const log = state.network.get(d.tabId);
  if (!log) return;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].id === d.requestId) {
      Object.assign(log[i], patch);
      return;
    }
  }
}

browser.webRequest.onCompleted.addListener(
  (d) => updateReq(d, { status: d.statusCode, end: d.timeStamp, fromCache: d.fromCache, ip: d.ip }),
  { urls: ["<all_urls>"] },
);
browser.webRequest.onErrorOccurred.addListener(
  (d) => updateReq(d, { error: d.error, end: d.timeStamp }),
  { urls: ["<all_urls>"] },
);

// First load of a site not yet in the registration: inject as early as we can.
browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0 || !state.controlled.has(d.tabId)) return;
  browser.tabs.executeScript(d.tabId, { file: "/content/console-hook.js", runAt: "document_start" }).catch(() => {});
});

browser.tabs.onUpdated.addListener((tabId, info) => {
  if (info.url && state.controlled.has(tabId)) syncConsoleHook();
});

browser.tabs.onRemoved.addListener((tabId) => {
  if (state.controlled.delete(tabId)) syncConsoleHook();
  state.network.delete(tabId);
  for (const [cid, t] of state.currentTab) if (t === tabId) state.currentTab.delete(cid);
});

// ------------------------------------------------------------------ tools
const TOOLS = {
  async tabs_context(args, ctx) {
    const query = args.all_windows === false ? { lastFocusedWindow: true } : {};
    let tabs = await browser.tabs.query(query);
    if (args.claude_only) tabs = tabs.filter((t) => state.controlled.has(t.id));
    const cur = state.currentTab.get(sessionKey(ctx));
    const lines = tabs.map((t) => tabLine(t, ctx));
    return {
      text:
        `${tabs.length} tab(s). Current tab for this session: ${cur ?? "none (defaults to the active tab)"}.\n` +
        `Flags: active = focused in its window, current = default target for tools, claude = touched by Claude.\n\n` +
        lines.join("\n"),
    };
  },

  async tabs_create(args, ctx) {
    const url = args.url ? normalizeUrl(args.url) : "about:blank";
    const tab = await browser.tabs.create({ url: url === "about:blank" ? undefined : url, active: args.active !== false });
    claim(tab.id, ctx);
    Highlight.touch(tab.id, sessionKey(ctx));
    Highlight.group(tab);
    if (args.url) await waitForLoad(tab.id);
    const t = await browser.tabs.get(tab.id);
    return { text: `Created tab ${t.id}${args.active === false ? " in the background" : ""}. It is now this session's current tab.\n${tabLine(t, ctx)}` };
  },

  async tabs_select(args, ctx) {
    const tab = await resolveTab(args, ctx);
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true }).catch(() => {});
    return { text: `Tab ${tab.id} is now active and this session's current tab.` };
  },

  async tabs_close(args, ctx) {
    if (args.tabId === undefined) throw new Error("tabs_close needs tabId.");
    const tab = await resolveTab(args, ctx, { mark: false });
    await browser.tabs.remove(tab.id);
    return { text: `Closed tab ${tab.id}.` };
  },

  async navigate(args, ctx) {
    const tab = await resolveTab(args, ctx);
    const u = String(args.url || "").trim();
    if (!u) throw new Error("navigate needs url (or 'back', 'forward', 'reload').");
    if (u === "back") await browser.tabs.goBack(tab.id);
    else if (u === "forward") await browser.tabs.goForward(tab.id);
    else if (u === "reload") await browser.tabs.reload(tab.id, { bypassCache: !!args.bypass_cache });
    else {
      try {
        await browser.tabs.update(tab.id, { url: normalizeUrl(u) });
      } catch (e) {
        if (/Illegal URL/i.test(String(e && e.message))) {
          throw new Error(`Extensions aren't allowed to open ${u} (privileged pages like about:config, about:addons, about:debugging, chrome:, file: and view-source: are off-limits). Ask the user to open it.`);
        }
        throw e;
      }
    }
    const how = await waitForLoad(tab.id, args.timeout_ms || 20000);
    const t = await browser.tabs.get(tab.id);
    return { text: `${how === "timeout" ? "Still loading after timeout; " : ""}Tab ${t.id}: "${t.title}" ${t.url}` };
  },

  async read_page(args, ctx) {
    const tab = await resolveTab(args, ctx);
    const r = await agent(tab.id, "read_page", args);
    return { text: `tabId=${tab.id}\n${r.text}` };
  },

  async find(args, ctx) {
    const tab = await resolveTab(args, ctx);
    return agent(tab.id, "find", args);
  },

  async get_page_text(args, ctx) {
    const tab = await resolveTab(args, ctx);
    return agent(tab.id, "get_page_text", args);
  },

  async form_input(args, ctx) {
    const tab = await resolveTab(args, ctx);
    return agent(tab.id, "form_input", args);
  },

  async computer(args, ctx) {
    const tab = await resolveTab(args, ctx);
    const a = args.action;
    switch (a) {
      case "screenshot": {
        const shot = await capture(tab);
        const vp = shot.vp;
        return {
          text: vp ? `Screenshot of tab ${tab.id}: ${vp.width}x${vp.height} CSS px viewport (screenshot pixels = click coordinates), scrollY=${Math.round(vp.scrollY)}.` : `Screenshot of tab ${tab.id}.`,
          image: { data: shot.data, mimeType: shot.mimeType },
        };
      }
      case "zoom": {
        const [x0, y0, x1, y1] = args.region || [];
        if ([x0, y0, x1, y1].some((v) => typeof v !== "number") || x1 <= x0 || y1 <= y0) throw new Error("zoom needs region [x0, y0, x1, y1] in viewport coordinates.");
        const vp = await agent(tab.id, "viewport");
        const shot = await capture(tab, { rect: { x: x0 + vp.scrollX, y: y0 + vp.scrollY, width: x1 - x0, height: y1 - y0 }, scale: args.scale_factor });
        return { text: `Zoomed region (${x0},${y0})-(${x1},${y1}) of tab ${tab.id}.`, image: { data: shot.data, mimeType: shot.mimeType } };
      }
      case "left_click": case "right_click": case "double_click": case "triple_click": case "middle_click": {
        const count = { double_click: 2, triple_click: 3 }[a] || 1;
        const button = a === "right_click" ? "right" : a === "middle_click" ? "middle" : "left";
        return agent(tab.id, "click", { ...args, count, button });
      }
      case "hover": return agent(tab.id, "hover", args);
      case "type":
        if (typeof args.text !== "string") throw new Error("type needs text.");
        return agent(tab.id, "type", args);
      case "key":
        if (typeof args.text !== "string") throw new Error("key needs text, e.g. \"Enter\" or \"ctrl+a\".");
        return agent(tab.id, "key", args);
      case "scroll": return agent(tab.id, "scroll", args);
      case "scroll_to":
        if (!args.ref) throw new Error("scroll_to needs ref.");
        return agent(tab.id, "scroll_to", args);
      case "left_click_drag": return agent(tab.id, "drag", args);
      case "wait": {
        const s = Math.max(0, Math.min(30, Number(args.duration) || 1));
        await sleep(s * 1000);
        return { text: `Waited ${s}s.` };
      }
      default:
        throw new Error(`Unknown computer action: ${a}`);
    }
  },

  async javascript_exec(args, ctx) {
    const tab = await resolveTab(args, ctx);
    const code = String(args.code || "");
    if (!code.trim()) throw new Error("javascript_exec needs code.");
    const wrap = (body) => `(async () => {
  const __ser = (v) => {
    if (v === undefined) return "undefined";
    if (typeof v === "function") return "[Function]";
    if (v && typeof v.nodeType === "number") return v.outerHTML ? v.outerHTML.slice(0, 5000) : "[" + v.nodeName + "]";
    if (typeof v === "string") return JSON.stringify(v);
    const seen = new WeakSet();
    try {
      return JSON.stringify(v, (k, x) => {
        if (typeof x === "bigint") return x.toString() + "n";
        if (x && typeof x === "object") { if (seen.has(x)) return "[Circular]"; seen.add(x); if (typeof x.nodeType === "number") return "<" + (x.nodeName || "").toLowerCase() + ">"; }
        return x;
      }, 2);
    } catch (e) { return String(v); }
  };
  try {
    const __v = await (async () => {${body}
    })();
    return { ok: true, value: __ser(__v) };
  } catch (e) {
    return { ok: false, error: (e && e.stack) ? String(e) + "\\n" + e.stack : String(e) };
  }
})();`;
    let res;
    try {
      // Expression form first, so `document.title` returns its value REPL-style.
      [res] = await browser.tabs.executeScript(tab.id, { code: wrap(`return (${code.replace(/;\s*$/, "")}\n);`) });
    } catch (e) {
      // Runtime errors are caught inside the wrapper, so a rejection here means the
      // expression form didn't compile (statements) or the page can't be scripted.
      if (/Missing host permission|Cannot access|not allowed/i.test(String(e && e.message))) throw e;
      [res] = await browser.tabs.executeScript(tab.id, { code: wrap(code) });
    }
    if (!res) return { text: "undefined" };
    if (!res.ok) throw new Error(`Script threw: ${res.error}`);
    let v = res.value;
    if (v.length > 50000) v = v.slice(0, 50000) + "\n[truncated]";
    return { text: v };
  },

  async read_console_messages(args, ctx) {
    const tab = await resolveTab(args, ctx);
    return agent(tab.id, "console", args);
  },

  async read_network_requests(args, ctx) {
    const tab = await resolveTab(args, ctx);
    let log = state.network.get(tab.id) || [];
    if (args.urlPattern) log = log.filter((r) => r.url.includes(args.urlPattern));
    if (args.onlyFailed) log = log.filter((r) => r.error || (r.status && r.status >= 400));
    const limit = args.limit || 100;
    const shown = log.slice(-limit);
    const lines = shown.map((r) => {
      const st = r.error ? `ERR ${r.error}` : r.status ?? "pending";
      const ms = r.end ? ` ${Math.round(r.end - r.start)}ms` : "";
      return `${r.method} ${st} ${r.type}${ms}${r.fromCache ? " (cache)" : ""} ${r.url.length > 300 ? r.url.slice(0, 300) + "…" : r.url}`;
    });
    if (args.clear) state.network.set(tab.id, []);
    return {
      text: lines.length
        ? `${log.length} request(s) on tab ${tab.id} (showing last ${shown.length}; recorded since Claude first touched the tab):\n${lines.join("\n")}`
        : `No requests recorded on tab ${tab.id}. Recording starts when Claude first touches a tab; reload to capture page-load requests.`,
    };
  },

  async resize_window(args, ctx) {
    const tab = await resolveTab(args, ctx);
    const w = await browser.windows.update(tab.windowId, { width: args.width, height: args.height, state: "normal" });
    const vp = await agent(tab.id, "viewport").catch(() => null);
    return { text: `Window ${w.id} is ${w.width}x${w.height}${vp ? `; viewport is ${vp.width}x${vp.height}` : ""}.` };
  },

  async release_tabs(args, ctx) {
    const n = state.controlled.size;
    state.controlled.clear();
    state.network.clear();
    await syncConsoleHook();
    if (ctx.clientId === "panel") state.currentTab.clear();
    else state.currentTab.delete(sessionKey(ctx));
    return { text: `Released ${n} tab(s). Console/network capture stops after their next navigation.` };
  },
};

// ------------------------------------------------------------------ toolbar button
browser.browserAction.onClicked.addListener(() => {
  browser.sidebarAction.toggle();
});

updateBadge();
connect();
