// "Claude is working here" highlight: a glow around the viewport plus a small status
// pill with Stop. Lives in a closed shadow root so pages can't style or read it,
// ignores the pointer except on the pill, and is hidden while ccfox takes screenshots.
(() => {
  if (globalThis.__ccfoxOverlay) return;

  let host = null;
  let root = null;
  let state = { chatId: null, label: "" };

  function build() {
    host = document.createElement("ccfox-overlay");
    host.setAttribute("aria-hidden", "false");
    host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .glow {
          position: fixed; inset: 0; pointer-events: none;
          box-shadow: inset 0 0 0 2px rgb(232 104 42 / 0.85), inset 0 0 28px 6px rgb(232 104 42 / 0.28);
          opacity: 0; transition: opacity 240ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .pill {
          position: fixed; left: 50%; bottom: 14px; transform: translate(-50%, 8px);
          display: flex; align-items: center; gap: 10px; pointer-events: auto;
          padding: 6px 6px 6px 12px; border-radius: 999px;
          background: #1c1a17; color: #f7f5f0; box-shadow: 0 4px 18px rgb(0 0 0 / 0.28);
          font: 500 12.5px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0;
          opacity: 0; transition: opacity 240ms cubic-bezier(0.16, 1, 0.3, 1), transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .on .glow { opacity: 1; }
        .on .pill { opacity: 1; transform: translate(-50%, 0); }
        .dot { width: 8px; height: 8px; border-radius: 2px; background: #e8682a; flex: none; }
        button {
          all: unset; cursor: pointer; padding: 5px 11px; border-radius: 999px;
          background: #f7f5f0; color: #1c1a17; font: 600 12px/1.2 system-ui, -apple-system, sans-serif;
        }
        button[hidden] { display: none; }
        button:hover { background: #ffffff; }
        button:focus-visible { outline: 2px solid #e8682a; outline-offset: 2px; }
        .no-stop { padding-right: 12px; }
        .instant .glow, .instant .pill { transition: none; }
        @media (prefers-reduced-motion: reduce) { .glow, .pill { transition: none; } }
      </style>
      <div class="wrap">
        <div class="glow"></div>
        <div class="pill" role="status"><span class="dot"></span><span class="label"></span><button type="button">Stop</button></div>
      </div>`;
    root.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      if (state.chatId) browser.runtime.sendMessage({ ccfoxStop: state.chatId }).catch(() => {});
    });
  }

  function attach() {
    if (!host) build();
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  }

  globalThis.__ccfoxOverlay = {
    show(opts) {
      state = { ...state, ...opts };
      attach();
      root.querySelector(".label").textContent = state.label;
      const btn = root.querySelector("button");
      btn.hidden = !state.chatId;
      root.querySelector(".pill").classList.toggle("no-stop", !state.chatId);
      host.style.visibility = "";
      // No requestAnimationFrame: background tabs pause it, and Claude often works in one.
      // Hidden tabs don't run transitions, so appear instantly there.
      const wrap = root.querySelector(".wrap");
      wrap.classList.toggle("instant", document.visibilityState !== "visible");
      void wrap.offsetWidth;
      wrap.classList.add("on");
    },
    hide() {
      if (!root) return;
      root.querySelector(".wrap").classList.remove("on");
      setTimeout(() => {
        if (host && !root.querySelector(".wrap").classList.contains("on")) host.remove();
      }, 260);
    },
    suspend(on) {
      if (host) host.style.visibility = on ? "hidden" : "";
    },
    isHost(el) {
      return !!host && el === host;
    },
  };

  // highlight.js drives the overlay with messages (no code strings are injected).
  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || !msg.ccfoxOverlay) return undefined;
    const { op, opts, on } = msg.ccfoxOverlay;
    const overlay = globalThis.__ccfoxOverlay;
    if (op === "show") overlay.show(opts);
    else if (op === "hide") overlay.hide();
    else if (op === "suspend") overlay.suspend(!!on);
    return Promise.resolve(true);
  });
})();

// "Recording your steps" pill, shown while the user records a workflow. Deliberately
// unlike the "Claude is working" look: no glow, a round red record dot, at the top of
// the page, so it is never mistaken for Claude acting. The recorder ignores clicks on it.
(() => {
  if (globalThis.__ccfoxRecPill) return;

  let host = null;
  let root = null;

  function build() {
    host = document.createElement("ccfox-recording");
    host.style.cssText = "all:initial;position:fixed;left:0;right:0;top:0;height:0;z-index:2147483647;pointer-events:none;display:block;";
    root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        .pill {
          position: fixed; left: 50%; top: 12px; transform: translate(-50%, -8px);
          display: flex; align-items: center; gap: 9px; pointer-events: auto;
          padding: 5px 5px 5px 11px; border-radius: 999px;
          background: #1c1a17; color: #f7f5f0; box-shadow: 0 0 0 1px rgb(229 72 77 / 0.55), 0 4px 18px rgb(0 0 0 / 0.28);
          font: 500 12.5px/1.2 system-ui, -apple-system, "Segoe UI", sans-serif; letter-spacing: 0;
          opacity: 0; transition: opacity 240ms cubic-bezier(0.16, 1, 0.3, 1), transform 240ms cubic-bezier(0.16, 1, 0.3, 1);
        }
        .on .pill { opacity: 1; transform: translate(-50%, 0); }
        .dot { width: 9px; height: 9px; border-radius: 50%; background: #e5484d; flex: none; animation: rec 1.6s ease-in-out infinite; }
        .paused .dot { animation: none; background: transparent; box-shadow: inset 0 0 0 2px #f7f5f0; border-radius: 2px; }
        @keyframes rec { 50% { opacity: 0.35; } }
        button {
          all: unset; cursor: pointer; padding: 5px 11px; border-radius: 999px;
          background: #f7f5f0; color: #1c1a17; font: 600 12px/1.2 system-ui, -apple-system, sans-serif;
        }
        button:hover { background: #ffffff; }
        button:focus-visible { outline: 2px solid #e5484d; outline-offset: 2px; }
        .instant .pill { transition: none; }
        @media (prefers-reduced-motion: reduce) { .pill { transition: none; } .dot { animation: none; } }
      </style>
      <div class="wrap">
        <div class="pill" role="status" aria-label="ccfox is recording your steps"><span class="dot" aria-hidden="true"></span><span class="label">Recording your steps</span><button type="button">Stop</button></div>
      </div>`;
    root.querySelector("button").addEventListener("click", (e) => {
      e.stopPropagation();
      browser.runtime.sendMessage({ ccfoxRec: { type: "stop" } }).catch(() => {});
    });
  }

  function attach() {
    if (!host) build();
    if (!host.isConnected) (document.documentElement || document.body).appendChild(host);
  }

  globalThis.__ccfoxRecPill = {
    show({ paused = false } = {}) {
      const go = () => {
        attach();
        const wrap = root.querySelector(".wrap");
        wrap.classList.toggle("paused", paused);
        root.querySelector(".label").textContent = paused ? "Recording paused" : "Recording your steps";
        wrap.classList.toggle("instant", document.visibilityState !== "visible");
        void wrap.offsetWidth;
        wrap.classList.add("on");
      };
      if (document.documentElement) go();
      else document.addEventListener("DOMContentLoaded", go, { once: true });
    },
    hide() {
      if (!root) return;
      root.querySelector(".wrap").classList.remove("on");
      setTimeout(() => {
        if (host && !root.querySelector(".wrap").classList.contains("on")) host.remove();
      }, 260);
    },
    isHost(el) {
      return !!host && el === host;
    },
  };
})();
