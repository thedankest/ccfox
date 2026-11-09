# ccfox on addons.mozilla.org: listing

The listing text that `npm run sign:amo` sends lives in `store/amo-metadata.json`. This
file is the human-readable copy, plus what has to be set by hand in the AMO Developer Hub.
Keep the two in sync.

| Field | Value |
| --- | --- |
| Add-on ID | `ccfox@thedankest` (in `extension/manifest.json`; permanent, never change it) |
| Name | ccfox: side panel for Claude Code |
| Slug | `ccfox` (sent in the metadata; it was free on Nov 9, 2026. If AMO rejects it as taken, delete `"slug"` from `amo-metadata.json` and retry) |
| Categories | Web Development (`web-development`) |
| Support site | https://github.com/thedankest/ccfox/issues |
| Homepage | https://github.com/thedankest/ccfox |
| License | MIT (`MIT`) |
| Requires payment, non-free services or software | Yes: Claude Code needs a paid Claude plan or an Anthropic API account |
| Compatibility | Firefox desktop 140 and later (not Firefox for Android) |
| Experimental | No |

The name says what the add-on works with ("for Claude Code") without suggesting it comes
from Anthropic; the summary and description both say it's unofficial.

## Summary (250 of 250 characters, no URLs allowed)

Chat with your own Claude Code in a Zen or Firefox side panel, and let Claude Code sessions read and act in your browser. Needs the free ccfox helper (from GitHub) and Claude Code on your computer. Unofficial community project, not made by Anthropic.

## Description

ccfox puts the Claude Code you already have in the side panel of Zen or Firefox, and lets your Claude Code sessions use that same browser: your own profile, tabs and logged-in sites.

**Before you install: ccfox does nothing on its own.** It needs two things on your computer:

1. **Claude Code**, installed and logged in (check with `claude --version`). ccfox has no account or API key of its own; it runs your `claude`, with your Claude login and plan. Claude Code needs a paid Claude plan or an Anthropic API account.
2. **The ccfox helper**, a small local program that connects the add-on to Claude Code. Install it from GitHub (macOS; Linux is untested; Windows isn't supported): clone https://github.com/thedankest/ccfox, then run `npm install` and `npm run install-host` (needs Node.js 20 or later). You can skip the README's steps about installing an unsigned add-on file.

**What it does**

- **Side panel chat.** Press Alt+Shift+C or click the toolbar button and ask Claude about the page in front of you. Attach files, screenshots or other tabs. Claude can read the page, click, type, fill forms and take screenshots, and asks before acting on a site unless you allow it.
- **Browser tools for Claude Code.** Register the helper as an MCP server (`claude mcp add`) and any Claude Code session can open tabs, read pages, click, type and read console and network logs, for example to test a site you're building.
- **Workflow recording.** Show a task once and save it as a Claude Code skill you can run again.
- Tabs Claude opens go into an orange "Claude" tab group, and the tab it's using gets an orange glow.

**Your data.** When you ask Claude to do something, ccfox sends what the task needs (the text and outline of the page, screenshots, tab titles and URLs, console and network logs of tabs Claude is using, your messages and attached files) through the local helper to your Claude Code, which sends it to Anthropic (or the provider you configured in Claude Code) to generate replies. ccfox's developer runs no servers and collects nothing: no analytics, no ads, no tracking. Password fields are masked. See the privacy policy for details.

**Not official.** ccfox is an independent, open-source (MIT) community project. It is not made, endorsed or supported by Anthropic. Claude and Claude Code are trademarks of Anthropic.

Source code, issues and setup help: https://github.com/thedankest/ccfox

## Release notes for 0.7.0

First release on addons.mozilla.org. Permanent add-on ID, Firefox data-collection disclosure, and no runtime code execution in this build (javascript_exec is in the developer build only).

## Data collection (from the manifest)

`browser_specific_settings.gecko.data_collection_permissions.required`, shown in Firefox's
install prompt:

| Category | Why |
| --- | --- |
| `websiteContent` | Page text, the page outline (including form field values; password values are masked), screenshots, console messages and network request URLs of the tabs Claude works in. |
| `browsingActivity` | Titles and URLs of open tabs (tabs_context, the side panel's "current tab" context, tabs attached to a message). |
| `websiteActivity` | Workflow recording captures your clicks, typing (not passwords, card numbers or one-time codes), selections and navigations; Claude's own clicks and typing report what happened on the page. |
| `personalCommunications` | Your side-panel chat messages and attached files go to Claude. |

All of it goes to the local ccfox helper and, through the user's Claude Code, to Anthropic.
No optional categories: ccfox sends no technical or usage data.

## Set by hand in the AMO Developer Hub

`web-ext sign` doesn't send these:

1. **Icon**: upload `docs/icon.png` (512×512; AMO scales it) on the product page editor.
2. **Screenshots**: `store/screenshots/01-side-panel.png` to `05-mcp.png` (1280×800, AMO's largest display size), in that order. Captions, matching the headline in each image:
   1. Claude Code, right next to the page: it reads the page, and asks before it clicks, types or runs a command.
   2. Tabs Claude opens go into an orange "Claude" tab group; the tab it's working in glows.
   3. Attach files, a screenshot or other tabs, and pick skills, plugins and agents with /.
   4. Record a task once and save it as a Claude Code skill.
   5. Add ccfox as an MCP server and Claude Code can use your browser.
3. **Privacy policy**: paste `store/privacy-policy.md` into the add-on's Privacy Policy field in the Developer Hub (web-ext can't send it; the API's `eula_policy` endpoint could).
4. **Support email** (optional): the support site above is enough.
5. **Reviewer notes** go in automatically (as the version's approval notes, from `store/reviewer-notes.md`); check they're there under the version's "Notes for Reviewers", and re-paste if a later upload doesn't carry them.

Later versions: `npm run sign:amo` sends this metadata again with each listed version, so make
listing edits in `amo-metadata.json` (and here), not only in the Developer Hub.
