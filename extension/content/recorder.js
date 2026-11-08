// ccfox workflow recorder. Injected (with naming.js and overlay.js) into the top frame
// of the tabs the user works in while they record a workflow. It turns the user's own
// actions into steps for the background page (workflow.js):
//  - only trusted events (event.isTrusted), so nothing Claude or the page simulates;
//  - clicks named the way agent.js names elements (role, accessible name, context);
//  - one "type" step per field with its final value (on change / blur / Enter);
//  - selects, checkboxes, radios, file pickers, Enter, form submits.
// Values of password, card, one-time-code and similar fields never leave the page:
// the step only says which kind of secret the user entered.
(() => {
  if (globalThis.__ccfoxRecorder) return;
  const N = globalThis.__ccfoxNaming;

  let on = false;
  let paused = false;
  const fields = new WeakMap(); // text field -> hash of the value last recorded (or seen on focus)
  let lastClick = null; // { el, id, t }
  let lastAction = null; // { form, id, t }: a click or Enter that may submit a form

  const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const send = (msg) => browser.runtime.sendMessage({ ccfoxRec: msg }).catch(() => {});
  const live = (e) => on && !paused && e.isTrusted && !ownEvent(e);

  function ownEvent(e) {
    const path = typeof e.composedPath === "function" ? e.composedPath() : [e.target];
    return path.some((n) => n && typeof n.tagName === "string" && n.tagName.startsWith("CCFOX-"));
  }
  const deepTarget = (e) => (typeof e.composedPath === "function" && e.composedPath()[0]) || e.target;
  const parentOf = (n) => n.parentElement || (n.getRootNode && n.getRootNode().host) || null;

  // ---------------------------------------------------------------- URLs
  // Tokens in query strings (reset links, OAuth codes, sessions) aren't recorded.
  const SECRET_PARAM = /(^|[_-])(token|access_token|id_token|auth|authuser_token|session|sid|sig|signature|api[_-]?key|key|code|password|passwd|secret|otp|nonce|state|ticket|jwt|saml\w*)($|[_-])/i;
  function cleanUrl(u) {
    try {
      const x = new URL(u, location.href);
      for (const k of [...x.searchParams.keys()]) if (SECRET_PARAM.test(k)) x.searchParams.set(k, "…");
      if (/(access_token|id_token|code)=/.test(x.hash)) x.hash = "";
      return x.href.replace(/%E2%80%A6/g, "…");
    } catch {
      return String(u || "");
    }
  }

  // ---------------------------------------------------------------- describing elements
  function interactiveAncestor(start) {
    let n = start && start.nodeType === 1 ? start : start && start.parentElement;
    for (let i = 0; n && i < 10; i++, n = parentOf(n)) {
      if (n === document.body || n === document.documentElement) return null;
      const role = N.roleOf(n);
      if (N.isInteractive(n, role)) return n;
      if (!role && N.hasPointerCursor(n)) return n;
    }
    return null;
  }

  // The words a person would use to find the element again: a heading, dialog, form or
  // fieldset it sits in.
  function contextOf(el) {
    let n = parentOf(el);
    for (let i = 0; n && i < 12; i++, n = parentOf(n)) {
      if (n === document.body) break;
      const role = N.roleOf(n);
      if (role === "dialog" || role === "alertdialog") {
        const name = N.nameOf(n, role) || headingIn(n);
        return name ? `in the “${N.clip(name, 50)}” dialog` : "in the dialog";
      }
      if (n.tagName === "FIELDSET") {
        const lg = n.querySelector(":scope > legend");
        if (lg && N.collapse(N.textOf(lg))) return `in “${N.clip(N.collapse(N.textOf(lg)), 50)}”`;
      }
      if (role === "navigation" || role === "search") {
        const name = N.nameOf(n, role);
        if (name) return `in the “${N.clip(name, 40)}” ${role === "search" ? "search area" : "navigation"}`;
      }
      if (role === "form" || n.tagName === "FORM") {
        const name = N.collapse(n.getAttribute("aria-label") || "");
        if (name) return `in the “${N.clip(name, 50)}” form`;
      }
      // A heading that comes before the element inside this container.
      const h = n.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > header :is(h1,h2,h3,h4), :scope > div > :is(h1,h2,h3)");
      if (h && h !== el && !h.contains(el) && h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        const t = N.collapse(N.textOf(h));
        if (t && t.length <= 80) return `under the heading “${N.clip(t, 60)}”`;
      }
    }
    return "";
  }
  function headingIn(n) {
    const h = n.querySelector("h1, h2, h3, [role=heading]");
    return h ? N.collapse(N.textOf(h)) : "";
  }

  // A fallback name for unnamed fields: nearby text a person would read.
  function nearbyText(el) {
    const prev = el.previousElementSibling;
    const t = prev ? N.collapse(N.textOf(prev)) : "";
    if (t && t.length <= 60) return t;
    const parentText = el.parentElement ? N.collapse(N.textOf(el.parentElement)) : "";
    return parentText && parentText.length <= 60 ? parentText : "";
  }

  function describe(el) {
    const explicit = N.roleOf(el);
    const role = explicit || (N.hasPointerCursor(el) || el.hasAttribute("onclick") ? "clickable" : el.tagName.toLowerCase());
    let name = N.nameOf(el, explicit || "clickable");
    if (!name && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT")) name = nearbyText(el);
    name = N.clip(name || "", 80);
    const context = contextOf(el);
    const out = { role, name, context };
    if (role === "link" && el.href) out.href = cleanUrl(el.href);
    out.sig = [role, name, context].join("|");
    return out;
  }

  // ---------------------------------------------------------------- privacy
  function luhn(d) {
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let n = Number(d[d.length - 1 - i]);
      if (i % 2) {
        n *= 2;
        if (n > 9) n -= 9;
      }
      sum += n;
    }
    return sum % 10 === 0;
  }

  // Which kind of secret a field holds, or null. Checked before any value is read out.
  function secretKind(el, value) {
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "password") return "password";
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase().split(/\s+/);
    if (ac.includes("one-time-code")) return "one-time code";
    if (ac.some((t) => t.startsWith("cc-"))) return ac.includes("cc-csc") ? "card security code" : ac.includes("cc-number") ? "card number" : "card details";
    if (ac.includes("current-password") || ac.includes("new-password")) return "password";
    const hint = [el.getAttribute("name"), el.id, el.getAttribute("placeholder"), el.getAttribute("aria-label"), N.nameOf(el, "textbox"), el.getAttribute("data-testid")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    if (/passw(or)?d|passphrase|\bpwd\b|\bpin\b/.test(hint)) return "password";
    if (/card.?(number|num|no\b)|cc.?num|credit.?card|\bcvv|\bcvc|\bcsc\b|security.?code|expir/.test(hint)) return "card details";
    if (/one.?time|\botp\b|2fa|two.?factor|verification.?code|auth(entication|enticator)?.?code|\btotp\b|\bmfa\b|passcode|sms.?code/.test(hint)) return "one-time code";
    if (/\bssn\b|social.?security|\biban\b|routing.?number|tax.?id/.test(hint)) return "ID or bank number";
    const digits = String(value || "").replace(/[\s-]/g, "");
    if (/^\d{13,19}$/.test(digits) && luhn(digits)) return "card number";
    if (/^\d{4,8}$/.test(digits) && /code|token|pin/.test(hint)) return "one-time code";
    return null;
  }

  // ---------------------------------------------------------------- steps
  function base(kind, target) {
    return { id: uid(), kind, target, url: cleanUrl(location.href), title: document.title, at: Date.now() };
  }

  // Only a hash is kept to notice changes, so no copy of what was typed lingers here.
  function hash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return `${s.length}:${h >>> 0}`;
  }

  function valueOf(el) {
    if (el.isContentEditable && el.tagName !== "INPUT" && el.tagName !== "TEXTAREA") return String(el.innerText || "").replace(/\n$/, "");
    return String(el.value ?? "");
  }

  // One step per field: its value when the user leaves it (or presses Enter), and only
  // if it changed since the last time we recorded it.
  function flush(el) {
    if (!N.isTextField(el)) return;
    const value = valueOf(el);
    const seen = fields.get(el);
    if (seen !== undefined && seen === hash(value)) return;
    fields.set(el, hash(value));
    const kind = secretKind(el, value);
    const step = base("type", describe(el));
    if (kind) {
      step.sensitive = kind; // the value itself stays in the page
    } else {
      step.value = value.length > 2000 ? value.slice(0, 2000) : value;
    }
    if (el.tagName === "TEXTAREA" || (el.isContentEditable && el.tagName !== "INPUT")) step.multiline = true;
    send({ type: "step", step });
  }

  function onFocusIn(e) {
    if (!on || paused) return;
    const el = deepTarget(e);
    if (N.isTextField(el) && !fields.has(el)) fields.set(el, hash(valueOf(el)));
  }

  function onFocusOut(e) {
    if (!live(e)) return;
    flush(deepTarget(e));
  }

  function onChange(e) {
    if (!live(e)) return;
    const el = deepTarget(e);
    if (el.tagName === "SELECT") {
      const chosen = [...el.selectedOptions].map((o) => N.collapse(o.textContent));
      const step = base("select", describe(el));
      step.value = chosen.join(", ");
      if (el.multiple) step.multiple = true;
      return send({ type: "step", step });
    }
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return send({ type: "step", step: base(el.checked ? "check" : "uncheck", describe(el)) });
      if (type === "radio") {
        const step = base("radio", describe(el));
        const group = el.closest("fieldset,[role=radiogroup]");
        if (group && !step.target.context) step.target.context = `in “${N.clip(N.nameOf(group, "group") || N.collapse(N.textOf(group.querySelector("legend") || group)), 50)}”`;
        return send({ type: "step", step });
      }
      if (type === "file") {
        // Never the file's name or path: the user picks the file each time.
        return send({ type: "step", step: base("file", describe(el)) });
      }
      if (["range", "color"].includes(type)) {
        const step = base("type", describe(el));
        step.value = el.value;
        return send({ type: "step", step });
      }
    }
    flush(el);
  }

  function onKeyDown(e) {
    if (!live(e) || e.isComposing || e.key !== "Enter") return;
    const el = deepTarget(e);
    if (!N.isTextField(el)) return; // Enter on a button or link arrives as a click
    const multiline = el.tagName === "TEXTAREA" || (el.isContentEditable && el.tagName !== "INPUT");
    if (multiline && !(e.ctrlKey || e.metaKey)) return; // a new line, part of the value
    flush(el);
    const step = base("key", describe(el));
    step.key = `${e.metaKey ? "Cmd+" : ""}${e.ctrlKey ? "Ctrl+" : ""}${e.shiftKey ? "Shift+" : ""}Enter`;
    lastAction = { form: el.form || el.closest("form"), id: step.id, t: Date.now(), key: true };
    send({ type: "step", step });
  }

  function onClick(e) {
    if (!live(e) || e.button !== 0) return;
    const raw = deepTarget(e);
    if (raw.closest && raw.closest("select, option, datalist")) return; // the change says what was picked
    const label = raw.closest && raw.closest("label");
    if (label && label.control && !["button", "submit", "reset", "image"].includes((label.control.type || "").toLowerCase())) return;
    const el = interactiveAncestor(raw);
    if (!el) return; // a click on empty page
    if (el.tagName === "INPUT") {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["checkbox", "radio", "file"].includes(type)) return; // recorded on change
    }
    if (N.isTextField(el) || el.tagName === "SELECT") return; // a click that only focuses
    const now = Date.now();
    const form = el.form || (el.closest && el.closest("form"));
    // Enter in a field "clicks" the form's default button (implicit submission): that
    // is the Enter step, already recorded.
    if (e.detail === 0 && lastAction && lastAction.key && lastAction.form === form && now - lastAction.t < 1000) return;
    if (e.detail >= 2 && lastClick && lastClick.el === el && now - lastClick.t < 700) {
      lastClick.t = now;
      return send({ type: "patch", id: lastClick.id, patch: { count: e.detail } });
    }
    const step = base("click", describe(el));
    if (step.target.role === "link" && (el.target === "_blank" || e.ctrlKey || e.metaKey || e.shiftKey)) step.newTab = true;
    lastClick = { el, id: step.id, t: now };
    const submitter = (el.tagName === "BUTTON" && (el.getAttribute("type") || "submit").toLowerCase() === "submit") || (el.tagName === "INPUT" && ["submit", "image"].includes((el.type || "").toLowerCase()));
    lastAction = form && submitter ? { form, id: step.id, t: now } : null;
    send({ type: "step", step });
  }

  function onSubmit(e) {
    if (!live(e)) return;
    const form = e.target;
    if (lastAction && lastAction.form === form && Date.now() - lastAction.t < 2000) {
      send({ type: "patch", id: lastAction.id, patch: { submits: true } });
      lastAction = null;
      return;
    }
    const name = N.collapse(form.getAttribute("aria-label") || form.getAttribute("name") || "") || headingIn(form);
    send({ type: "step", step: base("submit", { role: "form", name: N.clip(name, 60), context: contextOf(form), sig: `form|${name}` }) });
  }

  const opts = { capture: true, passive: true };
  window.addEventListener("focusin", onFocusIn, opts);
  window.addEventListener("focusout", onFocusOut, opts);
  window.addEventListener("change", onChange, opts);
  window.addEventListener("keydown", onKeyDown, opts);
  window.addEventListener("click", onClick, opts);
  window.addEventListener("submit", onSubmit, opts);

  const pill = () => globalThis.__ccfoxRecPill;
  globalThis.__ccfoxRecorder = {
    start(o = {}) {
      on = true;
      paused = !!o.paused;
      if (pill()) pill().show({ paused });
      return true;
    },
    pause(p) {
      paused = !!p;
      if (on && pill()) pill().show({ paused });
      return true;
    },
    stop() {
      on = false;
      paused = false;
      if (pill()) pill().hide();
      return true;
    },
  };
})();
