#!/usr/bin/env node
// ccfox MCP server (stdio). Claude Code starts this; it forwards tool calls to
// the native host's Unix socket, which relays them to the extension in Zen/Firefox.
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { INSTRUCTIONS, TOOLS, annotationsOf, errorContent, timeoutMessage, toContent } from "./tools.mjs";

const HOME = process.env.CCFOX_HOME || path.join(os.homedir(), ".ccfox");
const SOCK = path.join(HOME, "bridge.sock");

// ------------------------------------------------------------------ bridge client
class Bridge {
  constructor() {
    this.sock = null;
    this.connecting = null;
    this.nextId = 1;
    this.pending = new Map();
    this.buf = "";
  }

  connect() {
    if (this.sock && !this.sock.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = new Promise((resolve, reject) => {
      const s = net.createConnection(SOCK);
      s.setEncoding("utf8");
      s.once("connect", () => {
        this.sock = s;
        this.connecting = null;
        // Side-panel chats start this server with CCFOX_CHAT_ID so tools default to the panel's tab.
        s.write(JSON.stringify({ type: "hello", chatId: process.env.CCFOX_CHAT_ID || null }) + "\n");
        resolve();
      });
      s.on("data", (d) => this.onData(d));
      s.on("error", (e) => {
        if (this.connecting) {
          this.connecting = null;
          reject(
            new Error(
              e.code === "ENOENT" || e.code === "ECONNREFUSED"
                ? "Zen isn't connected. Make sure Zen is running with the ccfox extension installed (check its toolbar icon), and that `npm run install-host` has been run in the ccfox folder."
                : `Could not reach the ccfox host at ${SOCK}: ${e.message}`,
            ),
          );
        }
      });
      s.on("close", () => {
        if (this.sock === s) this.sock = null;
        for (const [, p] of this.pending) p.reject(new Error("Connection to Zen closed (browser quit or extension reloaded). Try again."));
        this.pending.clear();
      });
    });
    return this.connecting;
  }

  onData(chunk) {
    this.buf += chunk;
    let nl;
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (!line.trim()) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.type === "hello") continue;
      const p = this.pending.get(msg.id);
      if (!p) continue;
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error || "Unknown error in browser"));
    }
  }

  async call(tool, args, timeoutMs) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(timeoutMessage(tool, timeoutMs)));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sock.write(JSON.stringify({ id, tool, args }) + "\n");
    });
  }
}

const bridge = new Bridge();

// ------------------------------------------------------------------ MCP tools
// Definitions live in tools.mjs, shared with the side panel's in-process server.
const server = new McpServer({ name: "ccfox", version: "0.1.0" }, { instructions: INSTRUCTIONS });

for (const t of TOOLS) {
  server.registerTool(t.name, { description: t.description, inputSchema: t.shape, annotations: annotationsOf(t) }, async (args) => {
    try {
      return toContent(await bridge.call(t.name, args, t.timeoutMs));
    } catch (e) {
      return errorContent(e);
    }
  });
}

await server.connect(new StdioServerTransport());
