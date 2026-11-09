Notes for reviewers: ccfox 0.7.0

WHAT IT IS
ccfox is a side panel for Claude Code (Anthropic's command-line coding agent, which the user installs and logs in to separately) and a set of browser tools Claude Code can use. The add-on does nothing by itself: all AI work happens in the user's own Claude Code, reached through a native messaging helper. Unofficial open-source project (MIT): https://github.com/thedankest/ccfox

NATIVE HELPER REQUIRED
The add-on talks to a native messaging host named "ccfox" (allowed_extensions includes ccfox@thedankest). The helper is plain Node.js in the same repository (host/native-host.mjs, server/mcp-server.mjs, server/tools.mjs); it isn't bundled or minified. It runs Claude Agent SDK sessions on the user's installed `claude` binary and exposes the browser tools over MCP. It listens only on a private Unix socket (~/.ccfox/bridge.sock, mode 0600 in a 0700 directory), never on the network.

HOW TO TEST (macOS; Linux should work)
1. Install Node.js 20+, then:
     git clone https://github.com/thedankest/ccfox && cd ccfox && npm install && npm run install-host
   This copies the helper to ~/.ccfox/app and registers the native messaging manifest for Firefox and Zen. (It also builds a developer XPI in dist/; ignore that, install the reviewed add-on instead.)
2. Install this add-on in Firefox 140+ and restart Firefox. The toolbar icon loses its "!" badge once the helper is connected.
3. Without a Claude account you can exercise every browser tool from a terminal through the MCP server the helper provides:
     node dev/call.mjs tabs_create '{"url":"https://example.com"}'
     node dev/call.mjs read_page '{"filter":"interactive"}'
     node dev/call.mjs find '{"query":"More information"}'
     node dev/call.mjs computer '{"action":"screenshot"}'      (saves a PNG)
     node dev/call.mjs computer '{"action":"left_click","ref":"<a ref_N from read_page>"}'
     node dev/call.mjs get_page_text
     node dev/call.mjs javascript_exec '{"code":"document.title"}'   (returns the "not available in this build" error)
   The tab Claude uses gets an orange glow and pill, and tabs it opens join an orange "Claude" tab group.
4. Side panel (Alt+Shift+C or the toolbar button): with Claude Code installed and logged in, type a request such as "Summarize this page". Reading is automatic; clicking, typing and navigating ask for approval first (Deny / Allow once / Always allow on <site>). Without Claude Code the panel shows "Claude Code isn't installed."
5. Workflow recording: in the panel's menu choose "Record a workflow", click around a page, stop, review the steps and save; the helper writes ~/.claude/skills/<name>/SKILL.md.
The repository's automated tests (npm test, npm run test:panel) drive a headless browser the same way.

PERMISSIONS
- nativeMessaging: the only channel to the helper and so to Claude Code.
- <all_urls>: the browser tools work on whatever site the user or Claude Code points them at: injecting the packaged content scripts (content/agent.js reads the page and dispatches clicks/typing; overlay.js draws the "Claude is working here" highlight; recorder.js records a workflow the user starts; console-hook.js captures console output of Claude's tabs), tabs.captureTab for screenshots, and observing requests of Claude's tabs.
- tabs: list tabs with titles and URLs, open/switch/close/navigate tabs, capture screenshots.
- tabGroups: put tabs Claude opens into one "Claude" group (it never moves the user's own tabs; can be turned off in Settings).
- webRequest: read-only log (method, URL, status, timing; no bodies, no blocking) of requests made by tabs Claude has used, for read_network_requests.
- webNavigation: re-inject the console hook and the highlight after navigations in Claude's tabs, and record navigations during workflow recording.
- storage: settings and side-panel chat history, locally.
- "incognito": "not_allowed": ccfox never runs in private windows.

DATA
Declared in data_collection_permissions.required: websiteContent, browsingActivity, websiteActivity, personalCommunications. Everything goes to the local helper and from there, through the user's Claude Code, to Anthropic (or the provider configured in Claude Code). Nothing goes to the developer: no analytics or remote endpoints anywhere in the add-on. Password field values are masked in page outlines and never recorded. Privacy policy: store/privacy-policy.md in the repository.

DYNAMIC CODE
This build executes no code that isn't in the package:
- Every tabs.executeScript call injects a packaged file ({ file: "/content/..." }). The background talks to those scripts with runtime messages, never code strings.
- No eval, new Function, remote scripts, or userScripts API.
- Rendered Markdown and the panel's icons go through SafeHTML (sidebar/markdown.js): the renderer escapes its input, then the result is parsed with DOMParser into an inert document, reduced to an allowlist of elements and attributes (links must be http/https) and only then inserted. No innerHTML with untrusted data.
- The repository's developer build has one more tool, javascript_exec, which runs JavaScript written by Claude (extension/js-exec.js). That file and its manifest entry are left out of this package by scripts/sign-amo.mjs, because the add-on policies don't allow running code not shipped with the add-on and the userScripts API is reserved for user script managers. background.js only registers that tool if js-exec.js was loaded (`typeof JsExec !== "undefined"`), which never happens in this build; calls to it return an explanatory error.

BUILD
No bundler, minifier or transpiler. The package is the extension/ folder of the repository as written, except that scripts/sign-amo.mjs omits extension/js-exec.js and removes it from manifest.json's background.scripts. Reproduce with: npm ci && npm run sign:amo -- --dry-run (output in dist/amo/extension/).
