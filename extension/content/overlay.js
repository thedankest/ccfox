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
})();
