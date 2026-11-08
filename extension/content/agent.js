// ccfox in-page agent. Injected on demand into the top frame of tabs Claude
// drives. Builds an accessibility-style outline with stable refs, and simulates
// mouse/keyboard input with DOM events.
//
// Limits worth knowing (there is no CDP in Firefox): events are synthetic
// (isTrusted === false), so CSS :hover, native <select> popups, file pickers and
// clipboard shortcuts can't be driven. Text entry goes through
// document.execCommand("insertText"), whose input events *are* trusted, so
// React/Vue/etc. controlled inputs update normally.
(() => {
  if (globalThis.__zcAgent) return;

  // ---------------------------------------------------------------- refs
  const refToEl = new Map();
  const elToRef = new WeakMap();
  let nextRef = 1;

  function refFor(el) {
    let r = elToRef.get(el);
    if (!r) {
      r = `ref_${nextRef++}`;
      elToRef.set(el, r);
      refToEl.set(r, new WeakRef(el));
    }
    return r;
  }

  function elForRef(ref) {
    const w = refToEl.get(ref);
    const el = w && w.deref();
    if (!el || !el.isConnected) {
      throw new Error(`${ref} no longer exists on the page (it changed or navigated). Call read_page or find again.`);
    }
    return el;
  }

  // ---------------------------------------------------------------- roles & names
  // Shared with the workflow recorder; see naming.js (injected first).
  const {
    SKIP_TAGS, LANDMARK_ROLES, NAME_FROM_CONTENT, roleOf, collapse, clip, textOf, nameOf, isInteractive, hasPointerCursor, isTextField,
  } = globalThis.__ccfoxNaming;

  function isVisible(el) {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (typeof el.checkVisibility === "function") {
      if (el.checkVisibility({ visibilityProperty: true, checkVisibilityCSS: true })) return true;
      try {
        return getComputedStyle(el).display === "contents";
      } catch {
        return false;
      }
    }
    const s = getComputedStyle(el);
    return s.display !== "none" && s.visibility !== "hidden";
  }

  function stateAttrs(el, role) {
    const out = [];
    const tag = el.tagName;
    if (role === "heading") {
      const lvl = el.getAttribute("aria-level") || (/^H[1-6]$/.test(tag) ? tag[1] : null);
      if (lvl) out.push(`level=${lvl}`);
    }
    if (role === "link" && el.getAttribute("href")) {
      const href = el.getAttribute("href");
      if (!href.startsWith("javascript:")) out.push(`href="${clip(href, 100)}"`);
    }
    if (tag === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (!["text", "checkbox", "radio", "button", "submit", "reset"].includes(type)) out.push(`type=${type}`);
      if (type === "checkbox" || type === "radio") {
        if (el.checked) out.push("checked");
        if (el.indeterminate) out.push("mixed");
      } else if (type === "password") {
        if (el.value) out.push(`value="${"•".repeat(Math.min(el.value.length, 8))}"`);
      } else if (!["button", "submit", "reset", "image"].includes(type)) {
        if (el.value) out.push(`value="${clip(el.value, 120)}"`);
        const ph = el.getAttribute("placeholder");
        if (ph && collapse(ph) !== nameOf(el, role)) out.push(`placeholder="${clip(collapse(ph), 60)}"`);
      }
    } else if (tag === "TEXTAREA") {
      if (el.value) out.push(`value="${clip(collapse(el.value), 160)}"`);
    } else if (tag === "SELECT") {
      const sel = Array.from(el.selectedOptions).map((o) => collapse(o.textContent));
      if (sel.length) out.push(`selected="${clip(sel.join(", "), 80)}"`);
      const opts = Array.from(el.options).map((o) => collapse(o.textContent));
      out.push(`options=[${clip(opts.map((o) => `"${clip(o, 40)}"`).join(", "), 400)}]`);
    } else if (el.isContentEditable && role === "textbox") {
      const v = collapse(el.innerText || "");
      if (v) out.push(`value="${clip(v, 160)}"`);
    }
    for (const [attr, label] of [
      ["aria-checked", "checked"], ["aria-selected", "selected"], ["aria-expanded", "expanded"], ["aria-pressed", "pressed"],
    ]) {
      const v = el.getAttribute(attr);
      if (v === "true") out.push(label);
      else if (v === "false" && attr === "aria-expanded") out.push("collapsed");
      else if (v === "mixed") out.push("mixed");
    }
    if (role === "option" && tag === "OPTION" && el.selected) out.push("selected");
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.required || el.getAttribute("aria-required") === "true") out.push("required");
    if (el.getAttribute("aria-invalid") === "true") out.push("invalid");
    if (el === deepActiveElement()) out.push("focused");
    return out;
  }

  // ---------------------------------------------------------------- tree walk
  function childrenOf(node) {
    if (node.nodeType === 1) {
      const sr = node.openOrClosedShadowRoot || node.shadowRoot;
      if (sr) return Array.from(sr.childNodes);
      if (node.tagName === "SLOT") {
        const assigned = node.assignedNodes({ flatten: true });
        if (assigned.length) return assigned;
      }
      if (node.tagName === "IFRAME" || node.tagName === "FRAME") {
        try {
          const d = node.contentDocument;
          if (d && d.body) return [d.body];
        } catch {}
        return [];
      }
    }
    return Array.from(node.childNodes);
  }

  function buildTree(opts) {
    const { filter = "all", root, maxDepth = 40, maxChars = 50000, viewportOnly = false } = opts;
    const interactiveOnly = filter === "interactive";
    const lines = [];
    let chars = 0;
    let truncated = false;
    const vw = innerWidth, vh = innerHeight;

    function emit(depth, text) {
      if (truncated) return;
      const line = `${"  ".repeat(depth)}- ${text}`;
      if (chars + line.length + 1 > maxChars) {
        truncated = true;
        return;
      }
      lines.push(line);
      chars += line.length + 1;
    }

    function inViewport(el) {
      const r = viewportRect(el);
      return r.bottom > 0 && r.right > 0 && r.top < vh && r.left < vw;
    }

    function walk(node, depth, skipText) {
      if (truncated) return;
      if (node.nodeType === 3) {
        if (interactiveOnly || skipText) return;
        const t = collapse(node.data);
        if (t) emit(depth, `text "${clip(t, 300)}"`);
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      if (SKIP_TAGS.has(el.tagName)) return;
      if (el.tagName === "BODY" && el.ownerDocument !== document) {
        for (const c of childrenOf(el)) walk(c, depth, skipText);
        return;
      }
      if (!isVisible(el)) return;

      const role = roleOf(el);
      let interesting;
      const interactive = isInteractive(el, role) || (!role && hasPointerCursor(el));
      if (interactiveOnly) interesting = interactive;
      else interesting = interactive || (role && (role === "heading" || role === "img" || role === "iframe" || role === "listitem" || role === "row" || role === "table" || role === "list" || role === "label" || role === "progressbar" || role === "video" || role === "audio" || LANDMARK_ROLES.has(role) || role === "alert" || role === "status" || role === "tablist" || role === "menu" || role === "menubar" || role === "toolbar" || role === "group" || role === "tooltip"));

      if (interesting && viewportOnly && !inViewport(el)) interesting = false;

      let childDepth = depth;
      let childSkipText = skipText;
      if (interesting && depth <= maxDepth) {
        const shownRole = role || (interactive ? "clickable" : "generic");
        const name = nameOf(el, role || shownRole);
        const parts = [shownRole];
        if (name) parts.push(`"${clip(name, 150)}"`);
        parts.push(`[${refFor(el)}]`);
        parts.push(...stateAttrs(el, role));
        if ((el.tagName === "IFRAME" || el.tagName === "FRAME")) {
          let same = false;
          try { same = !!el.contentDocument; } catch {}
          if (!same) parts.push("(cross-origin: contents not readable)");
        }
        emit(depth, parts.join(" "));
        childDepth = depth + 1;
        if (NAME_FROM_CONTENT.has(shownRole) && name) childSkipText = true;
        if (el.tagName === "SELECT" || el.tagName === "TEXTAREA" || el.tagName === "INPUT") return;
      }
      for (const c of childrenOf(el)) walk(c, childDepth, childSkipText);
    }

    const start = root || document.body || document.documentElement;
    walk(start, 0, false);
    return { lines, truncated };
  }

  // ---------------------------------------------------------------- geometry
  function viewportRect(el) {
    const r = el.getBoundingClientRect();
    let left = r.left, top = r.top;
    let win = el.ownerDocument.defaultView;
    while (win && win !== window) {
      const fe = win.frameElement;
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      left += fr.left + fe.clientLeft;
      top += fr.top + fe.clientTop;
      win = fe.ownerDocument.defaultView;
    }
    return { left, top, width: r.width, height: r.height, right: left + r.width, bottom: top + r.height };
  }

  function targetAt(x, y) {
    let doc = document;
    let ox = 0, oy = 0;
    for (let guard = 0; guard < 10; guard++) {
      let el = doc.elementFromPoint(x - ox, y - oy);
      if (el && el.tagName.startsWith("CCFOX-")) {
        // ccfox's own status pill is on top here; target what's underneath.
        el = doc.elementsFromPoint(x - ox, y - oy).find((e) => !e.tagName.startsWith("CCFOX-")) || null;
      }
      if (!el) return null;
      for (let g = 0; g < 20; g++) {
        const sr = el.openOrClosedShadowRoot || el.shadowRoot;
        if (!sr || typeof sr.elementFromPoint !== "function") break;
        const inner = sr.elementFromPoint(x - ox, y - oy);
        if (!inner || inner === el) break;
        el = inner;
      }
      if (el.tagName === "IFRAME" || el.tagName === "FRAME") {
        let d = null;
        try { d = el.contentDocument; } catch {}
        if (d) {
          const r = el.getBoundingClientRect();
          ox += r.left + el.clientLeft;
          oy += r.top + el.clientTop;
          doc = d;
          continue;
        }
      }
      return { el, x: x - ox, y: y - oy, doc };
    }
    return null;
  }

  function describe(el) {
    const role = roleOf(el) || el.tagName.toLowerCase();
    const name = nameOf(el, roleOf(el) || "clickable");
    return `${role}${name ? ` "${clip(name, 80)}"` : ""}${elToRef.has(el) ? ` [${elToRef.get(el)}]` : ""}`;
  }

  // Resolve {ref} or {coordinate} into an element + local (frame) point + top-level point.
  function resolveTarget(args) {
    if (args.ref) {
      const el = elForRef(args.ref);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = viewportRect(el);
      const cx = Math.round(r.left + r.width / 2), cy = Math.round(r.top + r.height / 2);
      const hit = targetAt(cx, cy);
      // Prefer what's actually under the pointer if it belongs to the element (e.g. a span inside a button).
      if (hit && (hit.el === el || el.contains(hit.el))) return { el: hit.el, x: hit.x, y: hit.y, topX: cx, topY: cy, named: el };
      const lr = el.getBoundingClientRect();
      return { el, x: lr.left + lr.width / 2, y: lr.top + lr.height / 2, topX: cx, topY: cy, named: el, covered: hit ? hit.el : null };
    }
    if (Array.isArray(args.coordinate)) {
      const [x, y] = args.coordinate;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) {
        throw new Error(`Coordinate (${x}, ${y}) is outside the viewport (${innerWidth}x${innerHeight}). Scroll first.`);
      }
      const hit = targetAt(x, y);
      if (!hit) throw new Error(`Nothing at (${x}, ${y}).`);
      return { el: hit.el, x: hit.x, y: hit.y, topX: x, topY: y, named: hit.el };
    }
    throw new Error("Provide either ref or coordinate.");
  }

  // ---------------------------------------------------------------- events
  function parseModifiers(m) {
    const s = (m || "").toLowerCase().split(/[+\s]+/).filter(Boolean);
    return {
      ctrlKey: s.includes("ctrl") || s.includes("control"),
      shiftKey: s.includes("shift"),
      altKey: s.includes("alt") || s.includes("option") || s.includes("opt"),
      metaKey: s.includes("cmd") || s.includes("meta") || s.includes("command") || s.includes("win") || s.includes("super"),
    };
  }

  function mouseInit(el, x, y, extra) {
    const win = el.ownerDocument.defaultView;
    return {
      bubbles: true, cancelable: true, composed: true, view: win,
      clientX: x, clientY: y,
      screenX: Math.round(x + (win.mozInnerScreenX || 0)), screenY: Math.round(y + (win.mozInnerScreenY || 0)),
      ...extra,
    };
  }

  function fire(el, type, init, Ctor) {
    const win = el.ownerDocument.defaultView;
    const C = Ctor ? win[Ctor] || globalThis[Ctor] : win.MouseEvent;
    return el.dispatchEvent(new C(type, init));
  }

  let lastHover = null;

  function hoverTo(el, x, y, mods) {
    const base = mouseInit(el, x, y, { button: 0, buttons: 0, ...mods });
    const pbase = { ...base, pointerId: 1, pointerType: "mouse", isPrimary: true };
    if (lastHover && lastHover !== el && lastHover.isConnected) {
      fire(lastHover, "pointerout", pbase, "PointerEvent");
      fire(lastHover, "pointerleave", { ...pbase, bubbles: false }, "PointerEvent");
      fire(lastHover, "mouseout", base);
      fire(lastHover, "mouseleave", { ...base, bubbles: false });
    }
    if (lastHover !== el) {
      fire(el, "pointerover", pbase, "PointerEvent");
      fire(el, "pointerenter", { ...pbase, bubbles: false }, "PointerEvent");
      fire(el, "mouseover", base);
      fire(el, "mouseenter", { ...base, bubbles: false });
    }
    fire(el, "pointermove", pbase, "PointerEvent");
    fire(el, "mousemove", base);
    lastHover = el;
  }

  const FOCUSABLE = 'input:not([disabled]),textarea:not([disabled]),select:not([disabled]),button:not([disabled]),a[href],area[href],summary,iframe,[tabindex],[contenteditable=""],[contenteditable="true"],[contenteditable="plaintext-only"]';

  function focusFor(el, x, y) {
    const f = el.closest(FOCUSABLE);
    const doc = el.ownerDocument;
    if (f) {
      if (deepActiveElement() !== f) f.focus({ preventScroll: true });
      // Put the caret where the click landed, like a real click would.
      try {
        const cp = doc.caretPositionFromPoint(x, y);
        if (cp) {
          if ((f.tagName === "INPUT" || f.tagName === "TEXTAREA") && cp.offsetNode === f && typeof f.setSelectionRange === "function") {
            f.setSelectionRange(cp.offset, cp.offset);
          } else if (f.isContentEditable && f.contains(cp.offsetNode)) {
            const sel = doc.getSelection();
            sel.collapse(cp.offsetNode, cp.offset);
          }
        }
      } catch {}
    } else {
      const a = deepActiveElement();
      if (a && a !== doc.body && typeof a.blur === "function") a.blur();
    }
  }

  async function mouseClick(t, { button = 0, count = 1, modifiers }) {
    const mods = parseModifiers(modifiers);
    const { el, x, y } = t;
    hoverTo(el, x, y, mods);
    const buttonsMask = button === 2 ? 2 : button === 1 ? 4 : 1;
    for (let i = 1; i <= count; i++) {
      const down = mouseInit(el, x, y, { button, buttons: buttonsMask, detail: i, ...mods });
      const up = mouseInit(el, x, y, { button, buttons: 0, detail: i, ...mods });
      const pdown = { ...down, pointerId: 1, pointerType: "mouse", isPrimary: true, pressure: 0.5 };
      const pup = { ...up, pointerId: 1, pointerType: "mouse", isPrimary: true };
      const pOk = fire(el, "pointerdown", pdown, "PointerEvent");
      const mOk = pOk ? fire(el, "mousedown", down) : false;
      if (mOk && i === 1 && button === 0) focusFor(el, x, y);
      fire(el, "pointerup", pup, "PointerEvent");
      fire(el, "mouseup", up);
      if (button === 0) fire(el, "click", up, "PointerEvent");
      else fire(el, "auxclick", up, "PointerEvent");
      if (button === 2) fire(el, "contextmenu", up, "PointerEvent");
    }
    if (count === 2 && button === 0) fire(el, "dblclick", mouseInit(el, x, y, { button: 0, detail: 2, ...mods }));
    if (count === 3 && button === 0) {
      const f = el.closest("input,textarea");
      if (f && typeof f.select === "function") f.select();
      else {
        const block = el.closest("p,li,td,th,div,h1,h2,h3,h4,h5,h6,pre,blockquote") || el;
        const sel = el.ownerDocument.getSelection();
        const range = el.ownerDocument.createRange();
        range.selectNodeContents(block);
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else if (count === 2 && button === 0) {
      selectWordAt(el, x, y);
    }
  }

  function selectWordAt(el, x, y) {
    try {
      const doc = el.ownerDocument;
      const cp = doc.caretPositionFromPoint(x, y);
      if (!cp || cp.offsetNode.nodeType !== 3) {
        const f = el.closest("input,textarea");
        if (f && cp && cp.offsetNode === f) {
          const v = f.value; let s = cp.offset, e = cp.offset;
          while (s > 0 && /\w/.test(v[s - 1])) s--;
          while (e < v.length && /\w/.test(v[e])) e++;
          f.setSelectionRange(s, e);
        }
        return;
      }
      const text = cp.offsetNode.data;
      let s = cp.offset, e = cp.offset;
      while (s > 0 && /\w/.test(text[s - 1])) s--;
      while (e < text.length && /\w/.test(text[e])) e++;
      const sel = doc.getSelection();
      sel.setBaseAndExtent(cp.offsetNode, s, cp.offsetNode, e);
    } catch {}
  }

  // ---------------------------------------------------------------- keyboard
  function deepActiveElement() {
    let a = document.activeElement;
    for (let g = 0; g < 20 && a; g++) {
      const sr = a.openOrClosedShadowRoot || a.shadowRoot;
      if (sr && sr.activeElement) { a = sr.activeElement; continue; }
      if (a.tagName === "IFRAME" || a.tagName === "FRAME") {
        try {
          const d = a.contentDocument;
          if (d && d.activeElement && d.activeElement !== d.body) { a = d.activeElement; continue; }
        } catch {}
      }
      break;
    }
    return a;
  }

  const KEY_ALIASES = {
    enter: "Enter", return: "Enter", esc: "Escape", escape: "Escape", tab: "Tab", backspace: "Backspace",
    delete: "Delete", del: "Delete", space: " ", spacebar: " ", up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft",
    right: "ArrowRight", arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    home: "Home", end: "End", pageup: "PageUp", pagedown: "PageDown", page_up: "PageUp", page_down: "PageDown",
    insert: "Insert",
  };
  const KEY_CODES = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, " ": 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39,
    ArrowDown: 40, Home: 36, End: 35, PageUp: 33, PageDown: 34, Insert: 45, Shift: 16, Control: 17, Alt: 18, Meta: 91,
  };

  function normalizeKey(k) {
    if (k.length === 1) return k;
    const a = KEY_ALIASES[k.toLowerCase()];
    if (a) return a;
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(k)) return k.toUpperCase();
    return k;
  }

  function codeFor(key) {
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    if (key === " ") return "Space";
    return key.length === 1 ? "" : key;
  }

  function keyCodeFor(key) {
    if (KEY_CODES[key] !== undefined) return KEY_CODES[key];
    if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
    if (/^[0-9]$/.test(key)) return key.charCodeAt(0);
    if (/^F(\d+)$/.test(key)) return 111 + Number(key.slice(1));
    return 0;
  }

  function keyEvent(el, type, key, mods) {
    const win = el.ownerDocument.defaultView;
    const printable = key.length === 1;
    const kc = keyCodeFor(key);
    const init = {
      key, code: codeFor(key), bubbles: true, cancelable: true, composed: true, view: win, ...mods,
      keyCode: type === "keypress" ? (printable ? key.charCodeAt(0) : kc) : kc,
      charCode: type === "keypress" && printable ? key.charCodeAt(0) : 0,
      which: type === "keypress" && printable ? key.charCodeAt(0) : kc,
    };
    return el.dispatchEvent(new win.KeyboardEvent(type, init));
  }

  function insertText(el, text) {
    const doc = el.ownerDocument;
    if (isTextField(el)) {
      try {
        if (doc.execCommand("insertText", false, text)) return true;
      } catch {}
      if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
        try {
          const s = el.selectionStart ?? el.value.length, e = el.selectionEnd ?? s;
          el.setRangeText(text, s, e, "end");
        } catch {
          el.value = el.value + text; // types without selection APIs (email, number)
        }
        el.dispatchEvent(new (doc.defaultView.InputEvent)("input", { bubbles: true, composed: true, inputType: "insertText", data: text }));
        return true;
      }
    }
    return false;
  }

  function tabbables(doc) {
    return Array.from(doc.querySelectorAll(FOCUSABLE)).filter((e) => {
      const ti = e.getAttribute("tabindex");
      if (ti !== null && Number(ti) < 0) return false;
      if (e.disabled) return false;
      return isVisible(e) && e.getClientRects().length > 0;
    });
  }

  function moveFocus(el, backwards) {
    const doc = el && el.ownerDocument ? el.ownerDocument : document;
    const list = tabbables(doc);
    if (!list.length) return null;
    let i = list.indexOf(el);
    i = i < 0 ? (backwards ? list.length - 1 : 0) : (i + (backwards ? -1 : 1) + list.length) % list.length;
    list[i].focus();
    if (typeof list[i].select === "function" && isTextField(list[i])) list[i].select();
    return list[i];
  }

  function defaultKeyAction(el, key, mods) {
    const doc = el.ownerDocument;
    const ctrlish = mods.ctrlKey || mods.metaKey;
    const field = isTextField(el);
    if (ctrlish && key.toLowerCase() === "a") {
      if (field && typeof el.select === "function") el.select();
      else doc.execCommand("selectAll");
      return;
    }
    if (ctrlish && key.toLowerCase() === "z") { doc.execCommand(mods.shiftKey ? "redo" : "undo"); return; }
    if (ctrlish && key.toLowerCase() === "y") { doc.execCommand("redo"); return; }
    if (ctrlish) return; // other shortcuts (copy/paste, etc.) can't be emulated
    switch (key) {
      case "Enter": {
        if (el.tagName === "TEXTAREA" || (el.isContentEditable && field)) {
          if (!doc.execCommand(el.isContentEditable ? "insertParagraph" : "insertText", false, "\n")) insertText(el, "\n");
          return;
        }
        if (el.tagName === "INPUT" && el.form) {
          const submitter = el.form.querySelector('button:not([type]),button[type="submit"],input[type="submit"],input[type="image"]');
          if (submitter && !submitter.disabled) submitter.click();
          else if (el.form.querySelectorAll("input:not([type=hidden]):not([type=button]):not([type=submit]):not([type=checkbox]):not([type=radio])").length <= 1 || !submitter) el.form.requestSubmit();
          return;
        }
        if (el.tagName === "A" || el.tagName === "BUTTON" || el.tagName === "SUMMARY" || el.getAttribute("role") === "button" || el.getAttribute("role") === "link") el.click();
        return;
      }
      case "Backspace": if (field) doc.execCommand("delete"); return;
      case "Delete": if (field) doc.execCommand("forwardDelete"); return;
      case "Tab": moveFocus(el, mods.shiftKey); return;
      case "ArrowLeft": case "ArrowRight": case "Home": case "End": {
        if ((el.tagName === "INPUT" || el.tagName === "TEXTAREA") && typeof el.setSelectionRange === "function") {
          try {
            const len = el.value.length;
            let p = key === "Home" ? 0 : key === "End" ? len : (el.selectionStart ?? 0) + (key === "ArrowLeft" ? -1 : 1);
            p = Math.max(0, Math.min(len, p));
            if (mods.shiftKey) el.setSelectionRange(Math.min(p, el.selectionStart), Math.max(p, el.selectionEnd));
            else el.setSelectionRange(p, p);
          } catch {}
          return;
        }
        if (!field) scrollPage(key);
        return;
      }
      case "ArrowUp": case "ArrowDown": {
        if (el.tagName === "SELECT") {
          const n = el.selectedIndex + (key === "ArrowDown" ? 1 : -1);
          if (n >= 0 && n < el.options.length) {
            el.selectedIndex = n;
            el.dispatchEvent(new Event("input", { bubbles: true }));
            el.dispatchEvent(new Event("change", { bubbles: true }));
          }
          return;
        }
        if (!field) scrollPage(key);
        return;
      }
      case "PageUp": case "PageDown": if (!field) scrollPage(key); return;
      case " ": {
        if (field) { insertText(el, " "); return; }
        const t = (el.getAttribute("type") || "").toLowerCase();
        if (el.tagName === "BUTTON" || el.tagName === "SUMMARY" || (el.tagName === "INPUT" && ["checkbox", "radio", "button", "submit", "reset"].includes(t)) || ["button", "checkbox", "switch", "radio", "menuitem", "tab"].includes(el.getAttribute("role"))) {
          el.click();
          return;
        }
        scrollPage("PageDown");
        return;
      }
      default:
        if (key.length === 1 && field) insertText(el, key);
    }
  }

  function scrollPage(key) {
    const se = document.scrollingElement || document.documentElement;
    const page = innerHeight * 0.85;
    const map = { ArrowDown: [0, 40], ArrowUp: [0, -40], ArrowLeft: [-40, 0], ArrowRight: [40, 0], PageDown: [0, page], PageUp: [0, -page] };
    if (key === "Home") se.scrollTo({ top: 0, behavior: "instant" });
    else if (key === "End") se.scrollTo({ top: se.scrollHeight, behavior: "instant" });
    else if (map[key]) se.scrollBy({ left: map[key][0], top: map[key][1], behavior: "instant" });
  }

  function pressKey(combo) {
    const parts = combo.split("+");
    let key = parts.pop();
    if (key === "" && parts.length) { parts.pop(); key = "+"; } // "ctrl++"
    key = normalizeKey(key);
    const mods = parseModifiers(parts.join("+"));
    const el = deepActiveElement() || document.body;
    const printable = key.length === 1 && !mods.ctrlKey && !mods.metaKey;
    const okDown = keyEvent(el, "keydown", key, mods);
    let okPress = true;
    if (okDown && (printable || key === "Enter")) okPress = keyEvent(el, "keypress", key, mods);
    if (okDown && okPress) defaultKeyAction(el, key, mods);
    const after = deepActiveElement() || el;
    keyEvent(after.isConnected ? after : el, "keyup", key, mods);
  }

  async function typeText(text) {
    const el = deepActiveElement();
    if (!el || el === document.body || el === document.documentElement) {
      throw new Error("Nothing is focused. Click the field first (computer left_click on it), or use form_input with its ref.");
    }
    if (!isTextField(el)) {
      // Still deliver key events (keyboard-driven widgets), but say so.
      for (const ch of text) pressKey(ch === "\n" ? "Enter" : ch);
      return `Sent ${text.length} key presses to ${describe(el)} (not a text field).`;
    }
    const perKey = text.length <= 400;
    if (!perKey) {
      insertText(el, text);
      return `Inserted ${text.length} characters into ${describe(el)}.`;
    }
    for (const ch of text) {
      const cur = deepActiveElement() || el;
      if (ch === "\n") { pressKey("Enter"); continue; }
      const ok = keyEvent(cur, "keydown", ch, {});
      if (ok && keyEvent(cur, "keypress", ch, {})) insertText(cur, ch);
      keyEvent(cur, "keyup", ch, {});
    }
    return `Typed ${text.length} characters into ${describe(el)}.`;
  }

  // ---------------------------------------------------------------- scroll & drag
  function canScroll(el, dx, dy) {
    const s = getComputedStyle(el);
    const isRoot = el === document.scrollingElement || el === document.documentElement || el === document.body;
    if (dy) {
      const oy = s.overflowY;
      if (!isRoot && !["auto", "scroll", "overlay"].includes(oy)) return false;
      if (el.scrollHeight <= el.clientHeight) return false;
      return dy > 0 ? el.scrollTop + el.clientHeight < el.scrollHeight - 1 : el.scrollTop > 0;
    }
    if (dx) {
      const ox = s.overflowX;
      if (!isRoot && !["auto", "scroll", "overlay"].includes(ox)) return false;
      if (el.scrollWidth <= el.clientWidth) return false;
      return dx > 0 ? el.scrollLeft + el.clientWidth < el.scrollWidth - 1 : el.scrollLeft > 0;
    }
    return false;
  }

  function scrollAt(args) {
    const dir = args.scroll_direction || "down";
    const amount = Math.max(1, Math.min(20, args.scroll_amount || 3));
    const step = 100 * amount;
    const dx = dir === "left" ? -step : dir === "right" ? step : 0;
    const dy = dir === "up" ? -step : dir === "down" ? step : 0;
    const [x, y] = Array.isArray(args.coordinate) ? args.coordinate : [innerWidth / 2, innerHeight / 2];
    const hit = targetAt(x, y);
    let el = hit ? hit.el : document.scrollingElement;
    const win = el.ownerDocument.defaultView;
    const notPrevented = el.dispatchEvent(new win.WheelEvent("wheel", { ...mouseInit(el, hit ? hit.x : x, hit ? hit.y : y, {}), deltaX: dx, deltaY: dy, deltaMode: 0 }));
    if (!notPrevented) return `Wheel event at (${x}, ${y}) was handled by the page.`;
    let node = el;
    while (node) {
      if (node.nodeType === 1 && canScroll(node, dx, dy)) {
        node.scrollBy({ left: dx, top: dy, behavior: "instant" });
        return `Scrolled ${describe(node)} ${dir} by ${step}px (now at scrollTop=${Math.round(node.scrollTop)}).`;
      }
      if (node.parentElement) node = node.parentElement;
      else if (node.getRootNode && node.getRootNode().host) node = node.getRootNode().host;
      else if (node.ownerDocument && node.ownerDocument.defaultView.frameElement && node === node.ownerDocument.documentElement) node = node.ownerDocument.defaultView.frameElement;
      else node = null;
    }
    const se = document.scrollingElement || document.documentElement;
    const before = [se.scrollLeft, se.scrollTop];
    window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    const moved = before[0] !== se.scrollLeft || before[1] !== se.scrollTop;
    return moved
      ? `Scrolled page ${dir} by ${step}px (scrollY=${Math.round(scrollY)} of ${Math.round(se.scrollHeight - innerHeight)}).`
      : `Nothing to scroll ${dir} at (${x}, ${y}); already at the edge.`;
  }

  async function drag(args) {
    const [sx, sy] = args.start_coordinate || [];
    const [ex, ey] = args.coordinate || [];
    if ([sx, sy, ex, ey].some((v) => typeof v !== "number")) throw new Error("left_click_drag needs start_coordinate and coordinate.");
    const src = targetAt(sx, sy);
    if (!src) throw new Error(`Nothing at start (${sx}, ${sy}).`);
    const mods = parseModifiers(args.modifiers);
    hoverTo(src.el, src.x, src.y, mods);
    const pinit = (el, x, y, buttons) => ({ ...mouseInit(el, x, y, { button: 0, buttons, ...mods }), pointerId: 1, pointerType: "mouse", isPrimary: true });
    fire(src.el, "pointerdown", pinit(src.el, src.x, src.y, 1), "PointerEvent");
    fire(src.el, "mousedown", mouseInit(src.el, src.x, src.y, { button: 0, buttons: 1, ...mods }));
    const html5 = src.el.closest('[draggable="true"]') || (src.el.tagName === "IMG") || (src.el.closest("a[href]"));
    const win = src.el.ownerDocument.defaultView;
    let dt = null;
    if (html5) {
      dt = new win.DataTransfer();
      fire(src.el, "dragstart", { ...mouseInit(src.el, src.x, src.y, { buttons: 1 }), dataTransfer: dt }, "DragEvent");
    }
    const steps = 12;
    let last = src;
    for (let i = 1; i <= steps; i++) {
      const x = sx + ((ex - sx) * i) / steps, y = sy + ((ey - sy) * i) / steps;
      const hit = targetAt(x, y) || last;
      fire(hit.el, "pointermove", pinit(hit.el, hit.x, hit.y, 1), "PointerEvent");
      fire(hit.el, "mousemove", mouseInit(hit.el, hit.x, hit.y, { button: 0, buttons: 1, ...mods }));
      if (dt) {
        if (hit.el !== last.el) {
          fire(hit.el, "dragenter", { ...mouseInit(hit.el, hit.x, hit.y, { buttons: 1 }), dataTransfer: dt }, "DragEvent");
          fire(last.el, "dragleave", { ...mouseInit(last.el, hit.x, hit.y, { buttons: 1 }), dataTransfer: dt }, "DragEvent");
        }
        fire(hit.el, "dragover", { ...mouseInit(hit.el, hit.x, hit.y, { buttons: 1 }), dataTransfer: dt }, "DragEvent");
      }
      last = hit;
      await new Promise((r) => setTimeout(r, 16));
    }
    if (dt) {
      fire(last.el, "drop", { ...mouseInit(last.el, last.x, last.y, {}), dataTransfer: dt }, "DragEvent");
      fire(src.el, "dragend", { ...mouseInit(src.el, last.x, last.y, {}), dataTransfer: dt }, "DragEvent");
    }
    fire(last.el, "pointerup", pinit(last.el, last.x, last.y, 0), "PointerEvent");
    fire(last.el, "mouseup", mouseInit(last.el, last.x, last.y, { button: 0, buttons: 0, ...mods }));
    lastHover = last.el;
    return `Dragged from (${sx}, ${sy}) ${describe(src.el)} to (${ex}, ${ey}) ${describe(last.el)}${dt ? " (with HTML5 drag events)" : ""}.`;
  }

  // ---------------------------------------------------------------- form_input
  function formInput(ref, value) {
    const el = elForRef(ref);
    const doc = el.ownerDocument;
    const win = doc.defaultView;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    const fireIC = () => {
      el.dispatchEvent(new win.Event("input", { bubbles: true, composed: true }));
      el.dispatchEvent(new win.Event("change", { bubbles: true }));
    };
    if (el.tagName === "SELECT") {
      const wanted = Array.isArray(value) ? value.map(String) : [String(value)];
      const opts = Array.from(el.options);
      const match = (w) => opts.find((o) => o.value === w) || opts.find((o) => collapse(o.textContent) === w) || opts.find((o) => collapse(o.textContent).toLowerCase().includes(w.toLowerCase()));
      const found = wanted.map(match);
      if (found.some((o) => !o)) {
        throw new Error(`No option matching ${JSON.stringify(value)}. Options: ${opts.map((o) => `"${collapse(o.textContent)}" (value=${o.value})`).join(", ")}`);
      }
      if (el.multiple) opts.forEach((o) => (o.selected = found.includes(o)));
      else el.value = found[0].value;
      fireIC();
      return `Selected ${found.map((o) => `"${collapse(o.textContent)}"`).join(", ")} in ${describe(el)}.`;
    }
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (el.tagName === "INPUT" && (type === "checkbox" || type === "radio")) {
      const want = typeof value === "boolean" ? value : !["false", "0", "off", "no", ""].includes(String(value).toLowerCase());
      if (el.checked !== want) el.click();
      return `${describe(el)} is now ${el.checked ? "checked" : "unchecked"}.`;
    }
    const role = roleOf(el);
    if (["checkbox", "switch"].includes(role) && !["INPUT"].includes(el.tagName)) {
      const want = typeof value === "boolean" ? value : String(value).toLowerCase() === "true";
      const cur = el.getAttribute("aria-checked") === "true";
      if (cur !== want) el.click();
      return `Clicked ${describe(el)} (aria-checked=${el.getAttribute("aria-checked")}).`;
    }
    if (el.tagName === "INPUT" && type === "file") throw new Error("File inputs can't be set from an extension.");
    if (el.tagName === "INPUT" && ["range", "color", "date", "time", "datetime-local", "month", "week"].includes(type)) {
      el.value = String(value);
      fireIC();
      return `Set ${describe(el)} to "${el.value}".`;
    }
    if (isTextField(el)) {
      el.focus({ preventScroll: true });
      if (el.isContentEditable) {
        const sel = doc.getSelection();
        const r = doc.createRange();
        r.selectNodeContents(el);
        sel.removeAllRanges();
        sel.addRange(r);
      } else if (typeof el.select === "function") el.select();
      const text = String(value);
      if (text === "") doc.execCommand("delete") || ((el.value = ""), fireIC());
      else insertText(el, text);
      if (el.tagName !== "INPUT" || el.value === text || el.isContentEditable) {
        el.dispatchEvent(new win.Event("change", { bubbles: true }));
      } else {
        // execCommand was refused or the page reformatted the value; fall back to direct assignment.
        el.value = text;
        fireIC();
      }
      const shown = el.isContentEditable ? collapse(el.innerText) : el.value;
      return `Set ${describe(el)} to "${clip(type === "password" ? "•".repeat(shown.length) : shown, 200)}".`;
    }
    throw new Error(`${describe(el)} isn't a form field. Use computer left_click / type instead.`);
  }

  // ---------------------------------------------------------------- page text
  function pageText(maxChars) {
    const candidates = Array.from(document.querySelectorAll("article, main, [role=main]")).filter((e) => isVisible(e));
    let root = candidates.sort((a, b) => b.innerText.length - a.innerText.length)[0];
    if (!root || root.innerText.trim().length < 200) root = document.body || document.documentElement;
    let text = root.innerText.replace(/\n{3,}/g, "\n\n").trim();
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    return `Title: ${document.title}\nURL: ${location.href}\n\n${text}${truncated ? `\n\n[truncated at ${maxChars} chars]` : ""}`;
  }

  // ---------------------------------------------------------------- dispatcher
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const commands = {
    ping: () => ({ ok: true }),
    describe: ({ ref }) => {
      try { return { text: describe(elForRef(ref)) }; } catch { return { text: ref }; }
    },
    describe_point: ({ x, y }) => {
      const hit = targetAt(x, y);
      return { text: hit ? describe(hit.el) : `(${x}, ${y})` };
    },
    viewport: () => ({
      width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX, scrollY,
      docWidth: (document.scrollingElement || document.documentElement).scrollWidth,
      docHeight: (document.scrollingElement || document.documentElement).scrollHeight,
      url: location.href, title: document.title,
    }),
    read_page: ({ filter, ref_id, max_chars = 50000, depth, viewport_only }) => {
      const root = ref_id ? elForRef(ref_id) : null;
      const { lines, truncated } = buildTree({ filter, root, maxChars: max_chars, maxDepth: depth ?? 40, viewportOnly: !!viewport_only });
      const head = `Title: ${document.title}\nURL: ${location.href}\nViewport: ${innerWidth}x${innerHeight}, scrollY=${Math.round(scrollY)} of ${Math.round((document.scrollingElement || document.documentElement).scrollHeight - innerHeight)}\n`;
      let out = head + "\n" + (lines.length ? lines.join("\n") : "(no matching elements)");
      if (truncated) out += `\n\n[truncated at ${max_chars} chars — narrow with ref_id, filter="interactive", or viewport_only]`;
      return { text: out };
    },
    find: ({ query, limit = 20 }) => {
      const q = query.toLowerCase();
      const words = q.split(/\s+/).filter(Boolean);
      const { lines } = buildTree({ filter: "all", maxChars: 2_000_000 });
      const hits = lines
        .map((l) => l.trim())
        .filter((l) => /\[ref_\d+\]/.test(l))
        .filter((l) => { const ll = l.toLowerCase(); return ll.includes(q) || words.every((w) => ll.includes(w)); })
        .slice(0, limit);
      return { text: hits.length ? hits.join("\n") : `No elements matching "${query}". Try read_page, or a shorter query.` };
    },
    get_page_text: ({ max_chars = 50000 }) => ({ text: pageText(max_chars) }),
    click: async (args) => {
      const t = resolveTarget(args);
      const button = args.button === "right" ? 2 : args.button === "middle" ? 1 : 0;
      const before = location.href;
      const what = describe(t.named);
      await mouseClick(t, { button, count: args.count || 1, modifiers: args.modifiers });
      await sleep(150);
      const verb = { 1: "Clicked", 2: "Double-clicked", 3: "Triple-clicked" }[args.count || 1];
      let msg = `${button === 2 ? "Right-clicked" : verb} ${what} at (${t.topX}, ${t.topY}).`;
      if (t.covered) msg += ` Note: ${describe(t.covered)} is on top of it; the event was sent to the element directly.`;
      if (location.href !== before) msg += ` Page URL is now ${location.href}`;
      return { text: msg };
    },
    hover: (args) => {
      const t = resolveTarget(args);
      hoverTo(t.el, t.x, t.y, parseModifiers(args.modifiers));
      return { text: `Hovering ${describe(t.named)} at (${t.topX}, ${t.topY}). (Synthetic: CSS :hover styles won't apply, JS hover handlers will.)` };
    },
    type: async ({ text }) => ({ text: await typeText(text) }),
    key: async ({ text, repeat = 1 }) => {
      const combos = text.trim().split(/\s+/);
      for (let i = 0; i < repeat; i++) for (const c of combos) { pressKey(c); await sleep(10); }
      const a = deepActiveElement();
      return { text: `Pressed ${text}${repeat > 1 ? ` ×${repeat}` : ""}. Focus: ${a && a !== document.body ? describe(a) : "page body"}.` };
    },
    scroll: (args) => ({ text: scrollAt(args) }),
    scroll_to: ({ ref }) => {
      const el = elForRef(ref);
      el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
      const r = viewportRect(el);
      return { text: `Scrolled ${describe(el)} into view; its center is at (${Math.round(r.left + r.width / 2)}, ${Math.round(r.top + r.height / 2)}).` };
    },
    drag: async (args) => ({ text: await drag(args) }),
    form_input: ({ ref, value }) => ({ text: formInput(ref, value) }),
    console: ({ onlyErrors, pattern, limit = 100, clear }) => {
      const c = globalThis.__zcConsole;
      if (!c) return { text: "Console capture isn't active in this tab yet. It starts when Claude first touches a tab; reload the page to capture from page load." };
      let list = c.entries;
      if (onlyErrors) list = list.filter((e) => e.level === "error");
      if (pattern) {
        let re;
        try { re = new RegExp(pattern, "i"); } catch { re = null; }
        list = list.filter((e) => (re ? re.test(e.text) : e.text.includes(pattern)));
      }
      const shown = list.slice(-limit);
      const fmtTime = (t) => new Date(t).toISOString().slice(11, 23);
      const text = shown.length
        ? shown.map((e) => `[${fmtTime(e.time)}] ${e.level.toUpperCase()}: ${clip(e.text, 4000)}`).join("\n")
        : "No console messages" + (onlyErrors || pattern ? " matching the filter." : " captured.");
      if (clear) c.entries.length = 0;
      return { text: `${text}\n\n(${list.length} matching, capturing since ${fmtTime(c.startedAt)}; this page load only)` };
    },
  };

  browser.runtime.onMessage.addListener((msg) => {
    if (!msg || msg.zc !== true) return undefined;
    const fn = commands[msg.cmd];
    if (!fn) return Promise.resolve({ error: `Unknown agent command ${msg.cmd}` });
    return (async () => {
      try {
        return { result: await fn(msg.args || {}) };
      } catch (e) {
        return { error: String(e && e.message ? e.message : e) };
      }
    })();
  });

  globalThis.__zcAgent = { version: 1 };
})();
