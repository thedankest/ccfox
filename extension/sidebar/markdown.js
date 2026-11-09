// Minimal, safe Markdown renderer for Claude's replies. Everything is HTML-escaped
// first; only a small set of constructs is turned back into markup, and links are
// limited to http(s).
"use strict";

const Markdown = (() => {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function inline(text) {
    const codes = [];
    let s = esc(text).replace(/`([^`\n]+)`/g, (_, c) => {
      codes.push(c);
      return `\u0000${codes.length - 1}\u0000`;
    });
    s = s
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
      .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (_, pre, u) => `${pre}<a href="${u}" target="_blank" rel="noopener noreferrer">${u}</a>`)
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, "$1<em>$2</em>")
      .replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${codes[Number(i)]}</code>`);
  }

  function blocks(text) {
    const lines = text.split("\n");
    const out = [];
    let para = [];
    let list = null; // { tag, items }
    let quote = [];
    const flushPara = () => {
      if (para.length) out.push(`<p>${para.map(inline).join("<br>")}</p>`);
      para = [];
    };
    const flushList = () => {
      if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join("")}</${list.tag}>`);
      list = null;
    };
    const flushQuote = () => {
      if (quote.length) out.push(`<blockquote>${quote.map(inline).join("<br>")}</blockquote>`);
      quote = [];
    };
    const flushAll = () => { flushPara(); flushList(); flushQuote(); };

    for (const raw of lines) {
      const line = raw.replace(/\s+$/, "");
      let m;
      if (!line.trim()) { flushAll(); continue; }
      if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
        flushAll();
        out.push(`<h${m[1].length <= 2 ? 3 : 4}>${inline(m[2])}</h${m[1].length <= 2 ? 3 : 4}>`);
        continue;
      }
      if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushAll(); out.push("<hr>"); continue; }
      if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
        flushPara(); flushQuote();
        if (!list || list.tag !== "ul") { flushList(); list = { tag: "ul", items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^\s*\d+[.)]\s+(.*)$/))) {
        flushPara(); flushQuote();
        if (!list || list.tag !== "ol") { flushList(); list = { tag: "ol", items: [] }; }
        list.items.push(m[1]);
        continue;
      }
      if ((m = line.match(/^>\s?(.*)$/))) { flushPara(); flushList(); quote.push(m[1]); continue; }
      if (list && /^\s{2,}\S/.test(raw)) { list.items[list.items.length - 1] += " " + line.trim(); continue; }
      flushList(); flushQuote();
      para.push(line);
    }
    flushAll();
    return out.join("");
  }

  function render(src) {
    const parts = String(src || "").split(/^```/m);
    let html = "";
    parts.forEach((part, i) => {
      if (i % 2 === 0) html += blocks(part);
      else {
        const nl = part.indexOf("\n");
        const code = nl >= 0 ? part.slice(nl + 1) : "";
        html += `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`;
      }
    });
    return html;
  }

  return { render };
})();

// Puts the renderer's output (and the panel's built-in SVG icons) into the page without
// innerHTML: the string is parsed into an inert document, anything outside a small
// allowlist of elements and attributes is dropped, links must be http(s), and only
// then are the nodes moved into the panel.
const SafeHTML = (() => {
  const TAGS = new Set(["p", "br", "strong", "em", "code", "pre", "a", "ul", "ol", "li", "blockquote", "h3", "h4", "hr", "kbd", "svg", "path", "rect", "circle", "line", "polyline"]);
  const ATTRS = {
    "*": ["class"],
    a: ["href", "target", "rel"],
    svg: ["viewBox", "aria-hidden"],
    path: ["d"],
    rect: ["x", "y", "width", "height", "rx", "ry"],
    circle: ["cx", "cy", "r"],
    line: ["x1", "y1", "x2", "y2"],
    polyline: ["points"],
  };

  function clean(node) {
    for (const child of [...node.childNodes]) {
      if (child.nodeType === Node.TEXT_NODE) continue;
      if (child.nodeType !== Node.ELEMENT_NODE || !TAGS.has(child.localName)) {
        child.replaceWith(document.createTextNode(child.nodeType === Node.ELEMENT_NODE ? child.textContent : ""));
        continue;
      }
      const ok = new Set([...ATTRS["*"], ...(ATTRS[child.localName] || [])]);
      for (const attr of [...child.attributes]) if (!ok.has(attr.name)) child.removeAttribute(attr.name);
      if (child.localName === "a") {
        if (!/^https?:\/\//i.test(child.getAttribute("href") || "")) child.removeAttribute("href");
        child.setAttribute("target", "_blank");
        child.setAttribute("rel", "noopener noreferrer");
      }
      clean(child);
    }
    return node;
  }

  const parse = (html) => clean(new DOMParser().parseFromString(`<!doctype html><body>${html}`, "text/html").body);
  const nodes = (html) => [...parse(String(html || "")).childNodes].map((n) => document.adoptNode(n));

  return {
    set: (el, html) => el.replaceChildren(...nodes(html)),
    append: (el, html) => el.append(...nodes(html)),
  };
})();
