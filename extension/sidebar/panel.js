"use strict";

// ccfox side panel. Renders the chat that background/chat.js keeps, docks pending
// approvals above the composer, offers your Claude Code skills, plugins and agents via
// "/" (and agents via "@"), and attaches files, screenshots and tabs to messages.

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined && text !== null) n.textContent = text;
  return n;
};
// Lucide icons (ISC licence; see THIRD_PARTY_NOTICES.md), inlined as 24-unit SVGs.
// They go through SafeHTML like everything else that becomes markup.
const svg = (paths, cls = "") => `<svg${cls ? ` class="${cls}"` : ""} viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`;
const ICON = {
  done: svg('<path d="M20 6 9 17l-5-5"/>'), // check
  error: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'), // x
  running: svg('<path d="M21 12a9 9 0 1 1-6.219-8.56"/>'), // loader-circle
  interrupted: svg('<circle cx="12" cy="12" r="10"/><rect x="9" y="9" width="6" height="6" rx="1"/>'), // circle-stop
  chev: svg('<path d="m6 9 6 6 6-6"/>', "chev"), // chevron-down
  trash: svg('<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'), // trash (trash-2)
  copy: svg('<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>'),
  file: svg('<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>'),
  x: svg('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
  ask: svg('<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><path d="M12 17h.01"/>'), // circle-question-mark
  lock: svg('<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>'),
  alert: svg('<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>'), // circle-alert
  pause: svg('<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>'),
  play: svg('<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>'),
  square: svg('<rect width="18" height="18" x="3" y="3" rx="2"/>'),
};
ICON.denied = ICON.error;
const STATUS_WORDS = { done: "done", error: "failed", denied: "denied", running: "in progress", interrupted: "interrupted" };

const ui = {
  settings: { mode: "ask", allowedSites: [], model: "", highlight: true, groupTabs: true },
  history: [],
  catalog: { commands: [], agents: [], models: [], mcpServers: [] },
  conn: null,
  chat: null,
  windowId: null,
  activeTab: null,
  openGroups: new Set(),
  openDetails: new Set(),
  queued: null,
  pendingDeletes: new Map(),
  answering: null,
  attachments: [], // files for the next message: { id, file, name, size, mime, kind, thumb, prep }
  contextTabs: [], // other tabs for the next message: { id, title, url, favIconUrl }
  sending: false,
  rec: { status: "idle" }, // workflow recording, from background/workflow.js
};
const LIMITS = { files: 10, bytes: 20 * 1024 * 1024, tabs: 10 };

// ------------------------------------------------------------------ background port
let port;
function connectPort() {
  port = browser.runtime.connect({ name: "panel" });
  port.onMessage.addListener(onMessage);
  port.onDisconnect.addListener(() => setTimeout(connectPort, 500));
  port.postMessage({ cmd: "hello" });
}
const post = (msg) => port.postMessage(msg);

// Requests that need an answer from the background page (e.g. a screenshot).
const replies = new Map();
let nextReq = 1;
function request(msg, timeoutMs = 20000) {
  return new Promise((resolve, reject) => {
    const reqId = `q${nextReq++}`;
    replies.set(reqId, { resolve, reject });
    setTimeout(() => replies.delete(reqId) && reject(new Error("ccfox didn't answer in time.")), timeoutMs);
    post({ ...msg, reqId });
  });
}

function onMessage(msg) {
  switch (msg.type) {
    case "state":
      ui.settings = msg.settings;
      ui.history = msg.history;
      if (msg.catalog) ui.catalog = msg.catalog;
      setConn(msg.conn);
      renderModels();
      renderTarget();
      post(ui.chat ? { cmd: "open", chatId: ui.chat.id } : { cmd: "new" });
      break;
    case "chat":
      ui.chat = msg.chat;
      ui.openGroups.clear();
      ui.openDetails.clear();
      blockCache.clear();
      $("messages").replaceChildren();
      render(true);
      renderTarget();
      $("input").focus();
      break;
    case "item":
      if (!ui.chat || msg.chatId !== ui.chat.id) return;
      ui.chat.items[msg.index] = msg.item;
      render();
      break;
    case "meta": {
      if (!ui.chat || msg.chatId !== ui.chat.id) return;
      const wasRunning = ui.chat.running;
      Object.assign(ui.chat, { running: msg.running, title: msg.title, info: msg.info, sessionId: msg.sessionId, actingTab: msg.actingTab });
      render();
      renderTarget();
      if (wasRunning && !msg.running) onTurnEnd();
      break;
    }
    case "history":
      ui.history = msg.history;
      if (!$("historySheet").hidden) renderHistory();
      break;
    case "settings":
      ui.settings = msg.settings;
      renderTarget();
      renderModels();
      if (!$("settingsSheet").hidden) renderSettings();
      break;
    case "catalog":
      ui.catalog = msg.catalog;
      renderModels();
      renderTarget();
      if (!$("picker").hidden) renderPicker();
      if (!$("settingsSheet").hidden) renderSettings();
      break;
    case "conn":
      setConn(msg.conn);
      break;
    case "rec":
      onRec(msg.rec);
      break;
    case "toast":
      toast(msg.text);
      break;
    case "reply": {
      const r = replies.get(msg.reqId);
      if (!r) break;
      replies.delete(msg.reqId);
      if (msg.ok) r.resolve(msg.result);
      else r.reject(new Error(msg.error || "Something went wrong."));
      break;
    }
  }
}

function onTurnEnd() {
  const last = [...ui.chat.items].reverse().find((i) => i.role === "assistant");
  if (last) announce(`Claude: ${last.text.replace(/[*_`#>]/g, "").slice(0, 240)}`);
  if (ui.queued && !pendingApproval()) {
    const next = ui.queued;
    ui.queued = null;
    $("queued").hidden = true;
    deliver(next).catch((e) => toast(e.message));
  }
}

// ------------------------------------------------------------------ helpers
function siteOf(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./, "") : null;
  } catch {
    return null;
  }
}
function rawHost(url) {
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
  } catch {
    return null;
  }
}
function favicon(url, cls = "favicon") {
  const f = el("span", cls);
  f.setAttribute("aria-hidden", "true");
  if (url && /^(https?|data):/.test(url)) f.style.backgroundImage = `url("${url.replace(/"/g, "%22")}")`;
  else f.classList.add("blank");
  return f;
}
function announce(text, urgent = false) {
  const n = $(urgent ? "announceUrgent" : "announce");
  n.textContent = "";
  setTimeout(() => (n.textContent = text), 30);
}
function nearBottom() {
  const s = $("scroller");
  return s.scrollHeight - s.scrollTop - s.clientHeight < 90;
}
function toBottom() {
  const s = $("scroller");
  s.scrollTop = s.scrollHeight;
}
function pendingApproval() {
  if (!ui.chat) return null;
  return [...ui.chat.items].reverse().find((i) => i.role === "permission" && i.state === "pending") || null;
}

// ------------------------------------------------------------------ transcript
// Items are grouped into blocks: user / assistant / error / note, and runs of
// consecutive tool calls ("steps"). Blocks are re-rendered only when they change.
const blockCache = new Map(); // key -> { node, sig }
let frame = 0;
function render(jump = false) {
  if (frame) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    paint(jump);
  });
}

function blocksOf(items) {
  const out = [];
  let cur = null;
  items.forEach((it, i) => {
    if (it.role === "permission") return; // pending ones live in the dock; answers show on their step
    if (it.role === "tool") {
      if (cur) cur.idx.push(i);
      else out.push((cur = { type: "steps", idx: [i] }));
    } else {
      cur = null;
      out.push({ type: it.role, idx: [i] });
    }
  });
  return out;
}

function isLastError(index) {
  const items = ui.chat.items;
  for (let i = items.length - 1; i >= 0; i--) if (items[i].role === "error") return i === index;
  return false;
}

function sigOf(block, key) {
  const items = block.idx.map((i) => ui.chat.items[i]);
  return JSON.stringify([
    items.map((it) => [it.role, it.status, it.approval, it.summary, (it.text || "").length, (it.result || "").length, (it.attachments || []).map((a) => a.path || a.error || "")]),
    ui.openGroups.has(key),
    block.idx.filter((i) => ui.openDetails.has(i)),
    block.type === "error" ? [isLastError(block.idx[0]), ui.chat.running] : 0,
  ]);
}

function paint(jump) {
  const chat = ui.chat;
  if (!chat) return;
  const stick = jump || nearBottom();
  const list = $("messages");
  const blocks = blocksOf(chat.items);
  const live = new Set();
  let prevNode = null;
  let prevUserSite = null;
  for (const b of blocks) {
    const key = `${b.type}:${b.idx[0]}`;
    live.add(key);
    let ctx = null;
    if (b.type === "user") {
      const it = chat.items[b.idx[0]];
      const site = it.tab ? siteOf(it.tab.url) : null;
      ctx = { showSite: !!site && site !== prevUserSite, site, favIconUrl: it.tab && it.tab.favIconUrl };
      prevUserSite = site || prevUserSite;
    }
    const sig = sigOf(b, key) + JSON.stringify(ctx);
    const cached = blockCache.get(key);
    let node;
    if (cached && cached.sig === sig) node = cached.node;
    else {
      node = buildBlock(b, key, ctx);
      if (cached) cached.node.replaceWith(node);
      blockCache.set(key, { node, sig });
    }
    const want = prevNode ? prevNode.nextSibling : list.firstChild;
    if (want !== node) list.insertBefore(node, want);
    prevNode = node;
  }
  for (const [key, c] of blockCache) {
    if (!live.has(key)) {
      c.node.remove();
      blockCache.delete(key);
    }
  }
  renderChrome();
  renderDock();
  if (stick) toBottom();
}

function buildBlock(b, key, ctx) {
  const items = b.idx.map((i) => ui.chat.items[i]);
  const it = items[0];
  switch (b.type) {
    case "user": {
      const li = el("li", "msg-user");
      if ((it.attachments && it.attachments.length) || (it.contextTabs && it.contextTabs.length)) li.append(sentAttachments(it));
      if (it.text) li.append(el("div", "bubble", it.text));
      if (ctx && ctx.showSite) {
        const s = el("div", "site-change");
        s.append(favicon(ctx.favIconUrl), el("span", "", `on ${ctx.site}`));
        li.append(s);
      }
      return li;
    }
    case "assistant": {
      const li = el("li", "msg-assistant");
      const body = el("div", "md");
      SafeHTML.set(body, Markdown.render(it.text)); // the renderer escapes everything first
      const actions = el("div", "msg-actions");
      const copy = el("button", "msg-act");
      SafeHTML.set(copy, ICON.copy);
      copy.setAttribute("aria-label", "Copy reply");
      copy.title = "Copy reply";
      const index = b.idx[0];
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText((ui.chat.items[index] || it).text);
          SafeHTML.set(copy, ICON.done);
          copy.classList.add("done");
          announce("Copied the reply.");
          setTimeout(() => {
            SafeHTML.set(copy, ICON.copy);
            copy.classList.remove("done");
          }, 1400);
        } catch {
          toast("Couldn't copy. Select the text and copy it instead.");
        }
      });
      actions.append(copy);
      li.append(body, actions);
      return li;
    }
    case "steps":
      return buildSteps(b, key, items);
    case "error": {
      const li = el("li", "msg-error");
      li.setAttribute("role", "alert");
      SafeHTML.append(li, ICON.alert);
      li.append(el("strong", "", it.title || "Something went wrong"));
      if (it.text) li.append(el("p", "", it.text));
      if (it.detail && it.detail !== it.text) {
        const d = el("details");
        d.append(el("summary", "", "Details"), el("pre", "", it.detail));
        li.append(d);
      }
      if (it.retry && isLastError(b.idx[0]) && !ui.chat.running) {
        const btn = el("button", "btn small", "Try again");
        btn.addEventListener("click", () => post({ cmd: "retry", chatId: ui.chat.id, tabId: ui.activeTab ? ui.activeTab.id : undefined, windowId: ui.windowId }));
        li.append(btn);
      }
      return li;
    }
    case "note":
      return el("li", "msg-note", it.text);
    default:
      return el("li");
  }
}

function statusIcon(item) {
  const s = el("span", `status ${item.status} ${item.kind || ""}`);
  SafeHTML.set(s, ICON[item.status] || "");
  s.setAttribute("role", "img");
  s.setAttribute("aria-label", STATUS_WORDS[item.status] || item.status);
  return s;
}

function badgeFor(item) {
  if (item.approval === "denied") return el("span", "badge denied", "denied");
  if (item.approval === "once") return el("span", "badge approved", "you allowed");
  if (item.approval === "site") return el("span", "badge approved", `allowed on ${item.approvalSite || "site"}`);
  return null;
}

function buildSteps(b, key, items) {
  const li = el("li", "steps");
  const open = ui.openGroups.has(key) || items.length === 1;
  li.classList.toggle("open", open);
  const running = items.find((i) => i.status === "running");
  const latest = running || items[items.length - 1];
  const actions = items.filter((i) => i.kind === "act" || i.kind === "system").length;

  if (items.length > 1) {
    const head = el("button", "steps-head");
    head.setAttribute("aria-expanded", String(open));
    head.append(statusIcon(latest), el("span", "now", latest.summary));
    head.append(el("span", "count", `${items.length} steps${actions ? ` · ${actions} action${actions > 1 ? "s" : ""}` : ""}`));
    SafeHTML.append(head, ICON.chev);
    head.addEventListener("click", () => {
      if (ui.openGroups.has(key)) ui.openGroups.delete(key);
      else ui.openGroups.add(key);
      render();
    });
    li.append(head);
  }
  if (open) {
    const list = el("ul", "step-list");
    if (items.length === 1) list.style.borderTop = "0";
    b.idx.forEach((index, n) => {
      const item = items[n];
      const row = el("li", `step ${item.kind || "read"}`);
      const line = el("div", "step-line");
      const text = el("span", "step-text", item.summary);
      const badge = badgeFor(item);
      if (badge) text.append(badge);
      line.append(statusIcon(item), text);
      const detail = item.result || (item.kind === "system" && item.input ? item.input.command || JSON.stringify(item.input, null, 2) : "");
      if (detail) {
        const shown = ui.openDetails.has(index);
        const more = el("button", "step-more", shown ? "Hide" : "Details");
        more.setAttribute("aria-expanded", String(shown));
        more.addEventListener("click", () => {
          if (ui.openDetails.has(index)) ui.openDetails.delete(index);
          else ui.openDetails.add(index);
          render();
        });
        line.append(more);
      }
      row.append(line);
      if (detail && ui.openDetails.has(index)) row.append(el("pre", "", detail.length > 4000 ? detail.slice(0, 4000) + "…" : detail));
      list.append(row);
    });
    li.append(list);
  }
  return li;
}

function renderChrome() {
  const chat = ui.chat;
  const hasMessages = chat.items.length > 0;
  $("empty").hidden = hasMessages;
  $("chatTitle").textContent = hasMessages && chat.title ? chat.title : "New chat";
  const last = chat.items[chat.items.length - 1];
  const stepRunning = chat.items.some((i) => i.role === "tool" && i.status === "running");
  $("thinking").hidden = !chat.running || !!pendingApproval() || stepRunning || (last && last.role === "assistant");
  updateSendState();
}

function updateSendState() {
  const connected = !!(ui.conn && ui.conn.connected);
  const value = $("input").value.trim();
  const extras = ui.attachments.length > 0;
  const running = !!(ui.chat && ui.chat.running);
  $("btnSend").disabled = (!value && !extras) || !connected || ui.sending;
  // While Claude works the round button is Stop, until you start typing a follow-up.
  $("btnSend").hidden = running && !value && !extras;
  $("btnStop").hidden = !running || !!value || extras;
  for (const b of document.querySelectorAll(".suggestion")) b.disabled = !connected;
  const pending = pendingApproval();
  $("input").placeholder = pending
    ? "Or tell Claude what to do instead"
    : running
      ? "Queue a follow-up for when Claude finishes"
      : "Ask Claude to do something on this page";
}

// ------------------------------------------------------------------ approval dock
function renderDock() {
  const dock = $("dock");
  const p = pendingApproval();
  if (!p) {
    if (!dock.hidden) {
      dock.hidden = true;
      dock.replaceChildren();
      dock.dataset.requestId = "";
      if (ui.answering === "focus-input") $("input").focus();
    }
    ui.answering = null;
    return;
  }
  if (dock.dataset.requestId === p.requestId && !dock.hidden) return;
  dock.dataset.requestId = p.requestId;
  dock.hidden = false;
  const system = p.tier === "system";
  const card = el("section", `approval ${p.tier || "page"}`);
  card.tabIndex = -1;
  card.setAttribute("role", "group");
  card.setAttribute("aria-label", "Claude needs your approval");

  card.append(el("p", "approval-q", system ? "Claude wants to run this on your Mac" : "Claude wants to"));
  card.append(el("p", "approval-what", system && p.command ? "Run a command in the terminal" : p.summary));
  if (system && p.command) {
    const term = el("pre", "term");
    const parts = p.command.split(/\s*(?:&&|;|\|\|)\s*/).filter(Boolean);
    term.textContent = parts.map((x) => `$ ${x}`).join("\n");
    card.append(term);
  } else if (system && p.detail) {
    card.append(el("pre", "term", p.detail));
  }
  const where = el("p", "approval-where");
  if (system) where.append(el("span", "", `In ${p.cwd || "the ccfox workspace"}, outside the browser`));
  else if (p.site) where.append(favicon(p.favIconUrl), el("span", "", `on ${p.site}`));
  else where.append(el("span", "", "in a new tab"));
  card.append(where);
  if (p.tier === "commit") card.append(el("p", "approval-note", "This may submit, send or change something on the site."));

  const actions = el("div", "approval-actions");
  const answer = (decision) => {
    ui.answering = card.contains(document.activeElement) || document.activeElement === card ? "focus-input" : null;
    post({ cmd: "permission", chatId: ui.chat.id, requestId: p.requestId, decision });
  };
  const deny = el("button", "btn", "Deny");
  deny.addEventListener("click", () => answer("deny"));
  const once = el("button", "btn primary", "Allow once");
  once.addEventListener("click", () => answer("once"));
  actions.append(deny, once);
  if (p.site && !system) {
    const always = el("button", "btn secondary always", `Always allow on ${p.site}`);
    always.addEventListener("click", () => answer("site"));
    actions.append(always);
  }
  card.append(actions);
  card.append(el("p", "approval-foot", "Keys: A allow once · D deny. Or type below to redirect Claude."));
  card.addEventListener("keydown", (e) => {
    if (e.target.tagName === "BUTTON" && (e.key === "Enter" || e.key === " ")) return;
    const k = e.key.toLowerCase();
    if (k === "a") { e.preventDefault(); answer("once"); }
    else if (k === "d" || e.key === "Escape") { e.preventDefault(); answer("deny"); }
    else if (k === "s" && p.site && !system) { e.preventDefault(); answer("site"); }
  });
  dock.replaceChildren(card);
  announce(`Claude needs your approval: ${system ? "run a command on your Mac" : p.summary}${p.site ? ` on ${p.site}` : ""}.`, true);
  // Never put focus on a consent button. Only move to the card when the user isn't typing.
  const ae = document.activeElement;
  if (!ae || ae === document.body || !(ae.tagName === "TEXTAREA" || ae.tagName === "INPUT")) card.focus({ preventScroll: true });
}

// ------------------------------------------------------------------ connection + banner
function setConn(conn) {
  ui.conn = conn;
  if (!conn) return;
  const banner = $("banner");
  if (!conn.connected) {
    banner.hidden = false;
    $("bannerTitle").textContent = "Can't reach the ccfox helper.";
    $("bannerText").textContent = "Zen couldn't start it. Reconnect, or run the setup command in the ccfox folder.";
  } else if (!conn.claude) {
    banner.hidden = false;
    $("bannerTitle").textContent = "Claude Code isn't installed.";
    $("bannerText").textContent = "Install Claude Code, then run the setup command again.";
  } else banner.hidden = true;
  updateSendState();
  if (!$("settingsSheet").hidden) renderSettings();
}

async function copySetup() {
  try {
    await navigator.clipboard.writeText("npm run install-host");
    toast("Copied. Run it in the ccfox folder.");
  } catch {
    toast("Run “npm run install-host” in the ccfox folder.");
  }
}

// ------------------------------------------------------------------ target tab + trust
async function refreshTab() {
  if (ui.windowId === null) return;
  let [tab] = await browser.tabs.query({ active: true, windowId: ui.windowId });
  if (tab && tab.url && tab.url.startsWith(location.origin)) {
    // The panel is open as a tab (pop-out): work on the tab the user used last instead.
    const others = (await browser.tabs.query({ windowId: ui.windowId })).filter((t) => !t.url.startsWith(location.origin));
    tab = others.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
  }
  ui.activeTab = tab || null;
  renderTarget();
}

function renderTarget() {
  const acting = ui.chat && ui.chat.running && ui.chat.actingTab && (!ui.activeTab || ui.chat.actingTab.id !== ui.activeTab.id) ? ui.chat.actingTab : null;
  const tab = acting || ui.activeTab;
  $("target").classList.toggle("acting", !!acting);
  $("targetLabel").textContent = acting ? "Claude is in" : "";
  $("targetLabel").hidden = !acting;
  $("targetTitle").textContent = tab ? tab.title || tab.url : "No tab";
  $("targetIcon").replaceWith(Object.assign(favicon(tab && tab.favIconUrl), { id: "targetIcon" }));
  $("targetTab").title = acting ? "Show the tab Claude is working in" : tab ? tab.url : "";
  $("targetTab").dataset.tabId = tab ? tab.id : "";

  const host = tab ? rawHost(tab.url) : null;
  const wrap = $("trustWrap");
  const trust = ui.settings.mode === "auto" ? "auto" : host && ui.settings.allowedSites.includes(host) ? "site" : "ask";
  wrap.dataset.trust = host || trust === "auto" ? trust : "none";
  wrap.dataset.site = host || "";
  $("trust").value = trust;
  $("trust").title = trust === "auto" ? "Claude acts on every site without asking" : host ? `What Claude may do on ${host}` : "";

  const site = ui.activeTab ? siteOf(ui.activeTab.url) : null;
  $("emptyTitle").textContent = site ? `What should Claude do on ${site}?` : "What should Claude do here?";
  const n = (ui.catalog.commands || []).filter((c) => !c.builtin).length + (ui.catalog.agents || []).length;
  $("emptyHint").replaceChildren("Type ", el("kbd", null, "/"), ` for your ${n ? n + " " : ""}skills, plugins and agents. Drop files here to attach them.`);
}

// ------------------------------------------------------------------ models
function renderModels() {
  const models = ui.catalog.models || [];
  for (const id of ["model", "settingsModel"]) {
    const sel = $(id);
    const current = ui.settings.model || "";
    sel.replaceChildren();
    const def = models.find((m) => m.value === "default");
    const defName = def && def.description ? def.description.split(" · ")[0] : "";
    sel.append(new Option(defName ? `Default (${defName})` : "Default model", ""));
    for (const m of models) if (m.value !== "default") sel.append(new Option(m.displayName || m.value, m.value));
    if (![...sel.options].some((o) => o.value === current)) sel.append(new Option(current, current));
    sel.value = current;
  }
}

// ------------------------------------------------------------------ slash picker
// "/" lists everything Claude Code reported, grouped by where it comes from; "@" after
// a space lists agents. Choosing an agent inserts "@agent-<name>", the mention Claude
// Code turns into "use this subagent".
let pickerIndex = 0;
let pickerItems = [];
let pickerCtx = null;

function pickerQuery() {
  const t = $("input");
  const v = t.value;
  let m = v.match(/^\/(\S*)$/);
  if (m) return { mode: "all", q: m[1].toLowerCase() };
  const caret = t.selectionStart ?? v.length;
  if (t.selectionEnd !== caret) return null;
  m = v.slice(0, caret).match(/(^|\s)@([\w:.-]*)$/);
  if (m) return { mode: "agents", q: m[2].toLowerCase().replace(/^agent-/, ""), start: caret - m[2].length - 1, end: caret };
  return null;
}

// "Review a PR (plugin:code-review)" -> { src: "code-review", desc: "Review a PR" };
// plugin skills also come as "(mattpocock-skills) Use when…".
function sourceOf(desc) {
  let d = String(desc || "");
  let src = "";
  const tail = d.match(/\s*\(([^()]+)\)\s*$/);
  if (tail) {
    src = tail[1];
    d = d.slice(0, tail.index);
  }
  const head = d.match(/^\s*\(([^()]+)\)\s*/);
  if (head) {
    src = src || head[1];
    d = d.slice(head[0].length);
  }
  return { src: src.replace(/^plugin:/, ""), desc: d.trim() };
}

const GROUP_ORDER = ["mine", "plugin", "synced", "mcp", "agents", "builtin"];
function pickerEntries() {
  const c = ui.catalog || {};
  const out = [];
  for (const cmd of c.commands || []) {
    if (cmd.name.startsWith("_")) continue; // internal
    const { src, desc } = sourceOf(cmd.description);
    let group, label;
    if (cmd.builtin) [group, label] = ["builtin", "Built-in commands"];
    else if (/claude\.ai/i.test(src)) [group, label] = ["synced", "Synced from claude.ai"];
    else if (/^mcp__/.test(cmd.name) || src === "MCP") [group, label] = ["mcp", "From connectors"];
    else if (cmd.name.includes(":")) {
      const plugin = cmd.name.slice(0, cmd.name.indexOf(":"));
      [group, label] = [`plugin:${plugin}`, `${plugin} plugin`];
    } else [group, label] = ["mine", "Your skills"];
    out.push({ type: "command", group, label, name: cmd.name, shown: `/${cmd.name}`, hint: cmd.argumentHint || "", desc, src: group === "mine" && src && src !== "user" ? src : "" });
  }
  for (const a of c.agents || []) {
    const plugin = a.name.includes(":") ? a.name.slice(0, a.name.indexOf(":")) : "";
    out.push({ type: "agent", group: "agents", label: "Agents", name: a.name, shown: `@agent-${a.name}`, hint: "", desc: a.description || "", src: plugin });
  }
  return out;
}

function groupRank(key) {
  const i = GROUP_ORDER.indexOf(key.startsWith("plugin:") ? "plugin" : key);
  return i < 0 ? GROUP_ORDER.length : i;
}

function renderPicker() {
  const ctx = pickerQuery();
  const picker = $("picker");
  pickerCtx = ctx;
  if (ctx === null) {
    picker.hidden = true;
    $("input").setAttribute("aria-expanded", "false");
    $("input").removeAttribute("aria-activedescendant");
    return;
  }
  closePopovers();
  picker.dataset.mode = ctx.mode;
  const q = ctx.q;
  const all = pickerEntries().filter((e) => ctx.mode === "all" || e.type === "agent");
  const groups = new Map();
  for (const e of all) {
    const name = e.name.toLowerCase();
    let score = 0;
    if (!q) score = 1;
    else if (name.startsWith(q) || name.split(":").pop().startsWith(q)) score = 4;
    else if (name.includes(q)) score = 3;
    else if (e.label.toLowerCase().includes(q)) score = 2;
    else if (e.desc.toLowerCase().includes(q)) score = 1;
    if (!score) continue;
    if (!groups.has(e.group)) groups.set(e.group, { key: e.group, label: e.label, best: 0, items: [] });
    const g = groups.get(e.group);
    g.best = Math.max(g.best, score);
    g.items.push([score, e]);
  }
  const ordered = [...groups.values()].sort((a, b) => (q ? b.best - a.best : 0) || groupRank(a.key) - groupRank(b.key) || a.label.localeCompare(b.label));
  pickerItems = [];
  let budget = q ? 100 : Infinity;
  for (const g of ordered) {
    g.items.sort((a, b) => b[0] - a[0] || a[1].name.localeCompare(b[1].name));
    g.items = g.items.slice(0, budget).map((x) => x[1]);
    budget -= g.items.length;
    pickerItems.push(...g.items);
  }
  pickerIndex = Math.min(pickerIndex, Math.max(0, pickerItems.length - 1));

  const list = $("pickerList");
  list.replaceChildren();
  const total = all.length;
  $("pickerTitle").textContent = !total
    ? ctx.mode === "agents" ? "Agents" : "Skills and commands"
    : q
      ? `${pickerItems.length} matching`
      : ctx.mode === "agents"
        ? `${total} agents`
        : `${ordered.length} sources · ${total} entries`;
  if (!total) {
    list.append(el("div", "p-empty", ui.conn && ui.conn.connected ? "Loading your skills…" : "Connect to see your skills."));
    if (ui.conn && ui.conn.connected) post({ cmd: "catalog" });
  } else if (!pickerItems.length) {
    list.append(el("div", "p-empty", `Nothing matches “${ctx.mode === "agents" ? "@" : "/"}${q}”.`));
  }
  let i = 0;
  ordered.forEach((g, gi) => {
    if (!g.items.length) return;
    const group = el("div", "p-groupbox");
    group.setAttribute("role", "group");
    const head = el("div", "p-group");
    head.id = `pick-g${gi}`;
    head.setAttribute("role", "presentation");
    head.append(el("span", "", g.label), el("span", "p-count", String(g.items.length)));
    group.setAttribute("aria-labelledby", head.id);
    group.append(head);
    for (const e of g.items) {
      const n = i++;
      const opt = el("div", `p-opt ${e.type}`);
      opt.id = `pick-${n}`;
      opt.setAttribute("role", "option");
      opt.setAttribute("aria-selected", String(n === pickerIndex));
      const name = el("span", "p-name");
      name.append(el("span", "", `${e.shown}${e.hint ? " " + e.hint : ""}`));
      if (e.src) name.append(el("span", "p-src", e.src));
      opt.append(name);
      if (e.desc) opt.append(el("span", "p-desc", e.desc));
      opt.addEventListener("mousedown", (ev) => {
        ev.preventDefault();
        choosePick(n);
      });
      group.append(opt);
    }
    list.append(group);
  });
  picker.hidden = false;
  $("input").setAttribute("aria-expanded", "true");
  $("input").setAttribute("aria-activedescendant", pickerItems.length ? `pick-${pickerIndex}` : "");
  const sel = $(`pick-${pickerIndex}`);
  if (sel) sel.scrollIntoView({ block: "nearest" });
}

function movePick(d) {
  if (!pickerItems.length) return;
  pickerIndex = (pickerIndex + d + pickerItems.length) % pickerItems.length;
  renderPicker();
}

function choosePick(i) {
  const c = pickerItems[i];
  if (!c) return;
  const t = $("input");
  if (c.type === "agent" && pickerCtx && pickerCtx.mode === "agents") {
    const ins = `@agent-${c.name} `;
    t.value = t.value.slice(0, pickerCtx.start) + ins + t.value.slice(pickerCtx.end);
    const at = pickerCtx.start + ins.length;
    t.setSelectionRange(at, at);
  } else {
    t.value = c.type === "agent" ? `@agent-${c.name} ` : `/${c.name} `;
  }
  $("picker").hidden = true;
  autosize();
  t.focus();
}

// ------------------------------------------------------------------ sheets (modal, focus-trapped)
let sheetOpener = null;
function openSheet(id) {
  closeSheets(false);
  sheetOpener = document.activeElement;
  const sheet = $(id);
  sheet.hidden = false;
  $("app").inert = true;
  if (id === "historySheet") {
    $("historySearch").value = "";
    renderHistory();
    $("historySearch").focus();
  } else if (id === "reviewSheet") {
    fillReview();
    $("wfName").focus();
    $("wfName").select();
  } else {
    renderSettings();
    const first = sheet.querySelector("input:checked, button");
    if (first) first.focus();
  }
}
function closeSheets(restore = true) {
  let was = false;
  for (const s of document.querySelectorAll(".sheet")) {
    if (!s.hidden) was = true;
    s.hidden = true;
  }
  $("app").inert = false;
  renderRec();
  if (was && restore) (sheetOpener && sheetOpener.isConnected ? sheetOpener : $("input")).focus();
}
document.addEventListener("keydown", (e) => {
  const sheet = document.querySelector(".sheet:not([hidden])");
  if (!sheet) return;
  if (e.key === "Escape") {
    e.preventDefault();
    closeSheets();
  } else if (e.key === "Tab") {
    const f = [...sheet.querySelectorAll("button, input, select, textarea, [tabindex]:not([tabindex='-1'])")].filter((x) => !x.disabled && x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

function relTime(t) {
  const s = (Date.now() - t) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

function renderHistory() {
  const list = $("historyList");
  const q = $("historySearch").value.trim().toLowerCase();
  list.replaceChildren();
  const items = ui.history.filter((h) => !ui.pendingDeletes.has(h.id) && (!q || (h.title || "").toLowerCase().includes(q) || (h.site || "").includes(q)));
  if (!items.length) {
    list.append(el("li", "empty-list", q ? "No chats match." : "No chats yet. Your conversations will show up here."));
    return;
  }
  for (const h of items) {
    const li = el("li", ui.chat && h.id === ui.chat.id ? "current" : "");
    const open = el("button", "open");
    const meta = el("span", "meta");
    meta.append(el("span", "t", h.title || "Untitled"), el("span", "d", [h.site, relTime(h.updatedAt)].filter(Boolean).join(" · ")));
    open.append(favicon(h.favIconUrl), meta);
    open.addEventListener("click", () => {
      post({ cmd: "open", chatId: h.id });
      closeSheets(false);
      $("input").focus();
    });
    const del = el("button", "icon-btn");
    del.setAttribute("aria-label", `Delete “${h.title}”`);
    del.title = "Delete";
    SafeHTML.set(del, ICON.trash);
    del.addEventListener("click", () => deleteChat(h));
    li.append(open, del);
    list.append(li);
  }
}

function deleteChat(h) {
  const timer = setTimeout(() => {
    ui.pendingDeletes.delete(h.id);
    post({ cmd: "delete", chatId: h.id });
  }, 5000);
  ui.pendingDeletes.set(h.id, timer);
  if (ui.chat && ui.chat.id === h.id) post({ cmd: "new" });
  renderHistory();
  toast(`Deleted “${(h.title || "chat").slice(0, 40)}”.`, "Undo", () => {
    clearTimeout(ui.pendingDeletes.get(h.id));
    ui.pendingDeletes.delete(h.id);
    renderHistory();
  });
}

function renderSettings() {
  for (const r of document.querySelectorAll('input[name="mode"]')) r.checked = r.value === ui.settings.mode;
  $("optHighlight").checked = ui.settings.highlight !== false;
  $("optGroup").checked = ui.settings.groupTabs !== false;
  $("optGroupWrap").hidden = !(ui.conn && ui.conn.canGroupTabs);

  const sites = $("siteList");
  sites.replaceChildren();
  if (!ui.settings.allowedSites.length) sites.append(el("li", "empty-list", "None yet. Choose “Always allow” on a request, or use the menu next to the tab name."));
  for (const s of ui.settings.allowedSites) {
    const li = el("li");
    const rm = el("button", "btn small ghost", "Remove");
    rm.setAttribute("aria-label", `Stop always allowing ${s}`);
    rm.addEventListener("click", () => post({ cmd: "removeSite", site: s }));
    li.append(el("span", "site", s), rm);
    sites.append(li);
  }

  const c = ui.catalog || {};
  const add = (dl, k, v) => dl.append(el("dt", "", k), el("dd", "", v));
  const facts = $("facts");
  facts.replaceChildren();
  const cmds = c.commands || [];
  if (!cmds.length) add(facts, "Skills and commands", "loading…");
  else {
    add(facts, "Skills", String(cmds.filter((x) => !x.builtin).length));
    add(facts, "Built-in commands", String(cmds.filter((x) => x.builtin).length));
  }
  if (c.agents && c.agents.length) add(facts, "Agents", String(c.agents.length));
  const chips = $("connectors");
  chips.replaceChildren();
  for (const s of c.mcpServers || []) {
    const state = s.status === "connected" ? "" : s.status === "pending" ? "wait" : "bad";
    const chip = el("span", `chip ${state}`);
    // "plugin:reading-list:library" -> "reading-list"; "claude.ai Gmail" -> "Gmail"
    const pm = s.name.match(/^plugin:([^:]+):(.+)$/);
    const name = pm ? (pm[1] === pm[2] ? pm[2] : `${pm[1]} · ${pm[2]}`) : s.name.replace(/^claude\.ai /, "");
    chip.append(el("span", "pip"), el("span", "", name));
    const words = { connected: "connected", pending: "connecting", failed: "failed", "needs-auth": "needs sign-in", disabled: "turned off" };
    const from = pm ? `from the ${pm[1]} plugin` : /^claude\.ai /.test(s.name) ? "from claude.ai" : "";
    chip.title = [words[s.status] || s.status, from].filter(Boolean).join(" · ");
    chip.setAttribute("aria-label", `${name}: ${chip.title}`);
    chips.append(chip);
  }
  if (!(c.mcpServers || []).length) chips.append(el("span", "empty-list", "Connectors show up after your first message."));

  const plugins = $("pluginList");
  plugins.replaceChildren();
  for (const p of c.plugins || []) {
    const li = el("li");
    const main = el("span", "plugin-main");
    const title = el("span", "plugin-name", p.name);
    if (p.version) title.append(el("span", "plugin-ver", ` ${p.version}`));
    const skills = cmds.filter((x) => x.name.startsWith(`${p.name}:`)).length;
    const agents = (c.agents || []).filter((x) => x.name.startsWith(`${p.name}:`)).length;
    const conns = (c.mcpServers || []).filter((x) => x.name.startsWith(`plugin:${p.name}:`)).length;
    const parts = [skills && `${skills} skill${skills > 1 ? "s" : ""}`, agents && `${agents} agent${agents > 1 ? "s" : ""}`, conns && `${conns} connector${conns > 1 ? "s" : ""}`].filter(Boolean);
    const market = (p.source || "").split("@")[1];
    main.append(title, el("span", "plugin-sub", [parts.join(" · ") || "hooks or settings only", market && `from ${market}`].filter(Boolean).join(" · ")));
    const err = (c.pluginErrors || []).find((e) => e.plugin === p.source || e.plugin.split("@")[0] === p.name);
    const status = el("span", `chip ${err ? "bad" : ""}`);
    status.append(el("span", "pip"), el("span", "", err ? "problem" : "loaded"));
    if (err) status.title = err.message;
    li.append(main, status);
    plugins.append(li);
  }
  for (const e of (c.pluginErrors || []).filter((e) => !(c.plugins || []).some((p) => e.plugin === p.source || e.plugin.split("@")[0] === p.name))) {
    const li = el("li");
    const main = el("span", "plugin-main");
    main.append(el("span", "plugin-name", e.plugin), el("span", "plugin-sub", e.message));
    const status = el("span", "chip bad");
    status.append(el("span", "pip"), el("span", "", "didn't load"));
    li.append(main, status);
    plugins.append(li);
  }
  if (!plugins.children.length) plugins.append(el("li", "empty-list", c.commands && c.commands.length ? "No plugins installed. Add them in Claude Code with /plugin." : "Loading your plugins…"));

  const conn = ui.conn || {};
  const cf = $("connFacts");
  cf.replaceChildren();
  add(cf, "Helper app", conn.connected ? `connected · v${conn.hostVersion || "?"}` : `not connected${conn.lastError ? ` (${conn.lastError})` : ""}`);
  add(cf, "Claude Code", conn.claude || "not found");
  add(cf, "Claude Code sessions here", String(conn.externalSessions ?? 0));
}

// ------------------------------------------------------------------ toast
let toastTimer;
function toast(text, actionLabel, action) {
  const t = $("toast");
  $("toastText").textContent = text;
  const btn = $("toastAction");
  btn.hidden = !actionLabel;
  btn.textContent = actionLabel || "";
  btn.onclick = () => {
    t.hidden = true;
    if (action) action();
  };
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), actionLabel ? 5000 : 3500);
}

// ------------------------------------------------------------------ input
function autosize() {
  const t = $("input");
  t.style.height = "auto";
  const max = window.innerHeight * 0.4;
  t.style.height = Math.min(t.scrollHeight, max) + "px";
  t.style.overflowY = t.scrollHeight > max ? "auto" : "hidden";
  updateSendState();
  renderPicker();
}

function send(text) {
  const fromBox = text === undefined;
  const value = (fromBox ? $("input").value : text).trim();
  if (!ui.chat || ui.sending) return;
  const extras = { attachments: ui.attachments, contextTabs: ui.contextTabs };
  if (!value && !extras.attachments.length) return;
  const clearBox = () => {
    if (fromBox) {
      $("input").value = "";
      autosize();
    }
  };
  const pending = pendingApproval();
  if (pending) {
    // Typing while Claude waits for approval means "no, do this instead". Attachments
    // stay in the composer for the next message.
    if (!value) return toast("Answer Claude's request first, then send your files.");
    ui.answering = "focus-input";
    post({ cmd: "permission", chatId: ui.chat.id, requestId: pending.requestId, decision: "deny", message: value });
    clearBox();
  } else if (ui.chat.running) {
    ui.queued = { text: value, ...extras };
    clearComposerExtras();
    clearBox();
    $("queued").hidden = false;
    toast("Queued. It goes out when Claude finishes.");
  } else {
    clearComposerExtras();
    clearBox();
    deliver({ text: value, ...extras }).catch((e) => {
      // Put everything back so nothing the user attached is lost.
      ui.attachments = [...extras.attachments, ...ui.attachments].slice(0, LIMITS.files);
      ui.contextTabs = extras.contextTabs;
      if (fromBox && !$("input").value) {
        $("input").value = value;
        autosize();
      }
      renderAttachments();
      toast(e.message);
    });
  }
  requestAnimationFrame(toBottom);
}

// Reads the files (only now, so big ones don't sit in memory twice) and hands the
// message to the background page, which uploads each file to the helper app.
async function deliver({ text, attachments = [], contextTabs = [] }) {
  ui.sending = true;
  updateSendState();
  try {
    const files = [];
    for (const a of attachments) files.push(await serializeAttachment(a));
    post({
      cmd: "send",
      chatId: ui.chat.id,
      text,
      attachments: files.length ? files : undefined,
      contextTabs: contextTabs.length ? contextTabs.map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl })) : undefined,
      windowId: ui.windowId,
      tabId: ui.activeTab ? ui.activeTab.id : undefined,
    });
  } finally {
    ui.sending = false;
    updateSendState();
  }
}

// ------------------------------------------------------------------ attachments
const IMAGE_OK = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const MIME_BY_EXT = { md: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", log: "text/plain", ts: "text/plain", tsx: "text/plain", py: "text/x-python", yaml: "text/yaml", yml: "text/yaml", heic: "image/heic" };
const uid = () => Math.random().toString(36).slice(2, 10);

function fmtSize(n) {
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`;
}
function kindLabel(a) {
  if (a.kind === "screenshot") return "Screenshot";
  const ext = (a.name.match(/\.([a-z0-9]{1,6})$/i) || [])[1];
  return ext ? ext.toUpperCase() : a.mime && a.mime !== "application/octet-stream" ? a.mime.split("/").pop().toUpperCase() : "File";
}

function addFiles(list, kind) {
  const files = [...(list || [])];
  const tooBig = [];
  let added = 0;
  let full = false;
  for (const f of files) {
    if (ui.attachments.length >= LIMITS.files) {
      full = true;
      break;
    }
    if (f.size > LIMITS.bytes) {
      tooBig.push(f);
      continue;
    }
    const ext = ((f.name || "").match(/\.([a-z0-9]+)$/i) || [])[1];
    const mime = (f.type || MIME_BY_EXT[(ext || "").toLowerCase()] || "application/octet-stream").toLowerCase();
    const a = { id: uid(), file: f, name: f.name || "file", size: f.size, mime, kind: kind || (mime.startsWith("image/") ? "image" : "file"), thumb: null, prep: null };
    if (mime.startsWith("image/")) {
      a.prep = prepareImage(f, mime)
        .then((r) => {
          a.thumb = r.thumb;
          renderAttachments();
          return r;
        })
        .catch(() => null);
    }
    ui.attachments.push(a);
    added++;
  }
  const notes = [];
  if (tooBig.length) notes.push(`${tooBig.length === 1 ? `“${tooBig[0].name}” is ${fmtSize(tooBig[0].size)}` : `${tooBig.length} files are too big`}. Files can be up to 20 MB each.`);
  if (full) notes.push(`You can attach up to ${LIMITS.files} files to one message.`);
  if (notes.length) toast(notes.join(" "));
  if (added) announce(`${added === 1 ? `Attached ${ui.attachments[ui.attachments.length - 1].name}` : `Attached ${added} files`}.`);
  renderAttachments();
}

// A small thumbnail for the chip and the transcript, and a copy of the image sized
// for Claude: the original when the API takes it as is, otherwise at most 1568 px.
async function prepareImage(file, mime) {
  const bmp = await createImageBitmap(file);
  const draw = (maxSide, type, quality) => {
    const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(bmp.width * k));
    c.height = Math.max(1, Math.round(bmp.height * k));
    const g = c.getContext("2d");
    if (type === "image/jpeg") {
      g.fillStyle = "#fff";
      g.fillRect(0, 0, c.width, c.height);
    }
    g.drawImage(bmp, 0, 0, c.width, c.height);
    return new Promise((res) => c.toBlob(res, type, quality));
  };
  const thumbBlob = await draw(120, "image/jpeg", 0.8);
  const thumb = await blobToDataUrl(thumbBlob);
  let block = null;
  const asIs = IMAGE_OK.has(mime) && file.size <= 3.5 * 1024 * 1024 && Math.max(bmp.width, bmp.height) <= 7900;
  if (!asIs) {
    block = await draw(1568, "image/png");
    if (!block || block.size > 3.5 * 1024 * 1024) block = await draw(1568, "image/jpeg", 0.86);
  }
  bmp.close();
  return { thumb, asIs, block };
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(blob);
  });
}
const base64Of = async (blob) => String(await blobToDataUrl(blob)).replace(/^data:[^,]*,/, "");

async function serializeAttachment(a) {
  let data;
  try {
    data = await base64Of(a.file);
  } catch {
    throw new Error(`Couldn't read “${a.name}”. Folders can't be attached; pick the files inside.`);
  }
  const out = { name: a.name, size: a.size, mime: a.mime, kind: a.kind, thumb: a.thumb, data };
  const prep = a.prep ? await a.prep : null;
  if (prep && prep.asIs) out.blockData = data;
  else if (prep && prep.block) {
    out.blockData = await base64Of(prep.block);
    out.blockMime = prep.block.type;
  }
  if (out.blockData && !out.blockMime) out.blockMime = a.mime;
  return out;
}

function clearComposerExtras() {
  ui.attachments = [];
  ui.contextTabs = [];
  renderAttachments();
}

function removeAttachment(kind, id) {
  const list = $("attachList");
  const chips = [...list.querySelectorAll(".att-x")];
  const at = chips.findIndex((b) => b.dataset.key === `${kind}:${id}`);
  let name = "";
  if (kind === "tab") {
    const t = ui.contextTabs.find((x) => x.id === id);
    name = t ? t.title : "tab";
    ui.contextTabs = ui.contextTabs.filter((x) => x.id !== id);
  } else {
    const a = ui.attachments.find((x) => x.id === id);
    name = a ? a.name : "file";
    ui.attachments = ui.attachments.filter((x) => x.id !== id);
  }
  renderAttachments();
  announce(`Removed ${name}.`);
  // Keep focus in the row: the next chip's remove button, else the message box.
  const next = [...$("attachList").querySelectorAll(".att-x")];
  (next[Math.min(at, next.length - 1)] || $("input")).focus();
}

function renderAttachments() {
  const list = $("attachList");
  list.replaceChildren();
  const add = (cls, thumbNode, name, meta, key, label) => {
    const li = el("li", `att ${cls}`);
    const th = el("span", "att-thumb");
    th.append(thumbNode);
    const text = el("span", "att-text");
    text.append(el("span", "att-name", name), el("span", "att-meta", meta));
    const x = el("button", "att-x");
    SafeHTML.set(x, ICON.x);
    x.dataset.key = key;
    x.setAttribute("aria-label", `Remove ${label}`);
    x.title = "Remove";
    x.addEventListener("click", () => removeAttachment(key.slice(0, key.indexOf(":")), key.startsWith("tab:") ? Number(key.slice(4)) : key.slice(key.indexOf(":") + 1)));
    li.title = name;
    li.append(th, text, x);
    list.append(li);
  };
  for (const a of ui.attachments) {
    let thumb;
    if (a.thumb) {
      thumb = el("img");
      thumb.src = a.thumb;
      thumb.alt = "";
    } else {
      thumb = el("span", "att-icon");
      SafeHTML.set(thumb, ICON.file);
    }
    add(a.thumb ? "image" : "file", thumb, a.name, `${kindLabel(a)} · ${fmtSize(a.size)}`, `file:${a.id}`, a.name);
  }
  for (const t of ui.contextTabs) add("tab", favicon(t.favIconUrl), t.title || t.url, `Tab · ${siteOf(t.url) || "page"}`, `tab:${t.id}`, `tab ${t.title || t.url}`);
  list.hidden = !list.children.length;
  list.setAttribute("aria-label", `Attached to your next message: ${ui.attachments.length} file${ui.attachments.length === 1 ? "" : "s"}${ui.contextTabs.length ? `, ${ui.contextTabs.length} tab${ui.contextTabs.length === 1 ? "" : "s"}` : ""}`);
  updateSendState();
}

// In the transcript: what went out with a user message (kept in history).
function sentAttachments(it) {
  const ul = el("ul", "sent-att");
  ul.setAttribute("aria-label", "Attached");
  for (const a of it.attachments || []) {
    const li = el("li", `sa ${a.thumb ? "image" : "file"}${a.error ? " failed" : ""}`);
    if (a.thumb) {
      const img = el("img");
      img.src = a.thumb;
      img.alt = a.name;
      li.append(img);
      li.title = a.error ? `${a.name}: not saved (${a.error})` : a.path || a.name;
    } else {
      const ic = el("span", "att-icon");
      SafeHTML.set(ic, ICON.file);
      li.append(ic, el("span", "sa-name", a.name), el("span", "sa-meta", a.error ? "not saved" : fmtSize(a.size || 0)));
      li.title = a.error ? `Not saved: ${a.error}` : a.path || a.name;
    }
    ul.append(li);
  }
  for (const t of it.contextTabs || []) {
    const li = el("li", "sa tab");
    li.append(favicon(t.favIconUrl), el("span", "sa-name", t.title || t.url));
    li.title = t.url;
    ul.append(li);
  }
  return ul;
}

async function takeScreenshot() {
  const tab = ui.activeTab;
  if (!tab) return toast("There's no tab to capture.");
  if (ui.attachments.length >= LIMITS.files) return toast(`You can attach up to ${LIMITS.files} files to one message.`);
  try {
    const r = await request({ cmd: "screenshot", tabId: tab.id });
    const [head, b64] = r.dataUrl.split(",");
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const type = head.slice(5, head.indexOf(";"));
    const time = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
    const name = `Screenshot of ${(siteOf(r.url) || "tab").slice(0, 40)} at ${time}.${type === "image/jpeg" ? "jpg" : "png"}`;
    addFiles([new File([bytes], name, { type })], "screenshot");
  } catch (e) {
    toast(e.message);
  }
  $("input").focus();
}

// ---------- the "+" menu (WAI-ARIA menu button: arrows, Home/End, Escape)
function menuItems() {
  return [...$("attachMenu").querySelectorAll('[role="menuitem"]')].filter((b) => !b.disabled);
}
function openMenu(focusLast = false) {
  closePopovers();
  $("picker").hidden = true;
  const site = ui.activeTab ? siteOf(ui.activeTab.url) : null;
  $("miShotSub").textContent = site ? `What you see on ${site}` : "What you see right now";
  $("miShot").disabled = !ui.activeTab;
  $("attachMenu").hidden = false;
  $("btnAttach").setAttribute("aria-expanded", "true");
  const items = menuItems();
  (focusLast ? items[items.length - 1] : items[0]).focus();
}
function closeMenu(restore) {
  if ($("attachMenu").hidden) return;
  $("attachMenu").hidden = true;
  $("btnAttach").setAttribute("aria-expanded", "false");
  if (restore) $("btnAttach").focus();
}
function closePopovers() {
  closeMenu(false);
  $("tabPick").hidden = true;
}
$("attachMenu").addEventListener("keydown", (e) => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  const go = (n) => {
    e.preventDefault();
    items[(n + items.length) % items.length].focus();
  };
  if (e.key === "ArrowDown") go(i + 1);
  else if (e.key === "ArrowUp") go(i - 1);
  else if (e.key === "Home") go(0);
  else if (e.key === "End") go(items.length - 1);
  else if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeMenu(true);
  } else if (e.key === "Tab") closeMenu(false);
});
$("btnAttach").addEventListener("click", () => ($("attachMenu").hidden ? openMenu() : closeMenu(true)));
$("btnAttach").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    openMenu(e.key === "ArrowUp");
  }
});
$("miUpload").addEventListener("click", () => {
  closeMenu(false);
  $("fileInput").click();
  $("input").focus();
});
$("miShot").addEventListener("click", () => {
  closeMenu(false);
  takeScreenshot();
});
$("miTabs").addEventListener("click", () => {
  closeMenu(false);
  openTabPicker();
});
$("miRecord").addEventListener("click", () => {
  closeMenu(false);
  startRecording();
});
$("fileInput").addEventListener("change", (e) => {
  addFiles(e.target.files);
  e.target.value = "";
  $("input").focus();
});

// ---------- tab picker: tick the tabs Claude may read along with your message
async function openTabPicker() {
  closePopovers();
  const all = await browser.tabs.query(ui.windowId !== null ? { windowId: ui.windowId } : {});
  const here = ui.activeTab ? ui.activeTab.id : null;
  const tabs = all.filter((t) => t.id !== here && t.url && !t.url.startsWith(location.origin)).sort((a, b) => Number(!!a.hidden) - Number(!!b.hidden) || (b.lastAccessed || 0) - (a.lastAccessed || 0));
  const list = $("tabList");
  list.replaceChildren();
  const sync = () => {
    const n = ui.contextTabs.length;
    $("tabPickCount").textContent = n ? `${n} added` : "";
    for (const box of list.querySelectorAll("input")) box.disabled = !box.checked && n >= LIMITS.tabs;
  };
  for (const t of tabs) {
    const li = el("li");
    const label = el("label", "tab-row");
    const box = el("input");
    box.type = "checkbox";
    box.checked = ui.contextTabs.some((x) => x.id === t.id);
    box.addEventListener("change", () => {
      if (box.checked) ui.contextTabs.push({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl });
      else ui.contextTabs = ui.contextTabs.filter((x) => x.id !== t.id);
      renderAttachments();
      sync();
    });
    const text = el("span", "tab-text");
    text.append(el("span", "tab-title", t.title || t.url), el("span", "tab-site", [siteOf(t.url) || t.url.split(":")[0], t.hidden ? "other workspace" : ""].filter(Boolean).join(" · ")));
    label.append(box, favicon(t.favIconUrl), text);
    li.append(label);
    list.append(li);
  }
  if (!tabs.length) list.append(el("li", "empty-list", "No other tabs are open in this window."));
  sync();
  $("tabPick").hidden = false;
  const first = list.querySelector("input:not(:disabled)") || $("tabPickDone");
  first.focus();
}
function closeTabPicker(restore) {
  if ($("tabPick").hidden) return;
  $("tabPick").hidden = true;
  if (restore) $(restore).focus();
}
$("tabPickDone").addEventListener("click", () => closeTabPicker("input"));
$("tabPick").addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeTabPicker("btnAttach");
  } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    const boxes = [...$("tabList").querySelectorAll("input:not(:disabled)")];
    const i = boxes.indexOf(document.activeElement);
    if (i < 0) return;
    e.preventDefault();
    boxes[(i + (e.key === "ArrowDown" ? 1 : -1) + boxes.length) % boxes.length].focus();
  }
});
$("tabPick").addEventListener("focusout", (e) => {
  if (e.relatedTarget && !$("tabPick").contains(e.relatedTarget)) $("tabPick").hidden = true;
});
document.addEventListener("pointerdown", (e) => {
  for (const id of ["attachMenu", "tabPick"]) {
    if (!$(id).hidden && !$(id).contains(e.target) && !$("btnAttach").contains(e.target)) $(id).hidden = true;
  }
  if ($("attachMenu").hidden) $("btnAttach").setAttribute("aria-expanded", "false");
});

// ---------- drag and drop onto the panel, and pasting images
let dragDepth = 0;
const draggingFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes("Files") && !document.querySelector(".sheet:not([hidden])");
document.addEventListener("dragenter", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  $("dropHint").hidden = false;
});
document.addEventListener("dragover", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = "copy";
});
document.addEventListener("dragleave", (e) => {
  if (!draggingFiles(e)) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $("dropHint").hidden = true;
});
document.addEventListener("drop", (e) => {
  if (!draggingFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  $("dropHint").hidden = true;
  addFiles(e.dataTransfer.files);
  $("input").focus();
});
$("input").addEventListener("paste", (e) => {
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (!files.length || e.clipboardData.getData("text/plain")) return;
  e.preventDefault();
  const stamp = new Date().toTimeString().slice(0, 8).replace(/:/g, ".");
  addFiles(files.map((f) => (/^image\.\w+$/.test(f.name) ? new File([f], `Pasted image at ${stamp}.${f.name.split(".").pop()}`, { type: f.type }) : f)));
});

$("input").addEventListener("input", () => {
  pickerIndex = 0;
  autosize();
});
$("input").addEventListener("keydown", (e) => {
  const pickerOpen = !$("picker").hidden && pickerItems.length;
  if (pickerOpen && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
    e.preventDefault();
    movePick(e.key === "ArrowDown" ? 1 : -1);
  } else if (pickerOpen && (e.key === "Enter" || e.key === "Tab") && !e.shiftKey) {
    e.preventDefault();
    choosePick(pickerIndex);
  } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  } else if (e.key === "Escape") {
    if (!$("picker").hidden) {
      e.preventDefault();
      $("picker").hidden = true;
    } else if (ui.chat && ui.chat.running) {
      e.preventDefault();
      post({ cmd: "stop", chatId: ui.chat.id });
    }
  }
});
$("input").addEventListener("blur", () => setTimeout(() => ($("picker").hidden = true), 120));
$("btnSlash").addEventListener("click", () => {
  const t = $("input");
  if (!t.value.startsWith("/")) t.value = "/" + t.value;
  t.focus();
  autosize();
});
$("btnSend").addEventListener("click", () => send());
$("btnStop").addEventListener("click", () => ui.chat && post({ cmd: "stop", chatId: ui.chat.id }));
$("btnNew").addEventListener("click", () => post({ cmd: "new" }));
$("btnHistory").addEventListener("click", () => openSheet("historySheet"));
$("btnSettings").addEventListener("click", () => openSheet("settingsSheet"));
for (const b of document.querySelectorAll("[data-close]")) b.addEventListener("click", () => closeSheets());
$("historySearch").addEventListener("input", renderHistory);
for (const b of document.querySelectorAll(".suggestion")) b.addEventListener("click", () => send(b.dataset.prompt));
for (const id of ["model", "settingsModel"]) $(id).addEventListener("change", (e) => post({ cmd: "settings", patch: { model: e.target.value } }));
for (const r of document.querySelectorAll('input[name="mode"]')) r.addEventListener("change", () => r.checked && post({ cmd: "settings", patch: { mode: r.value } }));
$("optHighlight").addEventListener("change", (e) => post({ cmd: "settings", patch: { highlight: e.target.checked } }));
$("optGroup").addEventListener("change", (e) => post({ cmd: "settings", patch: { groupTabs: e.target.checked } }));
$("trust").addEventListener("change", (e) => post({ cmd: "siteTrust", site: $("trustWrap").dataset.site || null, trust: e.target.value }));
$("targetTab").addEventListener("click", () => {
  const id = Number($("targetTab").dataset.tabId);
  if (id) post({ cmd: "focusTab", tabId: id });
});
for (const id of ["btnReconnect", "btnReconnect2"]) $(id).addEventListener("click", () => post({ cmd: "reconnect" }));
for (const id of ["btnCopySetup", "btnCopySetup2"]) $(id).addEventListener("click", copySetup);
$("btnBrowseSkills").addEventListener("click", () => {
  closeSheets(false);
  $("input").value = "/";
  $("input").focus();
  autosize();
});
document.addEventListener("keydown", (e) => {
  if (!e.altKey || e.metaKey || e.ctrlKey) return;
  if (e.code === "KeyN") { e.preventDefault(); post({ cmd: "new" }); }
  if (e.code === "KeyH") { e.preventDefault(); openSheet("historySheet"); }
});

// ------------------------------------------------------------------ workflow recording
// You show Claude a task once: the background page records your own clicks, typing
// and navigation (content/recorder.js, workflow.js), you review the steps here, and
// the helper app saves them as a skill you run with /<name>.
const recActive = () => ui.rec.status === "recording" || ui.rec.status === "paused";
const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;

// Same rules as workflow.js, for the live "/command" preview.
function slugify(name) {
  return String(name || "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64).replace(/-+$/, "");
}

async function startRecording() {
  if (ui.chat && ui.chat.running) return toast("Wait for Claude to finish, or stop it, before you record.");
  closeSheets(false);
  try {
    await request({ cmd: "rec.start", tabId: ui.activeTab ? ui.activeTab.id : undefined, windowId: ui.windowId });
    const site = ui.activeTab ? siteOf(ui.activeTab.url) : null;
    announce(`Recording started${site ? ` on ${site}` : ""}. Do the task in the page; ccfox records your own clicks, typing and page changes. Stop when you're done.`, true);
    setTimeout(() => $("btnRecStop").focus(), 50);
  } catch (e) {
    toast(e.message);
  }
}

function onRec(rec) {
  const prev = ui.rec || { status: "idle" };
  ui.rec = rec || { status: "idle" };
  const n = (ui.rec.steps || []).length;
  if (ui.rec.status === "recording" && prev.status === "recording" && n > (prev.steps || []).length) {
    announce(`Step ${n}: ${ui.rec.steps[n - 1].text}`);
  }
  if (prev.status !== ui.rec.status) {
    if (ui.rec.status === "paused") announce("Recording paused. Nothing is recorded until you resume.", true);
    if (ui.rec.status === "recording" && prev.status === "paused") announce("Recording resumed.", true);
    if (ui.rec.status === "review") {
      announce(`Recording stopped with ${plural(n, "step")}. Review them and save.`, true);
      openSheet("reviewSheet");
    }
    if (ui.rec.status === "idle" && !$("reviewSheet").hidden) closeSheets();
  }
  renderRec();
  if (!$("reviewSheet").hidden && ui.rec.status === "review") renderReviewSteps();
}

// A button's Lucide icon plus its label; textContent stays just the label.
function iconLabel(btn, icon, label) {
  SafeHTML.set(btn, icon);
  btn.append(el("span", "", label));
}

function renderRec() {
  const r = ui.rec;
  const bar = $("recbar");
  const showBar = recActive() || (r.status === "review" && $("reviewSheet").hidden);
  bar.hidden = !showBar;
  $("composer").hidden = recActive();
  if (!showBar) return;
  const n = (r.steps || []).length;
  bar.classList.toggle("paused", r.status === "paused");
  bar.classList.toggle("review", r.status === "review");
  $("recCount").textContent = plural(n, "step");
  if (r.status === "review") {
    $("recTitle").textContent = "Recording stopped";
    $("recSub").textContent = n ? "Review the steps, then save them as a skill." : "No steps were recorded.";
  } else {
    $("recTitle").textContent = r.status === "paused" ? "Recording paused" : "Recording your steps";
    $("recSub").textContent = r.status === "paused" ? "Nothing is recorded until you resume." : "Do the task in the page. Only your own clicks, typing and page changes are recorded.";
  }
  const last = n ? r.steps[n - 1].text : "";
  $("recLast").hidden = !last || r.status === "review";
  $("recLast").replaceChildren(el("span", "", last ? `Last: ${last}` : ""));
  const pause = $("btnRecPause");
  pause.hidden = r.status === "review";
  iconLabel(pause, r.status === "paused" ? ICON.play : ICON.pause, r.status === "paused" ? "Resume" : "Pause");
  $("btnRecCancel").textContent = r.status === "review" ? "Discard" : "Cancel";
  iconLabel($("btnRecStop"), r.status === "review" ? "" : ICON.square, r.status === "review" ? "Review and save" : "Stop and review");
}

$("btnRecPause").addEventListener("click", () => post({ cmd: ui.rec.status === "paused" ? "rec.resume" : "rec.pause" }));
$("btnRecStop").addEventListener("click", () => {
  if (ui.rec.status === "review") openSheet("reviewSheet");
  else post({ cmd: "rec.stop" });
});
$("btnRecCancel").addEventListener("click", () => discardRecording());
$("btnRecord2").addEventListener("click", () => startRecording());

function discardRecording() {
  const n = (ui.rec.steps || []).length;
  post({ cmd: "rec.cancel" });
  closeSheets(false);
  $("input").focus();
  announce(n ? `Discarded the recording (${plural(n, "step")}).` : "Stopped recording.");
}

// ---------- the review sheet
let metaTimer = null;
function fillReview() {
  const m = ui.rec.meta || {};
  $("wfName").value = m.name || "";
  $("wfDesc").value = m.description || "";
  $("wfNote").value = m.note || "";
  $("wfTidy").checked = !!m.tidy;
  $("wfConflict").hidden = true;
  setNameError("");
  renderSlug();
  renderReviewSteps();
}

function renderSlug() {
  const slug = slugify($("wfName").value);
  const hint = $("wfSlug");
  hint.replaceChildren();
  if (slug) hint.append("Command: ", el("code", "", `/${slug}`));
  else hint.textContent = "Use letters or numbers; the name becomes the command.";
}

function setNameError(text) {
  $("wfNameErr").hidden = !text;
  $("wfNameErr").textContent = text;
  $("wfName").setAttribute("aria-invalid", text ? "true" : "false");
}

function saveMeta() {
  clearTimeout(metaTimer);
  metaTimer = setTimeout(() => post({ cmd: "rec.edit", op: "meta", name: $("wfName").value, description: $("wfDesc").value, note: $("wfNote").value, tidy: $("wfTidy").checked }), 250);
}
for (const id of ["wfName", "wfDesc", "wfNote"]) $(id).addEventListener("input", () => {
  if (id === "wfName") {
    renderSlug();
    setNameError("");
    $("wfConflict").hidden = true;
  }
  saveMeta();
});
$("wfTidy").addEventListener("change", saveMeta);

function renderReviewSteps() {
  const list = $("wfSteps");
  const steps = ui.rec.steps || [];
  // Keep focus on the same control across re-renders.
  const ae = document.activeElement;
  const keep = ae && list.contains(ae) ? { id: ae.closest("[data-id]")?.dataset.id, role: ae.dataset.role } : null;
  list.replaceChildren();
  $("wfStepsTitle").textContent = steps.length ? `Steps (${steps.length})` : "Steps";
  if (!steps.length) list.append(el("li", "wf-empty", "No steps were recorded. Discard this, and record again."));
  steps.forEach((s, i) => {
    const li = el("li", `wf-step${s.sensitive ? " secret" : ""}`);
    li.dataset.id = s.id;
    const body = el("div", "wf-body");
    const text = el("span", "wf-text", s.text);
    text.id = `wf-t-${s.id}`;
    body.append(text);
    if (s.sensitive) {
      const lock = el("span", "wf-lock");
      SafeHTML.set(lock, ICON.lock);
      lock.append(el("span", "", "Never stored · Claude asks you each time"));
      body.append(lock);
    } else if (s.canAsk) {
      const ask = el("button", "wf-ask");
      ask.dataset.role = "ask";
      ask.setAttribute("aria-pressed", String(!!s.ask));
      ask.setAttribute("aria-describedby", text.id);
      SafeHTML.set(ask, ICON.ask);
      ask.append(el("span", "", s.ask ? "Asks each time" : "Ask each time"));
      ask.title = s.ask ? "Claude asks you for this value each time. Click to keep the recorded value instead." : "Don't save this value; Claude asks you for it each time";
      ask.addEventListener("click", () => {
        post({ cmd: "rec.edit", op: "ask", id: s.id, ask: !s.ask });
        announce(s.ask ? "The recorded value will be saved." : "Claude will ask for this value each time.");
      });
      body.append(ask);
    }
    const del = el("button", "icon-btn");
    del.dataset.role = "del";
    SafeHTML.set(del, ICON.trash);
    del.title = "Delete this step";
    del.setAttribute("aria-label", `Delete step ${i + 1}: ${s.text}`);
    del.addEventListener("click", () => {
      const next = steps[i + 1] || steps[i - 1];
      ui.reviewFocus = next ? { id: next.id, role: "del" } : null;
      post({ cmd: "rec.edit", op: "delete", id: s.id });
      announce(`Deleted step ${i + 1}.`);
    });
    li.append(el("span", "wf-num", `${i + 1}`), body, del);
    list.append(li);
  });
  const want = ui.reviewFocus || keep;
  ui.reviewFocus = null;
  if (want) {
    const target = want.id && list.querySelector(`[data-id="${CSS.escape(want.id)}"] [data-role="${want.role || "del"}"]`);
    (target || (steps.length ? list.querySelector("[data-role=del]") : $("wfName"))).focus();
  }
}

async function saveWorkflow(overwrite = false) {
  const slug = slugify($("wfName").value);
  if (!slug) {
    setNameError("Give it a name with some letters or numbers.");
    return $("wfName").focus();
  }
  const clash = (ui.catalog.commands || []).find((c) => c.name === slug && c.builtin);
  if (clash) {
    setNameError(`/${slug} is a built-in Claude Code command. Pick another name.`);
    return $("wfName").focus();
  }
  if (!(ui.rec.steps || []).length) return toast("There are no steps to save.");
  clearTimeout(metaTimer);
  post({ cmd: "rec.edit", op: "meta", name: $("wfName").value, description: $("wfDesc").value, note: $("wfNote").value, tidy: $("wfTidy").checked });
  const btn = $("wfSave");
  btn.disabled = true;
  try {
    const r = await request({ cmd: "rec.save", overwrite });
    if (r && r.exists) {
      $("wfConflictText").textContent = r.recorded
        ? `You already have a recorded workflow called /${r.slug}. Replace it with this one?`
        : `You already have a skill called /${r.slug} that ccfox didn't record. Replacing it deletes its current instructions.`;
      $("wfConflict").hidden = false;
      announce($("wfConflictText").textContent, true);
      $("wfReplace").focus();
      return;
    }
    closeSheets(false);
    if (r.tidy) {
      send(`I just recorded a browser workflow and saved it as the skill /${r.slug}, in ${r.path}. Read that file and tidy it up: merge or drop redundant steps, describe elements so they're easy to find again, and turn values that will change next time into things to ask me for. Keep the frontmatter name, the privacy rules and the "How to run it" section. Don't run the workflow. Then tell me briefly what you changed.`);
      toast(`Saved /${r.slug}. Claude is tidying it up.`);
    } else {
      toast(`Saved /${r.slug} to your skills.`, "Run it now", () => {
        const t = $("input");
        t.value = `/${r.slug} `;
        t.focus();
        autosize();
        $("picker").hidden = true;
      });
      $("input").focus();
    }
    announce(`Saved the workflow as /${r.slug}.`, true);
  } catch (e) {
    toast(e.message);
  } finally {
    btn.disabled = false;
  }
}
$("wfSave").addEventListener("click", () => saveWorkflow(false));
$("wfReplace").addEventListener("click", () => saveWorkflow(true));
$("wfRename").addEventListener("click", () => {
  $("wfConflict").hidden = true;
  $("wfName").focus();
  $("wfName").select();
});
$("wfDiscard").addEventListener("click", () => discardRecording());
$("wfName").addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    saveWorkflow(false);
  }
});

// ------------------------------------------------------------------ boot
(async () => {
  try {
    const w = await browser.windows.getCurrent();
    ui.windowId = w.id;
  } catch {}
  browser.tabs.onActivated.addListener((info) => info.windowId === ui.windowId && refreshTab());
  browser.tabs.onUpdated.addListener((id, change) => {
    if (ui.activeTab && id === ui.activeTab.id && (change.title || change.url || change.favIconUrl)) refreshTab();
  });
  refreshTab();
  connectPort();
})();
