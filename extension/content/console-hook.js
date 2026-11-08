// Captures the page's console output and uncaught errors for read_console_messages.
// Injected (at document_start where possible) only into tabs Claude has touched.
// Runs in the extension's content-script sandbox; it reaches the page's own
// `console` through `wrappedJSObject` and wraps its methods with exportFunction.
(() => {
  if (globalThis.__zcConsole) return;

  const MAX = 1000;
  const entries = [];
  globalThis.__zcConsole = { entries, startedAt: Date.now(), url: location.href };

  const pageWin = window.wrappedJSObject;

  function fmt(value) {
    try {
      if (value === null) return "null";
      const t = typeof value;
      if (t === "string") return value;
      if (t === "number" || t === "boolean" || t === "bigint" || t === "undefined") return String(value);
      if (t === "symbol") return value.toString();
      if (t === "function") return `[Function ${value.name || "anonymous"}]`;
      if (value && typeof value.stack === "string" && typeof value.message === "string") {
        return `${value.name || "Error"}: ${value.message}\n${value.stack}`;
      }
      if (value && typeof value.nodeType === "number") {
        const el = value;
        return el.outerHTML ? el.outerHTML.slice(0, 300) : `[${el.nodeName}]`;
      }
      const s = pageWin.JSON.stringify(value);
      return s === undefined ? String(value) : s.length > 2000 ? s.slice(0, 2000) + "…" : s;
    } catch {
      try { return String(value); } catch { return "[unprintable]"; }
    }
  }

  function push(level, args) {
    const parts = [];
    for (let i = 0; i < args.length; i++) parts.push(fmt(args[i]));
    entries.push({ level, text: parts.join(" "), time: Date.now(), url: location.href });
    if (entries.length > MAX) entries.splice(0, entries.length - MAX);
  }

  try {
    const pageConsole = pageWin.console;
    for (const level of ["log", "info", "warn", "error", "debug", "trace"]) {
      const original = pageConsole[level];
      if (typeof original !== "function") continue;
      exportFunction(
        function (...args) {
          try { push(level, args); } catch {}
          // Spread, don't apply(): passing this content-script array into page code
          // would throw "Permission denied" and break the page's own logging.
          return original.call(pageConsole, ...args);
        },
        pageConsole,
        { defineAs: level },
      );
    }
  } catch (e) {
    entries.push({ level: "warn", text: `[ccfox] console capture unavailable: ${e}`, time: Date.now() });
  }

  window.addEventListener("error", (e) => {
    if (e.error === undefined && e.target && e.target !== window) {
      const t = e.target;
      push("error", [`Failed to load resource: <${(t.tagName || "").toLowerCase()}> ${t.src || t.href || ""}`]);
      return;
    }
    push("error", [`Uncaught ${e.message} (${e.filename}:${e.lineno}:${e.colno})`]);
  }, true);

  window.addEventListener("unhandledrejection", (e) => {
    push("error", ["Unhandled promise rejection:", e.reason]);
  });
})();
