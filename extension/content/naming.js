// Shared element naming for ccfox content scripts: roles and accessible names the way
// the page agent (agent.js) outlines pages, so recorded steps (recorder.js) describe
// elements in the same words Claude later searches for with find / read_page.
(() => {
  if (globalThis.__ccfoxNaming) return;

  const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "HEAD", "META", "LINK", "BR", "WBR", "CCFOX-OVERLAY", "CCFOX-RECORDING"]);
  const LANDMARK_ROLES = new Set(["navigation", "main", "banner", "contentinfo", "complementary", "form", "dialog", "alertdialog", "search", "region"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "switch", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
    "option", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton", "treeitem", "gridcell",
  ]);
  const NAME_FROM_CONTENT = new Set([
    "button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem",
    "checkbox", "radio", "switch", "cell", "columnheader", "rowheader", "tooltip", "label", "clickable",
  ]);

  function inputRole(el) {
    const t = (el.getAttribute("type") || "text").toLowerCase();
    switch (t) {
      case "hidden": return null;
      case "checkbox": return "checkbox";
      case "radio": return "radio";
      case "range": return "slider";
      case "number": return "spinbutton";
      case "search": return "searchbox";
      case "button": case "submit": case "reset": case "image": case "file": return "button";
      default: return "textbox";
    }
  }

  function implicitRole(el) {
    const tag = el.tagName;
    switch (tag) {
      case "A": case "AREA": return el.hasAttribute("href") ? "link" : null;
      case "BUTTON": case "SUMMARY": return "button";
      case "INPUT": return inputRole(el);
      case "TEXTAREA": return "textbox";
      case "SELECT": return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "OPTION": return "option";
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "IMG": return el.getAttribute("alt") === "" ? null : "img";
      case "NAV": return "navigation";
      case "MAIN": return "main";
      case "ASIDE": return "complementary";
      case "FORM": return "form";
      case "DIALOG": return "dialog";
      case "SEARCH": return "search";
      case "TABLE": return "table";
      case "TR": return "row";
      case "TH": return "columnheader";
      case "TD": return "cell";
      case "UL": case "OL": return "list";
      case "LI": return "listitem";
      case "LABEL": return "label";
      case "PROGRESS": return "progressbar";
      case "IFRAME": case "FRAME": return "iframe";
      case "VIDEO": return "video";
      case "AUDIO": return "audio";
      case "HEADER": return el.closest("article,aside,main,nav,section") ? null : "banner";
      case "FOOTER": return el.closest("article,aside,main,nav,section") ? null : "contentinfo";
      case "SECTION": return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
      case "SVG": case "svg": return el.getAttribute("role") === "img" || el.querySelector?.(":scope > title") ? "img" : null;
      default: break;
    }
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return "textbox";
    return null;
  }

  function roleOf(el) {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    if (explicit && explicit !== "presentation" && explicit !== "none" && explicit !== "generic") return explicit;
    if (explicit === "presentation" || explicit === "none") return null;
    return implicitRole(el);
  }

  const collapse = (s) => (s || "").replace(/\s+/g, " ").trim();
  const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

  function textOf(el) {
    // textContent is cheaper than innerText and doesn't force layout; good enough for names.
    let t = "";
    for (const n of el.childNodes) {
      if (n.nodeType === 3) t += n.data;
      else if (n.nodeType === 1) {
        if (SKIP_TAGS.has(n.tagName)) continue;
        if (n.tagName === "IMG") t += " " + (n.getAttribute("alt") || "") + " ";
        else if (n.getAttribute("aria-hidden") === "true") continue;
        else t += " " + textOf(n) + " ";
      }
    }
    return t;
  }

  function nameOf(el, role) {
    const doc = el.ownerDocument;
    const lb = el.getAttribute("aria-labelledby");
    if (lb) {
      const s = collapse(lb.split(/\s+/).map((id) => doc.getElementById(id)).filter(Boolean).map((n) => textOf(n)).join(" "));
      if (s) return s;
    }
    const al = collapse(el.getAttribute("aria-label"));
    if (al) return al;
    const tag = el.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) return collapse(el.value) || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : "");
      if (type === "image") return collapse(el.getAttribute("alt") || el.value);
      if (el.labels && el.labels.length) {
        const s = collapse(Array.from(el.labels).map((l) => textOf(l)).join(" "));
        if (s) return s;
      }
      const ph = collapse(el.getAttribute("placeholder"));
      if (ph) return ph;
      return collapse(el.getAttribute("title") || el.getAttribute("name") || "");
    }
    if (tag === "IMG" || tag === "AREA") return collapse(el.getAttribute("alt") || el.getAttribute("title"));
    if (tag === "svg" || tag === "SVG") {
      const t = el.querySelector(":scope > title");
      return collapse(t ? t.textContent : "");
    }
    if (tag === "IFRAME" || tag === "FRAME") return collapse(el.getAttribute("title") || el.getAttribute("name") || el.getAttribute("src") || "");
    if (tag === "FIELDSET") {
      const lg = el.querySelector(":scope > legend");
      if (lg) return collapse(textOf(lg));
    }
    if (tag === "TABLE") {
      const cap = el.querySelector(":scope > caption");
      if (cap) return collapse(textOf(cap));
    }
    if (role && NAME_FROM_CONTENT.has(role)) {
      const s = collapse(textOf(el));
      if (s) return s;
    }
    return collapse(el.getAttribute("title") || "");
  }

  function isInteractive(el, role) {
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    const tag = el.tagName;
    if (tag === "A" && el.hasAttribute("href")) return true;
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA", "SUMMARY"].includes(tag)) return true;
    if (el.isContentEditable && (!el.parentElement || !el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute("onclick")) return true;
    const ti = el.getAttribute("tabindex");
    return ti !== null && Number(ti) >= 0;
  }

  function hasPointerCursor(el) {
    try {
      const c = getComputedStyle(el).cursor;
      if (c !== "pointer") return false;
      const p = el.parentElement;
      return !p || getComputedStyle(p).cursor !== "pointer";
    } catch {
      return false;
    }
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return !el.readOnly && !el.disabled;
    if (el.tagName === "INPUT") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      return !["checkbox", "radio", "button", "submit", "reset", "image", "file", "range", "color", "hidden"].includes(t) && !el.readOnly && !el.disabled;
    }
    return !!el.isContentEditable;
  }

  globalThis.__ccfoxNaming = {
    SKIP_TAGS, LANDMARK_ROLES, INTERACTIVE_ROLES, NAME_FROM_CONTENT,
    inputRole, implicitRole, roleOf, collapse, clip, textOf, nameOf, isInteractive, hasPointerCursor, isTextField,
  };
})();
