// Workflow recording: the user shows a task once in the browser, and it becomes a
// Claude Code skill (~/.claude/skills/<slug>/SKILL.md) they can run with /<slug> in
// the panel or in any Claude Code session that has the ccfox MCP server.
//
// Steps come from content/recorder.js (the user's own trusted clicks, typing, selects,
// Enter and submits in the page) and from tab and navigation events here (typed URLs,
// back/forward, reloads, tabs opened, switched and closed). Recording follows the user:
// the start tab, tabs they switch to and tabs they open. The panel reviews the steps;
// the native host writes the skill file.
"use strict";

const Workflow = (() => {
  const MAX_STEPS = 300;
  const RISKY = /\b(submit|send|post|publish|pay|buy|purchase|order|checkout|check out|delete|remove|confirm|save|merge|approve|reply|transfer|sign|accept|unsubscribe|book|cancel|place)\b/i;
  const SECRET_PARAM = /(^|[_-])(token|access_token|id_token|auth|session|sid|sig|signature|api[_-]?key|key|code|password|passwd|secret|otp|nonce|state|ticket|jwt|saml\w*)($|[_-])/i;

  let rec = null; // the recording, or null when idle
  const saves = new Map(); // reqId -> { resolve, reject, timer }
  let nextReq = 1;

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const recordable = (url) => /^(https?|file):/i.test(url || "");
  const isPanel = (url) => String(url || "").startsWith(browser.runtime.getURL(""));
  const isNewTab = (url) => !url || url === "about:blank" || url === "about:newtab" || url === "about:home";

  function cleanUrl(u) {
    try {
      const x = new URL(u);
      for (const k of [...x.searchParams.keys()]) if (SECRET_PARAM.test(k)) x.searchParams.set(k, "…");
      if (/(access_token|id_token|code)=/.test(x.hash)) x.hash = "";
      return x.href.replace(/%E2%80%A6/g, "…");
    } catch {
      return String(u || "");
    }
  }
  const siteOf = (u) => {
    try {
      return new URL(u).hostname.replace(/^www\./, "");
    } catch {
      return "";
    }
  };

  // ---------------------------------------------------------------- state for the panel
  function snapshot() {
    if (!rec) return { status: "idle" };
    return {
      status: rec.status,
      startedAt: rec.startedAt,
      meta: rec.meta,
      slug: slugify(rec.meta.name),
      sites: [...new Set(rec.steps.map((s) => siteOf(s.url)).filter(Boolean))],
      steps: rec.steps.map((s) => ({ ...s, text: stepText(s), param: s.ask ? paramName(s) : null, canAsk: canAsk(s) })),
    };
  }
  function changed() {
    if (typeof Chat !== "undefined") Chat.broadcast({ type: "rec", rec: snapshot() });
  }

  // ---------------------------------------------------------------- in-page recorder
  async function inject(tabId) {
    if (!rec || rec.status === "review") return;
    try {
      for (const file of ["/content/overlay.js", "/content/naming.js", "/content/recorder.js"]) {
        await browser.tabs.executeScript(tabId, { file, runAt: "document_start" });
      }
      await browser.tabs.sendMessage(tabId, { ccfoxRecorder: { op: "start", paused: rec.status === "paused" } }, { frameId: 0 });
    } catch {
      // about:, view-source:, reader mode, addons.mozilla.org: Zen doesn't let us in.
    }
  }
  // Commands for content/recorder.js in each followed tab; tabs without it ignore them.
  function tellTabs(cmd) {
    for (const id of rec ? rec.tabs : []) browser.tabs.sendMessage(id, { ccfoxRecorder: cmd }, { frameId: 0 }).catch(() => {});
  }
  function follow(tab) {
    if (!rec || isPanel(tab.url)) return;
    rec.tabs.add(tab.id);
    rec.tabInfo.set(tab.id, { title: tab.title || "", url: tab.url || "" });
    if (recordable(tab.url)) inject(tab.id);
  }

  // ---------------------------------------------------------------- steps
  function lastIn(tabId, kinds, withinMs) {
    for (let i = rec.steps.length - 1; i >= 0; i--) {
      const s = rec.steps[i];
      if (Date.now() - s.at > withinMs) return null;
      if (s.tabId === tabId) return kinds.includes(s.kind) ? s : null;
    }
    return null;
  }

  function addStep(step) {
    if (!rec || rec.status !== "recording") return;
    if (rec.steps.length >= MAX_STEPS) return;
    step.id = step.id || uid();
    step.at = step.at || Date.now();
    const steps = rec.steps;
    const prev = steps[steps.length - 1];
    // One step per field: typing into a field again before anything else happens only
    // updates the value recorded for it.
    if (step.kind === "type") {
      for (let i = steps.length - 1; i >= 0; i--) {
        const s = steps[i];
        if (!["type", "select", "check", "uncheck", "radio"].includes(s.kind) || s.tabId !== step.tabId || s.url !== step.url) break;
        if (s.kind === "type" && s.target.sig === step.target.sig) {
          s.value = step.value;
          s.sensitive = step.sensitive;
          if (s.sensitive) delete s.value;
          s.at = step.at;
          return changed();
        }
      }
    }
    // A select changed twice in a row: keep the final choice.
    if (step.kind === "select" && prev && prev.kind === "select" && prev.tabId === step.tabId && prev.target.sig === step.target.sig) {
      prev.value = step.value;
      return changed();
    }
    // Ticking and unticking the same box straight away cancels out.
    if ((step.kind === "check" || step.kind === "uncheck") && prev && (prev.kind === "check" || prev.kind === "uncheck") && prev.kind !== step.kind && prev.target.sig === step.target.sig && prev.tabId === step.tabId) {
      steps.pop();
      return changed();
    }
    // The same click twice within a moment (a double event) counts once.
    if (step.kind === "click" && prev && prev.kind === "click" && prev.tabId === step.tabId && prev.target.sig === step.target.sig && step.at - prev.at < 400) return;
    steps.push(step);
    changed();
  }

  function patchStep(id, patch) {
    if (!rec) return;
    const s = rec.steps.find((x) => x.id === id);
    if (!s) return;
    for (const k of ["count", "submits"]) if (k in patch) s[k] = patch[k];
    changed();
  }

  // ---------------------------------------------------------------- messages from pages
  browser.runtime.onMessage.addListener((msg, sender) => {
    if (!msg || !msg.ccfoxRec || !sender.tab) return undefined;
    const m = msg.ccfoxRec;
    if (m.type === "stop") {
      stop().then(() => browser.sidebarAction.open().catch(() => {}));
      return undefined;
    }
    if (!rec || rec.status !== "recording" || !rec.tabs.has(sender.tab.id) || (sender.frameId || 0) !== 0) return undefined;
    if (m.type === "step" && m.step && typeof m.step.kind === "string") {
      const s = m.step;
      const step = {
        id: String(s.id || uid()).slice(0, 40),
        kind: s.kind,
        tabId: sender.tab.id,
        url: cleanUrl(s.url || sender.tab.url),
        title: String(s.title || "").slice(0, 200),
        at: Date.now(),
        target: s.target ? { role: String(s.target.role || "").slice(0, 40), name: String(s.target.name || "").slice(0, 120), context: String(s.target.context || "").slice(0, 120), href: s.target.href ? cleanUrl(s.target.href) : undefined, sig: String(s.target.sig || "").slice(0, 300) } : null,
      };
      if (s.sensitive) step.sensitive = String(s.sensitive).slice(0, 40);
      else if (typeof s.value === "string") step.value = s.value.slice(0, 2000);
      for (const k of ["newTab", "multiline", "multiple"]) if (s[k]) step[k] = true;
      if (s.key) step.key = String(s.key).slice(0, 30);
      addStep(step);
    } else if (m.type === "patch") {
      patchStep(m.id, m.patch || {});
    }
    return undefined;
  });

  // ---------------------------------------------------------------- tabs and navigation
  const live = () => rec && rec.status === "recording";

  browser.webNavigation.onCommitted.addListener((d) => {
    if (!rec || rec.status === "review" || d.frameId !== 0 || !rec.tabs.has(d.tabId)) return;
    inject(d.tabId); // the new document needs the recorder (and the pill) again
    const info = rec.tabInfo.get(d.tabId) || {};
    info.url = d.url;
    rec.tabInfo.set(d.tabId, info);
    // The click that caused this may still be on its way from the old page.
    setTimeout(() => onNavigation(d), 150);
  });
  browser.webNavigation.onDOMContentLoaded.addListener((d) => {
    if (rec && rec.status !== "review" && d.frameId === 0 && rec.tabs.has(d.tabId) && recordable(d.url)) inject(d.tabId);
  });

  function onNavigation(d) {
    if (!live() || !rec.tabs.has(d.tabId) || !recordable(d.url)) return;
    const url = cleanUrl(d.url);
    const quals = d.transitionQualifiers || [];
    const hist = rec.hist.get(d.tabId) || { list: [], pos: -1 };
    rec.hist.set(d.tabId, hist);
    const push = () => {
      hist.list = hist.list.slice(0, hist.pos + 1).concat(url);
      hist.pos = hist.list.length - 1;
    };
    // Redirects: the step that led here now leads to the final address.
    if (quals.includes("server_redirect") || quals.includes("client_redirect")) {
      const s = lastIn(d.tabId, ["navigate", "open", "click", "key", "tab_open"], 8000);
      if (s) {
        if (s.kind === "click" || s.kind === "key") s.leadsTo = url;
        else s.url = url;
        hist.list[hist.pos] = url;
        return changed();
      }
    }
    // The first page of a tab opened while recording belongs to its "open a tab" step.
    const opened = rec.steps.find((s) => s.kind === "tab_open" && s.tabId === d.tabId && !s.url);
    if (opened) {
      opened.url = url;
      push();
      return changed();
    }
    if (d.transitionType === "reload") {
      if (!lastIn(d.tabId, ["click", "key", "submit"], 1500)) addStep({ kind: "reload", tabId: d.tabId, url });
      return;
    }
    const recent = lastIn(d.tabId, ["click", "key", "submit"], 5000);
    const typed = d.transitionType === "typed" || quals.includes("from_address_bar") || ["auto_bookmark", "keyword", "generated"].includes(d.transitionType);
    if (!typed && (quals.includes("forward_back") || !recent)) {
      if (hist.list[hist.pos - 1] === url) {
        hist.pos--;
        return addStep({ kind: "back", tabId: d.tabId, url });
      }
      if (hist.list[hist.pos + 1] === url) {
        hist.pos++;
        return addStep({ kind: "forward", tabId: d.tabId, url });
      }
    }
    if (recent && !typed) {
      if (!recent.leadsTo) recent.leadsTo = url;
      push();
      return changed();
    }
    push();
    addStep({ kind: "navigate", tabId: d.tabId, url });
  }

  // Single-page apps change the address without loading a page.
  browser.webNavigation.onHistoryStateUpdated.addListener((d) => {
    if (!live() || d.frameId !== 0 || !rec.tabs.has(d.tabId)) return;
    const recent = lastIn(d.tabId, ["click", "key", "submit"], 3000);
    if (recent && !recent.leadsTo) {
      recent.leadsTo = cleanUrl(d.url);
      changed();
    }
  });

  browser.tabs.onCreated.addListener((tab) => {
    if (!live() || isPanel(tab.url)) return;
    rec.createdAt.set(tab.id, Date.now());
    const opener = tab.openerTabId !== undefined ? lastIn(tab.openerTabId, ["click", "key"], 3000) : null;
    follow(tab);
    addStep({ kind: "tab_open", tabId: tab.id, url: recordable(tab.url) ? cleanUrl(tab.url) : null, fromStep: opener ? opener.id : undefined });
    rec.lastActive = tab.active ? tab.id : rec.lastActive;
  });

  browser.tabs.onActivated.addListener(async ({ tabId }) => {
    if (!rec || rec.status === "review") return;
    const tab = await browser.tabs.get(tabId).catch(() => null);
    if (!tab || isPanel(tab.url) || tabId === rec.lastActive) return;
    const fresh = Date.now() - (rec.createdAt.get(tabId) || 0) < 2000;
    const known = rec.tabs.has(tabId);
    rec.lastActive = tabId;
    follow(tab);
    if (fresh || !live()) return;
    if (!recordable(tab.url) && !isNewTab(tab.url)) return;
    addStep({ kind: "tab_switch", tabId, url: recordable(tab.url) ? cleanUrl(tab.url) : null, title: String(tab.title || "").slice(0, 200), known });
  });

  browser.tabs.onUpdated.addListener((tabId, change) => {
    if (!rec || !rec.tabs.has(tabId) || !change.title) return;
    const info = rec.tabInfo.get(tabId) || {};
    info.title = change.title;
    rec.tabInfo.set(tabId, info);
  });

  browser.tabs.onRemoved.addListener((tabId, info) => {
    if (!rec || !rec.tabs.has(tabId)) return;
    const t = rec.tabInfo.get(tabId) || {};
    rec.tabs.delete(tabId);
    if (live() && !info.isWindowClosing) addStep({ kind: "tab_close", tabId, url: recordable(t.url) ? cleanUrl(t.url) : null, title: String(t.title || "").slice(0, 200) });
  });

  // ---------------------------------------------------------------- commands from the panel
  async function start({ tabId, windowId }) {
    if (rec && rec.status !== "idle") throw new Error(rec.status === "review" ? "Save or discard the workflow you recorded first." : "Already recording.");
    let tab = tabId !== undefined ? await browser.tabs.get(tabId).catch(() => null) : null;
    if (!tab) [tab] = await browser.tabs.query(windowId ? { active: true, windowId } : { active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("There's no tab to record in.");
    rec = {
      status: "recording",
      startedAt: Date.now(),
      steps: [],
      tabs: new Set(),
      tabInfo: new Map(),
      hist: new Map(),
      createdAt: new Map(),
      lastActive: tab.id,
      meta: { name: "", description: "", note: "", tidy: false },
    };
    if (recordable(tab.url)) {
      const url = cleanUrl(tab.url);
      rec.steps.push({ id: uid(), kind: "open", tabId: tab.id, url, title: String(tab.title || "").slice(0, 200), at: Date.now() });
      rec.hist.set(tab.id, { list: [url], pos: 0 });
    }
    follow(tab);
    changed();
  }

  function pause(on) {
    if (!rec || rec.status === "review") return;
    rec.status = on ? "paused" : "recording";
    tellTabs({ op: "pause", paused: !!on });
    changed();
  }

  async function stop() {
    if (!rec || rec.status === "review") return;
    tellTabs({ op: "stop" });
    rec.status = "review";
    const first = rec.steps.find((s) => s.url);
    if (!rec.meta.name) rec.meta.name = first ? `${siteOf(first.url) || "Page"} workflow` : "Recorded workflow";
    changed();
  }

  function cancel() {
    if (!rec) return;
    tellTabs({ op: "stop" });
    rec = null;
    changed();
  }

  function edit(msg) {
    if (!rec) return;
    if (msg.op === "meta") {
      for (const k of ["name", "description", "note"]) if (typeof msg[k] === "string") rec.meta[k] = msg[k].slice(0, k === "note" ? 4000 : 200);
      if (typeof msg.tidy === "boolean") rec.meta.tidy = msg.tidy;
    } else if (msg.op === "delete") {
      rec.steps = rec.steps.filter((s) => s.id !== msg.id);
    } else if (msg.op === "ask") {
      const s = rec.steps.find((x) => x.id === msg.id);
      if (s && canAsk(s)) s.ask = !!msg.ask;
    }
    changed();
  }

  async function save({ overwrite }) {
    if (!rec || rec.status !== "review") throw new Error("There's no recorded workflow to save.");
    if (!rec.steps.length) throw new Error("This workflow has no steps. Record it again, or discard it.");
    const slug = slugify(rec.meta.name);
    if (!slug) throw new Error("Give the workflow a name with some letters or numbers.");
    const content = buildSkill(rec, slug);
    const reply = await askHost({ type: "skill.save", slug, content, overwrite: !!overwrite });
    if (!reply.ok) {
      if (reply.exists) return { exists: true, recorded: !!reply.recorded, slug };
      throw new Error(reply.error || "Couldn't save the skill.");
    }
    const tidy = rec.meta.tidy;
    tellTabs({ op: "stop" });
    rec = null;
    changed();
    if (typeof Chat !== "undefined") Chat.refreshCatalog(true);
    return { ok: true, slug, path: reply.path, tidy };
  }

  function askHost(msg) {
    return new Promise((resolve, reject) => {
      if (!state.port) return reject(new Error("ccfox can't reach its helper app, which writes the skill file. Use Reconnect, or run the setup command from Settings."));
      const reqId = `s${nextReq++}`;
      const timer = setTimeout(() => saves.delete(reqId) && reject(new Error("The helper app didn't answer. Run the setup command from Settings to update it.")), 10000);
      saves.set(reqId, { resolve, reject, timer });
      state.port.postMessage({ ...msg, reqId });
    });
  }
  function onHostReply(msg) {
    const w = saves.get(msg.reqId);
    if (!w) return;
    saves.delete(msg.reqId);
    clearTimeout(w.timer);
    w.resolve(msg);
  }

  async function onPanel(msg) {
    switch (msg.cmd) {
      case "rec.start": return start(msg);
      case "rec.pause": return pause(true);
      case "rec.resume": return pause(false);
      case "rec.stop": return stop();
      case "rec.cancel": return cancel();
      case "rec.edit": return edit(msg);
      case "rec.save": return save(msg);
      default: return undefined;
    }
  }

  // ---------------------------------------------------------------- words
  const ROLE_WORDS = {
    button: "button", link: "link", textbox: "field", searchbox: "search field", combobox: "list", listbox: "list",
    checkbox: "checkbox", radio: "option", switch: "switch", tab: "tab", menuitem: "menu item", menuitemcheckbox: "menu item",
    menuitemradio: "menu item", option: "option", treeitem: "item", gridcell: "cell", spinbutton: "number field", slider: "slider",
    clickable: "element", img: "image", form: "form", heading: "heading", cell: "cell", row: "row",
  };
  const q = (s) => `“${String(s).replace(/[“”]/g, '"')}”`;
  function what(t) {
    if (!t) return "the element";
    const word = ROLE_WORDS[t.role] || t.role || "element";
    return `the ${word}${t.name ? ` ${q(t.name)}` : ""}${t.context ? ` ${t.context}` : ""}`;
  }
  const shortenUrl = (u) => String(u || "").replace(/^https?:\/\//, "").replace(/\/$/, "");
  const clipText = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  const canAsk = (s) => (s.kind === "type" && !s.sensitive) || s.kind === "select";
  function paramName(s) {
    const n = (s.target && s.target.name) || "";
    return n ? n.replace(/[:*]+$/, "").trim() : s.kind === "select" ? "choice" : "value";
  }

  // One plain-language line per step, used in the review sheet and the skill.
  function stepText(s, full = false) {
    const val = (v) => q(full ? v : clipText(String(v), 120));
    const shortUrl = (u) => (full ? String(u || "") : shortenUrl(u)); // the skill keeps the scheme
    switch (s.kind) {
      case "open": return `Start on ${shortUrl(s.url)}${s.title ? ` (${q(clipText(s.title, 80))})` : ""}`;
      case "navigate": return `Go to ${shortUrl(s.url)}`;
      case "back": return `Go back to ${shortUrl(s.url)}`;
      case "forward": return `Go forward to ${shortUrl(s.url)}`;
      case "reload": return "Reload the page";
      case "tab_open": return `Open a new tab${s.url ? ` at ${shortUrl(s.url)}` : ""}${s.fromStep ? " (the previous step opened it)" : ""}`;
      case "tab_switch": return `Switch to the tab ${s.title ? q(clipText(s.title, 80)) : ""}${s.url ? ` (${shortUrl(s.url)})` : " (a new tab)"}`.replace("tab  (", "tab (");
      case "tab_close": return `Close the tab ${s.title ? q(clipText(s.title, 80)) : ""}`.trim();
      case "click": {
        const verb = s.count >= 3 ? "Triple-click" : s.count === 2 ? "Double-click" : "Click";
        let t = `${verb} ${what(s.target)}`;
        if (s.submits) t += " to submit the form";
        if (s.newTab) t += " (it opens in a new tab)";
        else if (s.leadsTo && s.leadsTo !== s.url) t += `; it goes to ${shortUrl(s.leadsTo)}`;
        return t;
      }
      case "type":
        if (s.sensitive) return `The user enters their ${s.sensitive} in ${what(s.target)} (ask the user; never stored)`;
        if (s.ask) return `Type the user's ${q(paramName(s))} into ${what(s.target)} (ask each time)`;
        if (!s.value) return `Clear ${what(s.target)}`;
        return `Type ${val(s.value)} into ${what(s.target)}`;
      case "select":
        if (s.ask) return `Choose the user's ${q(paramName(s))} in ${what(s.target)} (ask each time)`;
        return `Choose ${val(s.value)} in ${what(s.target)}`;
      case "check": return `Tick ${what(s.target)}`;
      case "uncheck": return `Untick ${what(s.target)}`;
      case "radio": return `Choose ${what(s.target)}`;
      case "file": return `Pick a file for ${what(s.target)} (ask the user which file; they choose it themselves)`;
      case "key": {
        let t = `Press ${s.key || "Enter"} in ${what(s.target)}`;
        if (s.submits) t += " to submit the form";
        else if (s.leadsTo && s.leadsTo !== s.url) t += `; it goes to ${shortUrl(s.leadsTo)}`;
        return t;
      }
      case "submit": return `Submit the form${s.target && s.target.name ? ` ${q(s.target.name)}` : ""}`;
      default: return s.kind;
    }
  }

  function risky(s) {
    if (s.submits || s.kind === "submit") return true;
    if (s.kind === "click" && s.target && RISKY.test(`${s.target.name} ${s.target.context}`)) return true;
    return false;
  }

  // ---------------------------------------------------------------- the skill file
  function slugify(name) {
    return String(name || "")
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64)
      .replace(/-+$/, "");
  }

  const oneLine = (s) => String(s || "").replace(/[\r\n]+/g, " ").replace(/[<>]/g, "").replace(/\s+/g, " ").trim();

  function buildSkill(r, slug) {
    const steps = r.steps;
    const sites = [...new Set(steps.map((s) => siteOf(s.url)).filter(Boolean))];
    const title = oneLine(r.meta.name) || slug;
    const description = clipText(oneLine(r.meta.description) || `Repeat “${title}”, a workflow the user recorded in the browser${sites.length ? ` on ${sites.slice(0, 3).join(", ")}` : ""}`, 300);
    const params = [];
    const seen = new Map();
    for (const s of steps) {
      if (!s.ask || !canAsk(s)) continue;
      let p = paramName(s);
      const n = (seen.get(p) || 0) + 1;
      seen.set(p, n);
      if (n > 1) p = `${p} ${n}`;
      s._param = p;
      params.push(p);
    }
    const secrets = steps.filter((s) => s.kind === "type" && s.sensitive);
    const files = steps.filter((s) => s.kind === "file");

    const fm = ["---", `name: ${slug}`, `description: ${JSON.stringify(description)}`, "disable-model-invocation: true"];
    if (params.length) fm.push(`argument-hint: ${JSON.stringify(params.map((p) => `[${p.toLowerCase().replace(/\s+/g, "-")}]`).join(" "))}`);
    fm.push("---", "");

    const out = [...fm, `# ${title}`, ""];
    out.push(`The user recorded this workflow in the browser with ccfox: they did the task once by hand and these are the steps they took${sites.length ? `, on ${sites.join(", ")}` : ""}. Repeat it for them in their browser.`, "");
    out.push("## Goal", "", description.replace(/\.?$/, "."), "");
    const note = String(r.meta.note || "").trim();
    if (note) out.push("## Notes from the user", "", note.replace(/^#/gm, "\\#"), "");

    if (params.length || secrets.length || files.length) {
      out.push("## Ask the user for", "");
      if (params.length) out.push("Before you start, ask for these values, unless the user gave them with the command:");
      steps.forEach((s, i) => {
        if (s._param) out.push(`- **${s._param}** (step ${i + 1})`);
      });
      for (const s of secrets) out.push(`- Their ${s.sensitive} (step ${steps.indexOf(s) + 1}): never stored. Ask the user to type it into the page themselves; never ask them to tell it to you, and never type it.`);
      for (const s of files) out.push(`- Which file to use (step ${steps.indexOf(s) + 1}); the user picks it in the file dialog themselves.`);
      out.push("");
    }

    out.push("## Steps", "");
    let page = null;
    steps.forEach((s, i) => {
      let line = stepText(s, true);
      if (s.kind === "type" && s.ask) line = `Type the user's ${q(s._param)} into ${what(s.target)}`;
      if (s.kind === "select" && s.ask) line = `Choose the user's ${q(s._param)} in ${what(s.target)}`;
      if (s.kind === "type" && !s.ask && !s.sensitive && s.value && (s.multiline || s.value.includes("\n") || s.value.length > 120)) {
        line = `Type this into ${what(s.target)}:\n\n${s.value.split("\n").map((l) => `   > ${l}`).join("\n")}\n`;
      }
      const onPage = s.url && !["open", "navigate", "back", "forward", "tab_open", "tab_switch", "tab_close"].includes(s.kind) && s.url !== page;
      if (onPage) line += ` (on ${s.url})`;
      if (s.url) page = s.leadsTo || s.url;
      if (risky(s)) line += ". **Confirm with the user before this step.**";
      out.push(`${i + 1}. ${line}`);
    });
    out.push("");

    out.push(
      "## How to run it",
      "",
      "- Use the browser tools: `mcp__browser__*` in the ccfox side panel, `mcp__ccfox__*` in Claude Code. They have the same names (tabs_context, tabs_create, navigate, find, read_page, get_page_text, computer, form_input).",
      "- Start with tabs_context. Work in the tab the user is on if it already shows the start page; otherwise open the start page with tabs_create.",
      "- Find each element by its role and name (find, read_page) rather than by position, and check the page after each step.",
      "- The site may have changed since the recording. If a step no longer fits (a renamed button, a moved field, an extra dialog), adapt to reach the same result and tell the user what differed. If you can't tell what to do, stop and ask.",
      "- Before anything that submits, pays, sends, posts, books or deletes, confirm with the user first, even though the recording did it.",
      "- Never type passwords, card numbers or one-time codes; ask the user to enter them in the page.",
      "- When you're done, say what you did and anything that went differently from the recording.",
      "",
    );
    for (const s of steps) delete s._param;
    return out.join("\n");
  }

  // For tests and debugging.
  const debug = () => (rec ? { status: rec.status, tabs: [...rec.tabs], steps: rec.steps } : null);

  return { onPanel, onHostReply, snapshot, slugify, buildSkill, debug };
})();
