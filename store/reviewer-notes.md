ccfox 0.7.0. Unofficial open-source (MIT) side panel and browser tools for Claude Code, the user's own locally installed agent. Full notes: https://github.com/thedankest/ccfox/blob/main/store/reviewer-notes-full.md

NATIVE HELPER REQUIRED
The add-on only talks to the native messaging host "ccfox": plain, unminified Node.js in the same repo (host/, server/). It runs Claude Agent SDK sessions on the user's `claude` binary and listens only on a private Unix socket (~/.ccfox/bridge.sock, 0600), never the network.

HOW TO TEST (macOS)
1. Node 20+: git clone https://github.com/thedankest/ccfox && cd ccfox && npm install && npm run install-host
2. Install this add-on in Firefox 140+.
3. Without a Claude account, drive the tools from a terminal:
   node dev/call.mjs tabs_create '{"url":"https://example.com"}'
   node dev/call.mjs read_page
   node dev/call.mjs computer '{"action":"screenshot"}'
   The tab gets an orange glow and pill; tabs Claude opens join a "Claude" tab group.
4. Side panel (Alt+Shift+C), with Claude Code logged in: "Summarize this page". Clicking, typing and navigating ask for approval first.
5. Panel menu > "Record a workflow": record, review, save; the helper writes ~/.claude/skills/<name>/SKILL.md.

PERMISSIONS
nativeMessaging: the only channel to the helper. <all_urls>: inject the packaged content scripts on the pages Claude works on, captureTab screenshots, observe Claude's tabs' requests. tabs: list/open/switch/close tabs. tabGroups: the "Claude" group for tabs Claude opens (never the user's tabs). webRequest: read-only request log (no bodies, no blocking) for Claude's tabs. webNavigation: re-inject after navigation; record navigations while recording. storage: local settings and chat history. incognito: not_allowed.

DATA
data_collection_permissions.required: websiteContent, browsingActivity, websiteActivity, personalCommunications. Data goes only to the local helper and, through the user's Claude Code, to Anthropic. Nothing goes to the developer; no analytics. Password values are masked and never recorded.

DYNAMIC CODE
No code outside the package runs. executeScript only injects packaged files; background and content scripts talk by messages. No eval, new Function, remote scripts or userScripts. Markdown and icons are sanitized by an allowlist (sidebar/markdown.js) before insertion. The developer build's javascript_exec tool (extension/js-exec.js) is removed from this package by scripts/sign-amo.mjs.

BUILD
No bundler or minifier: this is the repo's extension/ folder minus js-exec.js. Reproduce: npm ci && npm run sign:amo -- --dry-run (output in dist/amo/extension/).
