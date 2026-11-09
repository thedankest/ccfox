// Fake WebExtension `browser` API for previewing the side panel outside Zen.
// ?state=empty|conversation|approval|commit|bash|running|error|history|settings|picker|agents|
//        attachments|menu|tabs|drop|auto|disconnected|recording|paused|review|conflict
"use strict";

(() => {
  const params = new URLSearchParams(location.search);
  const stateName = params.get("state") || "conversation";

  const tab = { id: 5, windowId: 1, active: true, title: "Pull requests · acme/storefront", url: "https://github.com/acme/storefront/pulls", favIconUrl: "https://github.githubassets.com/favicons/favicon.svg", lastAccessed: Date.now() };
  const prTab = { id: 9, title: "Rewrite cart pricing by mira · Pull Request #479", url: "https://github.com/acme/storefront/pull/479/files", favIconUrl: tab.favIconUrl };
  const settings = { mode: stateName === "auto" ? "auto" : "ask", allowedSites: ["localhost", "linear.app"], model: "", highlight: true, groupTabs: true };
  const history = [
    { id: "c1", title: "Summarize the open pull requests and flag anything risky", site: "github.com", favIconUrl: tab.favIconUrl, updatedAt: Date.now() - 4 * 60e3 },
    { id: "c2", title: "Check the checkout page for console errors", site: "localhost", updatedAt: Date.now() - 3 * 3600e3 },
    { id: "c3", title: "Fill in the expense report from the receipts tab", site: "expensify.com", updatedAt: Date.now() - 26 * 3600e3 },
    { id: "c4", title: "Compare pricing on the three hosting providers I have open", site: "vercel.com", updatedAt: Date.now() - 4 * 86400e3 },
  ];
  const conn = { connected: stateName !== "disconnected", lastError: stateName === "disconnected" ? "No such native application ccfox" : null, claude: "/Users/you/.local/bin/claude", hostVersion: "0.6.0", externalSessions: 1, canGroupTabs: true };
  const skill = (name, description, argumentHint = "", builtin = false) => ({ name, description, argumentHint, builtin });
  const catalog = {
    commands: [
      skill("summarize", "Summarize the current page into key points (user)"),
      skill("fill-expenses", "Fill the expense form from receipts in other tabs (user)"),
      skill("release-notes", "Draft release notes from merged pull requests (project)"),
      skill("code-review:review", "Review a pull request for bugs and risky changes (code-review)", "[PR]"),
      skill("test-kit:research", "(test-kit) Investigate a question against primary sources and write findings to a file"),
      skill("test-kit:tdd", "(test-kit) Test-driven development: red, green, refactor"),
      skill("test-kit:grill-me", "(test-kit) A relentless interview to sharpen a plan or design"),
      skill("design-kit:critique", "Critique a page's layout, typography and accessibility"),
      skill("pdf", "Read, merge, split or fill PDF files (claude.ai sync)"),
      skill("xlsx", "Open, clean up or build spreadsheets (claude.ai sync)"),
      skill("compact", "Free up context by summarizing the conversation so far", "", true),
      skill("context", "Show current context usage", "", true),
      skill("model", "Set the AI model for Claude Code", "[model]", true),
      skill("security-review", "Complete a security review of the pending changes on the current branch", "", true),
    ],
    agents: [
      { name: "Explore", description: "Fast read-only search agent for sweeping many files or pages" },
      { name: "general-purpose", description: "General-purpose agent for multi-step research and tasks" },
      { name: "source-checker", description: "Checks the sources behind a draft: metadata, claims, gaps" },
      { name: "design-kit:reviewer", description: "Reviews a finished page against its design brief" },
    ],
    plugins: [
      { name: "code-review", version: "1.2.0", source: "code-review@claude-plugins-official" },
      { name: "test-kit", version: "1.3.1", source: "test-kit@marketplace" },
      { name: "design-kit", version: "1.2.0", source: "design-kit@marketplace" },
      { name: "reading-list", version: "0.1.0", source: "reading-list@marketplace" },
    ],
    pluginErrors: [{ plugin: "reading-list@marketplace", type: "hook-load-failed", message: "hooks/hooks.json: unknown event \"BeforeRead\"" }],
    models: [
      { value: "default", displayName: "Default (recommended)", description: "Opus 5.5 · Best for everyday, complex tasks" },
      { value: "opus", displayName: "Opus", description: "Opus 5.5" },
      { value: "sonnet", displayName: "Sonnet", description: "Sonnet 5.5" },
      { value: "haiku", displayName: "Haiku", description: "Haiku 5.5 · Fastest" },
    ],
    mcpServers: [{ name: "linear", status: "connected" }, { name: "claude.ai Gmail", status: "connected" }, { name: "plugin:reading-list:library", status: "connected" }, { name: "figma", status: "failed" }, { name: "claude.ai Google Drive", status: "needs-auth" }],
  };
  const otherTabs = [
    { id: 11, windowId: 1, title: "Q3 hosting quote · Vercel", url: "https://vercel.com/pricing", favIconUrl: "", lastAccessed: Date.now() - 60e3 },
    { id: 12, windowId: 1, title: "Cart pricing spec (draft) – Google Docs", url: "https://docs.google.com/document/d/1x", favIconUrl: "", lastAccessed: Date.now() - 5 * 60e3 },
    { id: 13, windowId: 1, title: "storefront / checkout errors – Sentry", url: "https://sentry.io/organizations/acme/issues/", favIconUrl: "", lastAccessed: Date.now() - 9 * 60e3 },
    { id: 14, windowId: 1, hidden: true, title: "Inbox (3) – mira@acme.dev", url: "https://mail.google.com/mail/u/0/", favIconUrl: "", lastAccessed: Date.now() - 30 * 60e3 },
  ];
  // A tiny receipt-like thumbnail (SVG data URL) for the attachment states.
  const thumb = (bg, fg) => "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect width="60" height="60" fill="${bg}"/><rect x="12" y="10" width="36" height="42" rx="3" fill="#fff"/><path d="M18 20h24M18 27h18M18 34h22M18 41h12" stroke="${fg}" stroke-width="3"/></svg>`);

  const userMsg = (text, t = tab) => ({ role: "user", text, tab: { title: t.title, url: t.url, favIconUrl: t.favIconUrl }, at: Date.now() });
  const step = (name, kind, summary, status = "done", extra = {}) => ({ role: "tool", id: Math.random().toString(36).slice(2), name, kind, summary, status, result: "", input: {}, ...extra });

  const base = [
    userMsg("Summarize the open pull requests and flag anything risky."),
    step("mcp__browser__get_page_text", "read", "Read the page text", "done", { result: "Title: Pull requests · acme/storefront\nURL: https://github.com/acme/storefront/pulls\n\n7 Open  142 Closed\nBump vite from 5.4.2 to 5.4.11 #482 opened 2 days ago by dependabot\n…" }),
    step("mcp__browser__find", "read", "Look for “label”", "done", { result: "- link “dependencies”\n- link “needs-review”" }),
    {
      role: "assistant",
      text:
        "There are **7 open pull requests**. Five are routine; two deserve a closer look:\n\n" +
        "1. **#479 Rewrite cart pricing** by @mira touches `pricing.ts` and the tax tables, and changes no tests. Highest risk.\n" +
        "2. **#476 Drop legacy session cookies** will sign out anyone still on the old cookie format.\n\n" +
        "The rest are Dependabot bumps (vite, eslint, @types/node) with passing checks. Want me to approve those three?",
    },
  ];
  const approveRun = [
    userMsg("Yes, approve the Dependabot ones."),
    step("mcp__browser__navigate", "act", "Open github.com/acme/storefront/pull/482"),
    step("mcp__browser__computer", "act", "Clicked button “Review changes”", "done", { approval: "site", approvalSite: "github.com" }),
    step("mcp__browser__computer", "act", "Clicked radio “Approve”"),
    step("mcp__browser__computer", "act", "Clicked button “Submit review”", "done", { approval: "once" }),
  ];
  const bashCmd = "git -C ~/code/storefront fetch origin pull/479/head:pr-479 && git -C ~/code/storefront checkout pr-479 && npm --prefix ~/code/storefront test";

  const chats = {
    empty: [],
    conversation: [...base, ...approveRun, { role: "assistant", text: "Approved **#482** (vite 5.4.11). Moving on to #481 and #480." }],
    approval: [...base, userMsg("Yes, approve the Dependabot ones."), step("mcp__browser__navigate", "act", "Open github.com/acme/storefront/pull/482"), step("mcp__browser__computer", "act", "Click “Review changes”", "running"),
      { role: "permission", requestId: "r1", toolName: "mcp__browser__computer", tier: "page", site: "github.com", favIconUrl: tab.favIconUrl, summary: "Click “Review changes”", state: "pending" }],
    commit: [...base, ...approveRun.slice(0, 4), step("mcp__browser__computer", "act", "Click “Submit review”", "running"),
      { role: "permission", requestId: "r4", toolName: "mcp__browser__computer", tier: "commit", site: "github.com", favIconUrl: tab.favIconUrl, summary: "Click button “Submit review”", state: "pending" }],
    bash: [...base, userMsg("Pull #479 locally and run its tests."), step("Bash", "system", "Run a command on your Mac", "running", { input: { command: bashCmd } }),
      { role: "permission", requestId: "r2", toolName: "Bash", tier: "system", site: null, summary: "Run a command on your Mac", command: bashCmd, cwd: "~/.ccfox/workspace", state: "pending" }],
    running: [...base, userMsg("Open #479 and list every file it changes."), step("mcp__browser__navigate", "act", "Open github.com/acme/storefront/pull/479/files"), step("mcp__browser__read_page", "read", "Read the page", "running")],
    attachments: [
      ...base,
      {
        ...userMsg("These are this month's receipts. Fill the expense report with them and use the travel policy in the other tab."),
        attachments: [
          { name: "uber-0412.png", size: 284000, mime: "image/png", kind: "image", thumb: thumb("#e8eef8", "#7b8aa3"), path: "~/.ccfox/workspace/uploads/c1/uber-0412.png" },
          { name: "hotel-folio.pdf", size: 1910000, mime: "application/pdf", kind: "file", path: "~/.ccfox/workspace/uploads/c1/hotel-folio.pdf" },
          { name: "mileage.csv", size: 2400, mime: "text/csv", kind: "file", path: "~/.ccfox/workspace/uploads/c1/mileage.csv" },
        ],
        contextTabs: [{ id: 12, title: "Travel & expense policy 2026 – Notion", url: "https://www.notion.so/acme/travel-policy", favIconUrl: "" }],
      },
      step("Read", "read", "Read: ~/.ccfox/workspace/uploads/c1/mileage.csv"),
      step("mcp__browser__get_page_text", "read", "Read the page text"),
      { role: "assistant", text: "I have all three receipts: **$38.20** (Uber, 12 Apr), **$412.00** (hotel, two nights) and **146 km** of mileage. The policy caps hotels at $220 a night, so the folio is within limits. Shall I fill in the report?" },
    ],
    error: [...base, userMsg("Open the CI logs for #479."), step("mcp__browser__computer", "act", "Click link “Details”", "denied", { approval: "denied" }),
      { role: "error", title: "You're out of Claude usage for now", text: "Claude Code reported a usage or credit limit. Try again later, or check your plan.", detail: "Error: Credit balance is too low", retry: true }],
  };
  chats.history = chats.conversation;
  chats.settings = chats.conversation;
  chats.picker = [];
  chats.agents = [];
  chats.menu = [];
  chats.tabs = [];
  chats.drop = [];
  chats.auto = chats.conversation;
  chats.disconnected = [];
  chats.recording = chats.conversation;
  chats.paused = chats.conversation;
  chats.review = chats.conversation;
  chats.conflict = chats.conversation;

  // Workflow recording: a recording in progress, and the review sheet after Stop.
  const recStep = (kind, text, extra = {}) => ({ id: Math.random().toString(36).slice(2), kind, text, url: tab.url, at: Date.now(), canAsk: kind === "type" || kind === "select", ...extra });
  const recSteps = [
    recStep("open", "Start on github.com/acme/storefront/pulls (“Pull requests · acme/storefront”)"),
    recStep("type", "Type “is:open author:app/dependabot” into the search field “Search all pull requests”", { value: "is:open author:app/dependabot" }),
    recStep("key", "Press Enter in the search field “Search all pull requests”; it goes to github.com/acme/storefront/pulls?q=is%3Aopen"),
    recStep("click", "Click the link “Bump vite from 5.4.2 to 5.4.11” under the heading “7 Open”; it goes to github.com/acme/storefront/pull/482"),
    recStep("click", "Click the button “Review changes”"),
    recStep("radio", "Choose the option “Approve” in “Review changes”"),
    recStep("type", "Type the user's “Leave a comment” into the field “Leave a comment” in the “Review changes” dialog (ask each time)", { value: "Thanks, looks good!", ask: true, param: "Leave a comment" }),
    recStep("type", "The user enters their password in the field “Password” in the “Confirm access” dialog (ask the user; never stored)", { sensitive: "password", canAsk: false }),
    recStep("click", "Click the button “Submit review” to submit the form", { submits: true }),
  ];
  const recStates = { recording: "recording", paused: "paused", review: "review", conflict: "review" };
  const rec = recStates[stateName]
    ? {
        status: recStates[stateName],
        startedAt: Date.now() - 95e3,
        meta: { name: recStates[stateName] === "review" ? "Approve Dependabot PRs" : "", description: recStates[stateName] === "review" ? "Approve the open Dependabot pull requests on acme/storefront" : "", note: "", tidy: false },
        steps: recStates[stateName] === "review" ? recSteps : recSteps.slice(0, 4),
      }
    : { status: "idle" };

  const chat = {
    id: "c1",
    title: ["empty", "disconnected", "picker", "agents", "menu", "tabs", "drop"].includes(stateName) ? "New chat" : stateName === "attachments" ? "These are this month's receipts" : history[0].title,
    sessionId: "8f1c",
    model: "",
    items: chats[stateName] || chats.conversation,
    running: ["approval", "commit", "bash", "running"].includes(stateName),
    actingTab: stateName === "running" ? prTab : null,
  };

  const noopEvent = { addListener() {}, removeListener() {} };
  const listeners = [];
  const port = {
    onMessage: { addListener: (fn) => listeners.push(fn) },
    onDisconnect: noopEvent,
    postMessage(msg) {
      const reply = (m) => setTimeout(() => listeners.forEach((fn) => fn(m)), 0);
      switch (msg.cmd) {
        case "hello":
          reply({ type: "state", settings, history, conn, catalog });
          return reply({ type: "rec", rec });
        case "rec.edit":
          if (msg.op === "delete") rec.steps = rec.steps.filter((x) => x.id !== msg.id);
          if (msg.op === "ask") {
            const st = rec.steps.find((x) => x.id === msg.id);
            if (st) st.ask = msg.ask;
          }
          if (msg.op === "meta") Object.assign(rec.meta, { name: msg.name, description: msg.description, note: msg.note, tidy: msg.tidy });
          return reply({ type: "rec", rec: { ...rec } });
        case "rec.save":
          return reply({ type: "reply", reqId: msg.reqId, ok: true, result: stateName === "conflict" && !msg.overwrite ? { exists: true, recorded: true, slug: "approve-dependabot-prs" } : { ok: true, slug: "approve-dependabot-prs", path: "~/.claude/skills/approve-dependabot-prs/SKILL.md" } });
        case "rec.pause":
        case "rec.resume":
          rec.status = msg.cmd === "rec.pause" ? "paused" : "recording";
          return reply({ type: "rec", rec: { ...rec } });
        case "rec.stop":
          rec.status = "review";
          return reply({ type: "rec", rec: { ...rec } });
        case "rec.cancel":
          return reply({ type: "rec", rec: { status: "idle" } });
        case "new":
        case "open": return reply({ type: "chat", chat });
        case "settings": Object.assign(settings, msg.patch); return reply({ type: "settings", settings });
        case "siteTrust":
          if (msg.trust === "auto") settings.mode = "auto";
          else {
            settings.mode = "ask";
            settings.allowedSites = settings.allowedSites.filter((s) => s !== msg.site);
            if (msg.trust === "site") settings.allowedSites.push(msg.site);
          }
          return reply({ type: "settings", settings });
        case "permission": {
          const i = chat.items.findIndex((it) => it.requestId === msg.requestId);
          if (i >= 0) {
            chat.items[i] = { ...chat.items[i], state: msg.decision === "deny" ? "denied" : "allowed" };
            reply({ type: "item", chatId: chat.id, index: i, item: chat.items[i] });
          }
          return;
        }
        case "screenshot": {
          const c = document.createElement("canvas");
          c.width = 640;
          c.height = 400;
          const g = c.getContext("2d");
          g.fillStyle = "#f6f8fa";
          g.fillRect(0, 0, 640, 400);
          g.fillStyle = "#24292f";
          g.font = "bold 36px system-ui";
          g.fillText("Pull requests", 32, 72);
          return reply({ type: "reply", reqId: msg.reqId, ok: true, result: { dataUrl: c.toDataURL("image/png"), title: tab.title, url: tab.url } });
        }
        default:
          if (msg.reqId) reply({ type: "reply", reqId: msg.reqId, ok: true, result: null });
          return;
      }
    },
  };

  window.browser = {
    runtime: { connect: () => port, onMessage: noopEvent },
    windows: { getCurrent: async () => ({ id: 1 }) },
    tabs: { query: async (q = {}) => (q.active ? [tab] : [tab, ...otherTabs]), get: async () => tab, onActivated: noopEvent, onUpdated: noopEvent },
  };

  window.addEventListener("load", () => {
    setTimeout(() => {
      if (stateName === "history") document.getElementById("btnHistory").click();
      if (stateName === "settings") document.getElementById("btnSettings").click();
      if (stateName === "picker" || stateName === "agents") {
        const t = document.getElementById("input");
        t.value = stateName === "agents" ? "Ask @" : "/";
        t.focus();
        t.dispatchEvent(new Event("input"));
      }
      // Composer with things attached: two files, a screenshot-like image, a tab.
      const seed = () => {
        const png = (w, h, color) => new Promise((res) => {
          const c = document.createElement("canvas");
          c.width = w;
          c.height = h;
          const g = c.getContext("2d");
          g.fillStyle = color;
          g.fillRect(0, 0, w, h);
          g.fillStyle = "#fff";
          g.fillRect(w * 0.2, h * 0.15, w * 0.6, h * 0.7);
          c.toBlob(res, "image/png");
        });
        return Promise.all([png(800, 1000, "#c9d6ea"), png(1280, 800, "#2d333b")]).then(([a, b]) => {
          addFiles([new File([a], "receipt-taxi-0412.png", { type: "image/png" }), new File(["date,km\n"], "mileage-april-2026.csv", { type: "text/csv" }), new File([new Uint8Array(1910000)], "hotel-folio.pdf", { type: "application/pdf" })]);
          addFiles([new File([b], "Screenshot of github.com at 14.02.11.png", { type: "image/png" })], "screenshot");
          ui.contextTabs.push({ id: 12, title: otherTabs[1].title, url: otherTabs[1].url, favIconUrl: "" });
          renderAttachments();
          const t = document.getElementById("input");
          t.value = "Fill the expense report from these receipts";
          t.dispatchEvent(new Event("input"));
        });
      };
      if (stateName === "attachments") seed();
      if (stateName === "menu") document.getElementById("btnAttach").click();
      if (stateName === "tabs") {
        ui.contextTabs.push({ id: 12, title: otherTabs[1].title, url: otherTabs[1].url, favIconUrl: "" });
        renderAttachments();
        openTabPicker();
      }
      if (stateName === "conflict") setTimeout(() => document.getElementById("wfSave").click(), 100);
      if (stateName === "drop") {
        seed().then(() => (document.getElementById("dropHint").hidden = false));
      }
    }, 200);
  });
})();
