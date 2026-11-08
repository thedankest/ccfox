// Call one ccfox MCP tool from the shell and print the result (screenshots are saved as PNGs).
//   CCFOX_HOME=/tmp/zc-xxxx node dev/call.mjs <tool> ['{"json":"args"}']
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const [name, json = "{}"] = process.argv.slice(2);
if (!name) {
  console.error("usage: node dev/call.mjs <tool> ['{json args}']");
  process.exit(2);
}

const client = new Client({ name: "ccfox-call", version: "0.0.0" });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, "server", "mcp-server.mjs")], env: { ...process.env } }));
const r = await client.callTool({ name, arguments: JSON.parse(json) });
for (const [i, c] of r.content.entries()) {
  if (c.type === "text") console.log(c.text);
  else if (c.type === "image") {
    const file = path.resolve(`call-${name}-${i}.png`);
    fs.writeFileSync(file, Buffer.from(c.data, "base64"));
    console.log(`[image saved to ${file}]`);
  }
}
await client.close();
process.exit(r.isError ? 1 : 0);
