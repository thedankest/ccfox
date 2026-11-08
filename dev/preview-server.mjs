#!/usr/bin/env node
// Serves the side panel outside Zen for design work: the real panel.html/css/js with a
// fake `browser` API (dev/mock-browser.js) and seeded states.
//   node dev/preview-server.mjs [port]
//   http://localhost:4317/            gallery of every state at sidebar width
//   http://localhost:4317/panel?state=approval&theme=dark
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.argv[2]) || 4317;
const TYPES = { ".html": "text/html", ".css": "text/css", ".js": "text/javascript", ".svg": "image/svg+xml", ".png": "image/png" };
const STATES = ["empty", "conversation", "attachments", "menu", "tabs", "drop", "approval", "commit", "bash", "running", "error", "picker", "agents", "history", "settings", "auto", "disconnected"];

function panelHtml(theme) {
  let html = fs.readFileSync(path.join(ROOT, "extension/sidebar/panel.html"), "utf8");
  html = html.replace("<head>", `<head>\n<base href="/extension/sidebar/">`);
  // iframes can't fake prefers-color-scheme, so serve a CSS variant with the dark block forced on/off.
  if (theme) html = html.replace('href="panel.css"', `href="/themed.css?theme=${theme}"`);
  html = html.replace('<script src="markdown.js"></script>', '<script src="/dev/mock-browser.js"></script>\n  <script src="markdown.js"></script>');
  return html;
}

function gallery() {
  const w = (s, t, width) => `<figure><figcaption>${s} · ${t} · ${width}px</figcaption><iframe src="/panel?state=${s}&theme=${t}" width="${width}" height="720" title="${s} ${t}"></iframe></figure>`;
  const frames = [
    ...STATES.flatMap((s) => ["light", "dark"].map((t) => w(s, t, 380))),
    ...["approval", "bash", "conversation", "attachments", "picker", "menu", "tabs", "settings"].map((s) => w(s, "dark", 250)),
    ...["attachments", "picker", "tabs"].map((s) => w(s, "light", 250)),
    ...["conversation", "approval", "attachments", "picker", "settings"].map((s) => w(s, "light", 640)),
  ].join("\n");
  return `<!doctype html><meta charset="utf-8"><title>ccfox panel states</title>
<style>body{font:13px system-ui;margin:16px;background:#888}main{display:flex;flex-wrap:wrap;gap:16px}figure{margin:0}figcaption{color:#fff;margin-bottom:4px}iframe{border:0;display:block;box-shadow:0 2px 10px #0004}</style>
<main>${frames}</main>`;
}

http
  .createServer((req, res) => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    if (url.pathname === "/") return res.writeHead(200, { "content-type": "text/html" }).end(gallery());
    if (url.pathname === "/themed.css") {
      const css = fs.readFileSync(path.join(ROOT, "extension/sidebar/panel.css"), "utf8")
        .replaceAll("@media (prefers-color-scheme: dark)", url.searchParams.get("theme") === "dark" ? "@media all" : "@media not all");
      return res.writeHead(200, { "content-type": "text/css", "cache-control": "no-store" }).end(css);
    }
    if (url.pathname === "/panel") return res.writeHead(200, { "content-type": "text/html" }).end(panelHtml(url.searchParams.get("theme")));
    const file = path.normalize(path.join(ROOT, url.pathname));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.writeHead(404).end("not found");
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => console.log(`panel preview: http://localhost:${PORT}/`));
