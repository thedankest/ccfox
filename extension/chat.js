// Side-panel chats. Owns chat transcripts and history, decides which tool calls need
// the user's approval, keeps the skills/commands catalog, and relays between the
// sidebar page(s) and the native host, which runs one local `claude` per chat.
"use strict";

const Chat = (() => {
  const P = "mcp__browser__";
  const READ_ONLY = new Set(["tabs_context", "read_page", "find", "get_page_text", "read_console_messages", "read_network_requests", "release_tabs"]);
  const PASSIVE_COMPUTER = new Set(["screenshot", "zoom", "wait", "scroll", "scroll_to", "hover"]);
  const RISKY_WORDS = /\b(submit|send|post|publish|pay|buy|purchase|order|checkout|delete|remove|confirm|save|merge|approve|reply|transfer|sign|accept|unsubscribe|book|cancel)\b/i;
  const MAX_ITEMS = 400;
  const CATALOG_TTL = 10 * 60 * 1000;

  const chats = new Map(); // id -> chat (loaded/active ones)
  const panels = new Set(); // connected sidebar ports
  let settings = { mode: "ask", allowedSites: [], model: "", highlight: true, groupTabs: true };
  let history = []; // [{ id, title, sessionId, site, favIconUrl, updatedAt }]
  let catalog = { commands: [], agents: [], models: [], mcpServers: [], plugins: [], pluginErrors: [], fetchedAt: 0, error: null };
  const MAX_ATTACH = 10;
  const MAX_ATTACH_BYTES = 20 * 1024 * 1024;
  const MAX_CONTEXT_TABS = 10;
  let catalogPending = null;

  // ---------------------------------------------------------------- storage
  const ready = (async () => {
    const got = await browser.storage.local.get(["settings", "history", "catalog"]);
    if (got.settings) settings = { ...settings, ...got.settings };
    if (Array.isArray(got.history)) history = got.history;
    if (got.catalog) catalog = { ...catalog, ...got.catalog, mcpFromChat: false };
  })();

  const saveTimers = new Map();
  function scheduleSave(chat) {
    clearTimeout(saveTimers.get(chat.id));
    saveTimers.set(chat.id, setTimeout(() => saveChat(chat), 600));
  }

  async function saveChat(chat) {
    saveTimers.delete(chat.id);
    const firstUser = chat.items.find((i) => i.role === "user");
    if (!firstUser) return; // don't keep empty chats
    const items = chat.items.slice(-MAX_ITEMS).map((i) => (i.role === "tool" && i.result && i.result.length > 1500 ? { ...i, result: i.result.slice(0, 1500) + "…" } : i));
    await browser.storage.local.set({ [`chat:${chat.id}`]: { id: chat.id, title: chat.title, sessionId: chat.sessionId, model: chat.model, items } });
    const tab = firstUser.tab || {};
    const entry = { id: chat.id, title: chat.title, sessionId: chat.sessionId, site: siteOf(tab.url), favIconUrl: tab.favIconUrl || null, updatedAt: Date.now() };
    history = [entry, ...history.filter((h) => h.id !== chat.id)].slice(0, 200);
    await browser.storage.local.set({ history });
    broadcast({ type: "history", history });
  }

  async function saveSettings() {
    await browser.storage.local.set({ settings });
    broadcast({ type: "settings", settings });
  }

  async function getChat(id) {
    if (chats.has(id)) return chats.get(id);
    const got = await browser.storage.local.get(`chat:${id}`);
    const stored = got[`chat:${id}`];
    const chat = {
      id,
      title: (stored && stored.title) || "New chat",
      sessionId: (stored && stored.sessionId) || null,
      model: (stored && stored.model) || "",
      items: (stored && stored.items) || [],
      running: false,
      stopping: false,
      openText: null,
      toolIndex: new Map(),
      info: null,
    };
    // Anything left pending from a previous browser session can't be answered any more.
    for (const it of chat.items) {
      if (it.role === "permission" && it.state === "pending") it.state = "expired";
      if (it.role === "tool" && it.status === "running") it.status = "interrupted";
    }
    chats.set(id, chat);
    return chat;
  }

  // ---------------------------------------------------------------- panel I/O
  function broadcast(msg) {
    for (const p of panels) {
      try {
        p.postMessage(msg);
      } catch {}
    }
  }

  async function actingTabOf(chat) {
    const id = state.currentTab.get(`chat:${chat.id}`);
    if (id === undefined) return null;
    const t = await browser.tabs.get(id).catch(() => null);
    return t ? { id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl } : null;
  }

  async function snapshot(chat) {
    return { id: chat.id, title: chat.title, sessionId: chat.sessionId, model: chat.model, items: chat.items, running: chat.running, info: chat.info, actingTab: chat.running ? await actingTabOf(chat) : null };
  }

  function pushItem(chat, item) {
    chat.items.push(item);
    const index = chat.items.length - 1;
    broadcast({ type: "item", chatId: chat.id, index, item });
    scheduleSave(chat);
    return index;
  }

  function updateItem(chat, index, patch) {
    Object.assign(chat.items[index], patch);
    broadcast({ type: "item", chatId: chat.id, index, item: chat.items[index] });
    scheduleSave(chat);
  }

  async function sendMeta(chat) {
    broadcast({ type: "meta", chatId: chat.id, running: chat.running, title: chat.title, info: chat.info, sessionId: chat.sessionId, actingTab: chat.running ? await actingTabOf(chat) : null });
  }

  function setRunning(chat, running) {
    chat.running = running;
    if (!running) {
      chat.stopping = false;
      Highlight.release(`chat:${chat.id}`);
    }
    sendMeta(chat);
  }

  function connectionInfo() {
    return {
      connected: state.connected,
      lastError: state.lastError,
      claude: state.hostInfo ? state.hostInfo.claude : null,
      hostVersion: state.hostInfo ? state.hostInfo.hostVersion : null,
      externalSessions: state.clients,
      canGroupTabs: typeof browser.tabs.group === "function",
    };
  }

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== "panel") return;
    panels.add(port);
    port.onDisconnect.addListener(() => panels.delete(port));
    port.onMessage.addListener((msg) =>
      onPanelMessage(port, msg)
        .then((result) => msg.reqId && port.postMessage({ type: "reply", reqId: msg.reqId, ok: true, result }))
        .catch((e) => port.postMessage(msg.reqId ? { type: "reply", reqId: msg.reqId, ok: false, error: String(e.message || e) } : { type: "toast", text: String(e.message || e) })),
    );
  });

  async function onPanelMessage(port, msg) {
    await ready;
    switch (msg.cmd) {
      case "hello":
        port.postMessage({ type: "state", settings, history, conn: connectionInfo(), catalog });
        port.postMessage({ type: "rec", rec: Workflow.snapshot() });
        refreshCatalog(false);
        return;
      case "open": {
        const chat = await getChat(msg.chatId);
        port.postMessage({ type: "chat", chat: await snapshot(chat) });
        return;
      }
      case "new": {
        const chat = await getChat(crypto.randomUUID());
        port.postMessage({ type: "chat", chat: await snapshot(chat) });
        return;
      }
      case "send":
        return send(msg);
      case "retry": {
        const chat = await getChat(msg.chatId);
        const last = [...chat.items].reverse().find((i) => i.role === "user");
        // Files from the first try are already on disk; the host re-attaches them by path.
        const saved = ((last && last.attachments) || []).filter((a) => a.path).map((a) => ({ path: a.path, name: a.name, mime: a.mime }));
        if (last) return send({ chatId: chat.id, text: last.text, tabId: msg.tabId, windowId: msg.windowId, retry: true, saved, contextTabs: last.contextTabs });
        return;
      }
      case "stop": {
        const chat = await getChat(msg.chatId);
        chat.stopping = true;
        send_({ type: "chat.stop", chatId: msg.chatId });
        return;
      }
      case "permission":
        return answerPermission(msg.chatId, msg.requestId, msg.decision, msg.message);
      case "settings":
        settings = { ...settings, ...msg.patch };
        if (msg.patch.highlight === false) Highlight.clearAll();
        return saveSettings();
      case "siteTrust": {
        // trust: "ask" | "site" | "auto"
        const site = msg.site;
        if (msg.trust === "auto") settings.mode = "auto";
        else {
          settings.mode = "ask";
          const has = site && settings.allowedSites.includes(site);
          if (msg.trust === "site" && site && !has) settings.allowedSites = [...settings.allowedSites, site];
          if (msg.trust === "ask" && has) settings.allowedSites = settings.allowedSites.filter((s) => s !== site);
        }
        return saveSettings();
      }
      case "removeSite":
        settings.allowedSites = settings.allowedSites.filter((s) => s !== msg.site);
        return saveSettings();
      case "delete": {
        try { send_({ type: "chat.close", chatId: msg.chatId }); } catch {}
        chats.delete(msg.chatId);
        history = history.filter((h) => h.id !== msg.chatId);
        await browser.storage.local.remove(`chat:${msg.chatId}`);
        await browser.storage.local.set({ history });
        broadcast({ type: "history", history });
        return;
      }
      case "focusTab": {
        const t = await browser.tabs.get(msg.tabId).catch(() => null);
        if (t) {
          await browser.tabs.update(t.id, { active: true });
          await browser.windows.update(t.windowId, { focused: true }).catch(() => {});
        }
        return;
      }
      case "reconnect":
        if (state.port) state.port.disconnect();
        state.port = null;
        state.retryMs = 1000;
        connect();
        return;
      case "catalog":
        return refreshCatalog(true);
      case "screenshot": {
        // The tab the user is looking at, as a PNG for the composer. capture() hides
        // the "Claude is working" overlay while it takes the picture.
        const tab = await browser.tabs.get(msg.tabId).catch(() => null);
        if (!tab) throw new Error("That tab is gone.");
        try {
          const shot = await capture(tab);
          return { dataUrl: `data:${shot.mimeType};base64,${shot.data}`, title: tab.title, url: tab.url };
        } catch (e) {
          throw new Error(`Couldn't take a screenshot of this tab. ${/Missing host permission|not allowed|Cannot access/i.test(String(e && e.message)) ? "Zen doesn't let extensions capture this kind of page." : String((e && e.message) || e)}`);
        }
      }
      default:
        // Workflow recording: rec.start, rec.stop, rec.save, ...
        if (typeof msg.cmd === "string" && msg.cmd.startsWith("rec.")) return Workflow.onPanel(msg);
        return;
    }
  }

  function send_(obj) {
    if (!state.port) throw new Error("ccfox can't reach its helper app. Use Reconnect, or run the setup command from Settings.");
    state.port.postMessage(obj);
  }

  // ---------------------------------------------------------------- catalog (skills, commands, models)
  function refreshCatalog(force) {
    if (!state.port) return;
    if (!force && catalog.fetchedAt && Date.now() - catalog.fetchedAt < CATALOG_TTL) return;
    if (catalogPending && !force) return;
    clearTimeout(catalogPending);
    catalogPending = setTimeout(() => (catalogPending = null), 30000);
    try {
      send_({ type: "catalog" });
    } catch {}
  }

  async function onCatalog(msg) {
    clearTimeout(catalogPending);
    catalogPending = null;
    if (msg.error) catalog = { ...catalog, error: msg.error };
    else if (msg.part === "plugins") {
      catalog = { ...catalog, plugins: msg.plugins || [] };
      // Statuses from a chat are fresher than this throwaway session's (still "pending").
      if (!catalog.mcpFromChat && Array.isArray(msg.mcpServers)) catalog.mcpServers = connectorsOf(msg.mcpServers);
    } else catalog = { ...catalog, commands: msg.commands || [], agents: msg.agents || [], models: msg.models || [], fetchedAt: Date.now(), error: null };
    await browser.storage.local.set({ catalog });
    broadcast({ type: "catalog", catalog });
  }

  // Connectors worth showing: not our own browser tools, and not a second copy of
  // ccfox that the user registered for Claude Code (its tools are off in panel chats).
  function connectorsOf(list) {
    return list.filter((s) => s.name !== "browser" && s.name !== "ccfox").map((s) => ({ name: s.name, status: s.status, source: s.source }));
  }

  // ---------------------------------------------------------------- sending
  async function send({ chatId, text, windowId, tabId, retry, attachments, saved, contextTabs }) {
    const chat = await getChat(chatId);
    if (chat.running) throw new Error("Claude is still working. Stop it first or wait.");
    const trimmed = String(text || "").trim();
    const files = Array.isArray(attachments) ? attachments : [];
    if (!trimmed && !files.length && !(saved && saved.length)) return;
    if (files.length > MAX_ATTACH) throw new Error(`You can attach up to ${MAX_ATTACH} files to one message.`);
    for (const f of files) if (f.size > MAX_ATTACH_BYTES) throw new Error(`“${f.name}” is too big. Files can be up to 20 MB.`);
    const shared = (Array.isArray(contextTabs) ? contextTabs : []).slice(0, MAX_CONTEXT_TABS);

    let tab = tabId !== undefined ? await browser.tabs.get(tabId).catch(() => null) : null;
    if (!tab) [tab] = await browser.tabs.query(windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
    let context = "<browser_context>\nNo tab is active.\n</browser_context>";
    if (tab) {
      state.currentTab.set(`chat:${chat.id}`, tab.id);
      Highlight.touch(tab.id, `chat:${chat.id}`); // Claude is now working with this tab
      context = `<browser_context>\nThe user is looking at tab ${tab.id}: "${tab.title || ""}" ${tab.url}\n</browser_context>`;
    }
    // Tabs the user added as context: Claude reads them with its tools and their tabId.
    const others = [];
    for (const t of shared) {
      const live = await browser.tabs.get(Number(t.id)).catch(() => null);
      if (live && (!tab || live.id !== tab.id)) others.push(live);
    }
    if (others.length) {
      const lines = others.map((t) => `- tab ${t.id}: "${(t.title || "").slice(0, 120)}" ${t.url}`).join("\n");
      context = context.replace("\n</browser_context>", `\nThe user also added ${others.length === 1 ? "this tab" : "these tabs"} as context. Read ${others.length === 1 ? "it" : "them"} with get_page_text or read_page, passing the tabId:\n${lines}\n</browser_context>`);
    }

    if (!chat.items.some((i) => i.role === "user")) chat.title = (trimmed.split("\n")[0] || (files[0] ? `About ${files[0].name}` : "New chat")).slice(0, 70);
    const refs = [];
    if (!retry) {
      const item = { role: "user", text: trimmed, tab: tab ? { title: tab.title, url: tab.url, favIconUrl: tab.favIconUrl } : null, at: Date.now() };
      if (files.length) {
        item.attachments = files.map((f) => ({ uploadId: crypto.randomUUID(), name: f.name, size: f.size, mime: f.mime, kind: f.kind, thumb: f.thumb || null }));
      }
      if (others.length) item.contextTabs = others.map((t) => ({ id: t.id, title: t.title, url: t.url, favIconUrl: t.favIconUrl || null }));
      pushItem(chat, item);
      // Each file goes to the helper on its own; the message refers to them by id.
      try {
        (item.attachments || []).forEach((a, n) => {
          const f = files[n];
          send_({ type: "chat.upload", chatId: chat.id, uploadId: a.uploadId, name: f.name, mime: f.mime, data: f.data, blockData: f.blockData || undefined, blockMime: f.blockMime || undefined });
          refs.push({ uploadId: a.uploadId, name: f.name });
        });
      } catch {}
    } else if (saved && saved.length) refs.push(...saved);
    chat.openText = null;
    setRunning(chat, true);
    // Slash commands (skills) must reach Claude Code as-is; context goes after them.
    const body = trimmed.startsWith("/") ? `${trimmed}\n\n${context}` : `${context}\n\n${trimmed}`;
    try {
      send_({ type: "chat.send", chatId: chat.id, text: body, attachments: refs.length ? refs : undefined, sessionId: chat.sessionId, model: settings.model || chat.model || "" });
    } catch (e) {
      pushItem(chat, { role: "error", title: "Couldn't reach Claude Code", text: e.message, retry: true });
      setRunning(chat, false);
    }
  }

  // ---------------------------------------------------------------- host events
  async function onHostEvent(chatId, ev) {
    await ready;
    const chat = await getChat(chatId);
    switch (ev.kind) {
      case "init":
        chat.sessionId = ev.sessionId;
        chat.info = { model: ev.model, skills: ev.skills, plugins: Array.isArray(ev.plugins) ? ev.plugins.length : ev.plugins, mcpServers: ev.mcpServers };
        if (Array.isArray(ev.mcpServers)) {
          catalog = { ...catalog, mcpServers: connectorsOf(ev.mcpServers), mcpFromChat: true };
          if (Array.isArray(ev.plugins) && !catalog.plugins.length) catalog.plugins = ev.plugins;
          if (Array.isArray(ev.pluginErrors)) catalog.pluginErrors = ev.pluginErrors;
          browser.storage.local.set({ catalog });
          broadcast({ type: "catalog", catalog });
        }
        sendMeta(chat);
        scheduleSave(chat);
        return;
      case "running":
        setRunning(chat, true);
        return;
      case "upload": {
        // The helper saved (or refused) one attached file: show where it went.
        const index = chat.items.findIndex((it) => it.role === "user" && (it.attachments || []).some((a) => a.uploadId === ev.uploadId));
        if (index < 0) return;
        const attachments = chat.items[index].attachments.map((a) => (a.uploadId === ev.uploadId ? { ...a, path: ev.path || null, error: ev.error || null } : a));
        updateItem(chat, index, { attachments });
        return;
      }
      case "text_start":
        chat.openText = null;
        return;
      case "text":
        if (chat.openText === null || !chat.items[chat.openText]) chat.openText = pushItem(chat, { role: "assistant", text: "" });
        updateItem(chat, chat.openText, { text: chat.items[chat.openText].text + ev.text });
        return;
      case "tool_use": {
        chat.openText = null;
        const index = pushItem(chat, { role: "tool", id: ev.id, name: ev.name, input: ev.input, kind: kindOf(ev.name, ev.input), summary: summarize(ev.name, ev.input), status: "running" });
        chat.toolIndex.set(ev.id, index);
        return;
      }
      case "tool_result": {
        const index = chat.toolIndex.get(ev.id);
        if (index === undefined) return;
        const item = chat.items[index];
        const denied = ev.isError && item.approval === "denied";
        const patch = { status: denied ? "denied" : ev.isError ? "error" : "done", result: ev.text };
        // Action results name the element ("Clicked button “Send”"), which beats "Click an element".
        const action = item.input && item.input.action;
        if (!ev.isError && (item.name === `${P}form_input` || (item.name === `${P}computer` && /click|hover|type|scroll_to/.test(action || "")))) {
          const t = tidy(ev.text);
          if (t && t.length < 140) patch.summary = t;
        }
        updateItem(chat, index, patch);
        sendMeta(chat); // the tab Claude acts on may have changed
        return;
      }
      case "permission":
        return onPermission(chat, ev);
      case "permission_cancel": {
        const i = chat.items.findIndex((it) => it.role === "permission" && it.requestId === ev.requestId);
        if (i >= 0 && chat.items[i].state === "pending") updateItem(chat, i, { state: "cancelled" });
        updateBadge();
        return;
      }
      case "result":
        chat.openText = null;
        if (ev.sessionId) chat.sessionId = ev.sessionId;
        if (ev.subtype === "error_during_execution" || chat.stopping) {
          pushItem(chat, { role: "note", text: chat.stopping ? "You stopped Claude." : "Claude stopped before finishing." });
        } else if (ev.isError) {
          pushItem(chat, humanError(ev.text));
        }
        expirePending(chat);
        setRunning(chat, false);
        scheduleSave(chat);
        return;
      case "error":
        pushItem(chat, humanError(ev.text));
        return;
      case "exit":
        expirePending(chat);
        for (const [, index] of chat.toolIndex) if (chat.items[index] && chat.items[index].status === "running") updateItem(chat, index, { status: "interrupted" });
        setRunning(chat, false);
        return;
      default:
        return;
    }
  }

  function humanError(raw) {
    const text = String(raw || "");
    if (/credit balance|usage limit|rate limit|quota/i.test(text)) return { role: "error", title: "You're out of Claude usage for now", text: "Claude Code reported a usage or credit limit. Try again later, or check your plan.", detail: text, retry: true };
    if (/not logged in|login|authenticate|unauthori[sz]ed|401/i.test(text)) return { role: "error", title: "Claude Code isn't signed in", text: "Run `claude` in a terminal once and sign in, then try again.", detail: text, retry: true };
    if (/couldn't find the `claude` CLI|ENOENT/i.test(text)) return { role: "error", title: "Claude Code isn't installed", text: "Install Claude Code, then run the setup command from Settings.", detail: text };
    return { role: "error", title: "Claude Code stopped", text: "Something went wrong while Claude was working.", detail: text, retry: true };
  }

  function expirePending(chat) {
    chat.items.forEach((it, i) => {
      if (it.role === "permission" && it.state === "pending") updateItem(chat, i, { state: "expired" });
    });
    updateBadge();
  }

  // ---------------------------------------------------------------- permissions
  function siteOf(url) {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.hostname : null;
    } catch {
      return null;
    }
  }

  async function targetTab(chat, input) {
    let tabId = input.tabId;
    if (tabId === undefined) tabId = state.currentTab.get(`chat:${chat.id}`);
    if (tabId !== undefined) return browser.tabs.get(tabId).catch(() => null);
    return (await browser.tabs.query({ active: true, lastFocusedWindow: true }))[0] || null;
  }

  async function targetSite(chat, name, input) {
    if ((name === "navigate" && !["back", "forward", "reload"].includes(input.url)) || (name === "tabs_create" && input.url)) {
      const raw = /^[a-z][a-z0-9+.-]*:/i.test(input.url) ? input.url : `https://${input.url}`;
      return { site: siteOf(raw), favIconUrl: null };
    }
    if (name === "tabs_create") return { site: null, favIconUrl: null };
    const tab = await targetTab(chat, input);
    return { site: tab ? siteOf(tab.url) : null, favIconUrl: tab ? tab.favIconUrl : null };
  }

  async function describeTarget(chat, name, input) {
    if (name !== "computer" && name !== "form_input") return null;
    const tab = await targetTab(chat, input);
    if (!tab) return null;
    try {
      if (input.ref) return tidy((await agent(tab.id, "describe", { ref: input.ref })).text);
      if (Array.isArray(input.coordinate)) return tidy((await agent(tab.id, "describe_point", { x: input.coordinate[0], y: input.coordinate[1] })).text);
    } catch {}
    return null;
  }

  function markTool(chat, toolName, patch) {
    const idx = [...chat.toolIndex.values()].reverse().find((ti) => chat.items[ti] && chat.items[ti].status === "running" && chat.items[ti].name === toolName);
    if (idx !== undefined) updateItem(chat, idx, patch);
  }

  async function onPermission(chat, ev) {
    const isBrowser = ev.toolName.startsWith(P);
    const name = ev.toolName.replace(P, "");
    const input = ev.input || {};
    let where = { site: null, favIconUrl: null };
    let auto = false;
    if (isBrowser) {
      if (READ_ONLY.has(name) || (name === "computer" && PASSIVE_COMPUTER.has(input.action)) || name === "tabs_select") auto = true;
      else {
        where = await targetSite(chat, name, input);
        if (settings.mode === "auto") auto = true;
        else if (where.site && settings.allowedSites.includes(where.site)) auto = true;
      }
    }
    if (auto) {
      send_({ type: "chat.permission", chatId: chat.id, requestId: ev.requestId, behavior: "allow", updatedInput: input });
      return;
    }
    // Keep the tab Claude wants to act on highlighted while it waits for you.
    if (isBrowser && name !== "navigate" && name !== "tabs_create") {
      const t = await targetTab(chat, input);
      if (t) Highlight.touch(t.id, `chat:${chat.id}`);
    }
    const target = isBrowser ? await describeTarget(chat, name, input) : null;
    if (target) markTool(chat, ev.toolName, { summary: summarize(ev.toolName, input, target) });
    const summary = summarize(ev.toolName, input, target);
    pushItem(chat, {
      role: "permission",
      requestId: ev.requestId,
      toolName: ev.toolName,
      input,
      tier: !isBrowser ? "system" : RISKY_WORDS.test(`${target || ""} ${input.text || ""} ${input.value || ""}`) || (name === "computer" && input.action === "key" && /enter/i.test(input.text || "")) ? "commit" : "page",
      site: where.site,
      favIconUrl: where.favIconUrl,
      summary,
      command: !isBrowser && ev.toolName === "Bash" ? String(input.command || "") : null,
      detail: !isBrowser && ev.toolName !== "Bash" ? detailFor(ev.toolName, input, ev.description) : null,
      cwd: !isBrowser ? "~/.ccfox/workspace" : null,
      state: "pending",
      at: Date.now(),
    });
    updateBadge();
  }

  async function answerPermission(chatId, requestId, decision, message) {
    const chat = await getChat(chatId);
    const i = chat.items.findIndex((it) => it.role === "permission" && it.requestId === requestId);
    if (i < 0 || chat.items[i].state !== "pending") return;
    const item = chat.items[i];
    const allow = decision === "once" || decision === "site";
    if (decision === "site" && item.site && !settings.allowedSites.includes(item.site)) {
      settings.allowedSites = [...settings.allowedSites, item.site];
      await saveSettings();
    }
    updateItem(chat, i, { state: allow ? (decision === "site" ? "allowed-site" : "allowed") : "denied" });
    markTool(chat, item.toolName, allow ? { approval: decision === "site" ? "site" : "once", approvalSite: item.site } : { approval: "denied", status: "denied" });
    if (message) pushItem(chat, { role: "user", text: message, at: Date.now() });
    send_({
      type: "chat.permission",
      chatId,
      requestId,
      behavior: allow ? "allow" : "deny",
      updatedInput: allow ? item.input || {} : undefined,
      message: allow ? undefined : message ? `The user denied this action and said: ${message}` : "The user denied this action in the ccfox panel. Don't retry it; ask the user how to proceed.",
    });
    updateBadge();
  }

  // ---------------------------------------------------------------- summaries
  const clip = (s, n) => {
    s = String(s ?? "");
    return s.length > n ? s.slice(0, n - 1) + "…" : s;
  };
  // 'Clicked button "Send" [ref_3] at (53, 88).' -> 'Clicked button “Send”'
  const tidy = (s) =>
    String(s || "")
      .split("\n")[0]
      .replace(/\s*\[ref_\d+\]/g, "")
      .replace(/\s+at \(\d+, \d+\)/, "")
      .replace(/\.$/, "")
      .replace(/"([^"]*)"/g, "“$1”");

  function kindOf(toolName, input = {}) {
    if (!toolName.startsWith(P)) return /^(Read|Glob|Grep|WebSearch|WebFetch|Skill|TodoWrite|Task)$/.test(toolName) ? "read" : "system";
    const name = toolName.replace(P, "");
    if (READ_ONLY.has(name) || name === "tabs_select") return "read";
    if (name === "computer" && PASSIVE_COMPUTER.has(input.action)) return "read";
    return "act";
  }

  function summarize(toolName, input = {}, target) {
    const name = toolName.replace(P, "");
    const what = target ? tidy(target).replace(/^\w+\s/, (m) => (/^(button|link|textbox|checkbox|radio|combobox|searchbox|clickable|menuitem|tab|option|img)\s$/.test(m) ? "" : m)) : null;
    if (!toolName.startsWith(P)) {
      if (toolName === "Bash") return `Run a command on your Mac`;
      const arg = input.file_path || input.url || input.query || input.pattern || input.skill || input.description || "";
      const pretty = toolName.replace(/^mcp__(.+?)__/, "$1 · ").replace(/_/g, " ");
      return `${pretty}${arg ? ": " + clip(arg, 70) : ""}`;
    }
    switch (name) {
      case "navigate":
        return ["back", "forward", "reload"].includes(input.url) ? { back: "Go back", forward: "Go forward", reload: "Reload the page" }[input.url] : `Open ${clip(String(input.url).replace(/^https?:\/\//, ""), 70)}`;
      case "tabs_create": return input.url ? `Open a new tab: ${clip(String(input.url).replace(/^https?:\/\//, ""), 60)}` : "Open a new tab";
      case "tabs_select": return "Switch tabs";
      case "tabs_close": return "Close a tab";
      case "tabs_context": return "Look at your tabs";
      case "read_page": return "Read the page";
      case "find": return `Look for “${clip(input.query, 40)}”`;
      case "get_page_text": return "Read the page text";
      case "javascript_exec": return "Run a script in the page";
      case "read_console_messages": return "Read the console";
      case "read_network_requests": return "Read network requests";
      case "resize_window": return `Resize the window to ${input.width}×${input.height}`;
      case "release_tabs": return "Let go of its tabs";
      case "form_input": return `Fill ${what || "a field"} with “${clip(Array.isArray(input.value) ? input.value.join(", ") : input.value, 50)}”`;
      case "computer":
        switch (input.action) {
          case "screenshot": return "Take a screenshot";
          case "zoom": return "Zoom into part of the page";
          case "left_click": return `Click ${what || "an element"}`;
          case "double_click": return `Double-click ${what || "an element"}`;
          case "triple_click": return `Select text in ${what || "an element"}`;
          case "right_click": return `Right-click ${what || "an element"}`;
          case "middle_click": return `Middle-click ${what || "an element"}`;
          case "hover": return `Hover over ${what || "an element"}`;
          case "type": return `Type “${clip(input.text, 60)}”`;
          case "key": return `Press ${clip(input.text, 40)}`;
          case "scroll": return `Scroll ${input.scroll_direction || "down"}`;
          case "scroll_to": return `Scroll to ${what || "an element"}`;
          case "left_click_drag": return "Drag on the page";
          case "wait": return `Wait ${input.duration || 1}s`;
          default: return input.action || "Use the browser";
        }
      default:
        return name.replace(/_/g, " ");
    }
  }

  function detailFor(toolName, input, description) {
    if ((toolName === "Write" || toolName === "Edit") && input.file_path) return input.file_path;
    const json = JSON.stringify(input, null, 2);
    return (description ? description + "\n" : "") + clip(json, 1200);
  }

  // ---------------------------------------------------------------- misc
  function pendingApprovals() {
    let n = 0;
    for (const c of chats.values()) for (const it of c.items) if (it.role === "permission" && it.state === "pending") n++;
    return n;
  }

  function onConnection() {
    broadcast({ type: "conn", conn: connectionInfo() });
    if (state.connected) refreshCatalog(false);
    if (!state.connected) {
      for (const chat of chats.values()) {
        if (chat.running) {
          pushItem(chat, { role: "error", title: "Lost the connection", text: "ccfox lost its connection to the helper app while Claude was working.", retry: true });
          expirePending(chat);
          setRunning(chat, false);
        }
      }
    }
  }

  function getSettings() {
    return settings;
  }

  async function stop(chatId) {
    const chat = await getChat(chatId);
    if (!chat.running) return;
    chat.stopping = true;
    try { send_({ type: "chat.stop", chatId }); } catch {}
  }

  return { onHostEvent, onConnection, onCatalog, pendingApprovals, getSettings, stop, broadcast, refreshCatalog };
})();
