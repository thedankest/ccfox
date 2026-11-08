// Marks the tabs Claude is working in: an in-page glow + status pill (content/overlay.js)
// while a side-panel chat or a Claude Code session is acting there, and an optional
// "Claude" tab group for tabs Claude opens.
"use strict";

const Highlight = (() => {
  const CLIENT_LINGER_MS = 6000; // Claude Code sessions have no "done" signal; fade after idle
  const active = new Map(); // tabId -> Map(sourceKey -> timer|null)

  const enabled = () => typeof Chat === "undefined" || Chat.getSettings().highlight !== false;

  async function paint(tabId) {
    const sources = active.get(tabId);
    if (!sources || !sources.size) return;
    const chatSource = [...sources.keys()].find((k) => k.startsWith("chat:"));
    const opts = chatSource
      ? { chatId: chatSource.slice(5), label: "Claude is working in this tab" }
      : { chatId: null, label: "Claude Code is using this tab" };
    try {
      await browser.tabs.executeScript(tabId, { file: "/content/overlay.js", runAt: "document_end" });
      await browser.tabs.executeScript(tabId, { code: `globalThis.__ccfoxOverlay && __ccfoxOverlay.show(${JSON.stringify(opts)})`, runAt: "document_end" });
    } catch {
      // privileged or closed tab: nothing to draw on
    }
  }

  function unpaint(tabId) {
    browser.tabs.executeScript(tabId, { code: "globalThis.__ccfoxOverlay && __ccfoxOverlay.hide()" }).catch(() => {});
  }

  // Called whenever a tool runs in a tab.
  function touch(tabId, sourceKey) {
    if (!enabled()) return;
    let sources = active.get(tabId);
    if (!sources) active.set(tabId, (sources = new Map()));
    const fresh = !sources.has(sourceKey);
    clearTimeout(sources.get(sourceKey));
    sources.set(sourceKey, sourceKey.startsWith("chat:") ? null : setTimeout(() => drop(tabId, sourceKey), CLIENT_LINGER_MS));
    if (fresh || sources.size === 1) paint(tabId);
  }

  function drop(tabId, sourceKey) {
    const sources = active.get(tabId);
    if (!sources) return;
    clearTimeout(sources.get(sourceKey));
    sources.delete(sourceKey);
    if (sources.size) paint(tabId);
    else {
      active.delete(tabId);
      unpaint(tabId);
    }
  }

  // A chat finished: un-highlight every tab it was working in.
  function release(sourceKey) {
    for (const tabId of [...active.keys()]) if (active.get(tabId).has(sourceKey)) drop(tabId, sourceKey);
  }

  function clearAll() {
    for (const tabId of [...active.keys()]) {
      active.delete(tabId);
      unpaint(tabId);
    }
  }

  // Screenshots must show the page, not our glow.
  async function suspend(tabId, on) {
    if (!active.has(tabId)) return;
    await browser.tabs.executeScript(tabId, { code: `globalThis.__ccfoxOverlay && __ccfoxOverlay.suspend(${on})` }).catch(() => {});
    if (on) await new Promise((r) => setTimeout(r, 30));
  }

  // Page navigated: the overlay went with the old document, so draw it again.
  browser.webNavigation.onCompleted.addListener((d) => {
    if (d.frameId === 0 && active.has(d.tabId)) paint(d.tabId);
  });
  browser.tabs.onRemoved.addListener((tabId) => active.delete(tabId));

  // Put tabs Claude opens into one orange "Claude" group per window (Firefox 139+ / Zen).
  // Only tabs Claude creates are grouped; the user's own tabs are never moved.
  const GROUP_TITLE = "Claude";
  async function group(tab) {
    if (typeof browser.tabs.group !== "function" || typeof Chat === "undefined" || Chat.getSettings().groupTabs === false) return;
    try {
      // Tab groups take only a title and a color (no icon). Also adopt groups from ccfox ≤0.3.0.
      const existing = browser.tabGroups
        ? [...(await browser.tabGroups.query({ title: GROUP_TITLE, windowId: tab.windowId })), ...(await browser.tabGroups.query({ title: "ccfox", windowId: tab.windowId }))]
        : [];
      const groupId = await browser.tabs.group(existing[0] ? { tabIds: [tab.id], groupId: existing[0].id } : { tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
      if (browser.tabGroups && existing[0]?.title !== GROUP_TITLE) await browser.tabGroups.update(groupId, { title: GROUP_TITLE, color: "orange" });
    } catch (e) {
      console.warn("[ccfox] tab grouping unavailable:", e && e.message);
    }
  }

  browser.runtime.onMessage.addListener((msg, sender) => {
    if (msg && msg.ccfoxStop && sender.tab) {
      Chat.stop(msg.ccfoxStop);
    }
    return undefined;
  });

  // For tests and debugging: which tabs are highlighted, by which sources.
  const debug = () => [...active].map(([tabId, sources]) => ({ tabId, sources: [...sources.keys()] }));

  return { touch, release, clearAll, suspend, group, debug };
})();
