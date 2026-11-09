// javascript_exec: runs JavaScript that Claude writes in a tab. DEVELOPER BUILD ONLY.
//
// This file is deliberately left out of the addons.mozilla.org (and AMO-signed
// self-distributed) package by scripts/sign-amo.mjs, together with its manifest entry:
// Mozilla's add-on policies forbid executing code that isn't shipped inside the add-on,
// and the userScripts API is reserved for user script managers. background.js picks
// this tool up only if this file was loaded (see `typeof JsExec` there).
"use strict";

const JsExec = (() => {
  // Wraps Claude's code so a single expression returns its value REPL-style, `await`
  // works, and the result comes back JSON-serialized.
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

  // tab: a tabs.Tab already resolved (and claimed) by background.js.
  async function run(tab, code) {
    code = String(code || "");
    if (!code.trim()) throw new Error("javascript_exec needs code.");
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
  }

  return { run };
})();
