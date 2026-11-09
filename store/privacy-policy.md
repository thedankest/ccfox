# ccfox privacy policy

Last updated: November 9, 2026. Applies to the ccfox browser add-on (ID `ccfox@thedankest`)
version 0.7.0 and later, and to the ccfox helper it works with.

ccfox is an unofficial, open-source community project. It is not made by Anthropic. Its
developer (GitHub user thedankest) runs no servers and receives no data from you.

## In short

- ccfox sends page content, screenshots, tab titles and URLs, your interactions with
  pages, and your chat messages **only to programs on your own computer**: the ccfox helper
  and your installed Claude Code.
- **Claude Code sends that data to Anthropic** (or to the provider you set up in Claude
  Code, such as Amazon Bedrock or Google Vertex AI) so Claude can answer and act. That
  happens under your own Claude account and that provider's terms and privacy policy, for
  example https://www.anthropic.com/legal/privacy.
- ccfox has no analytics, telemetry, advertising, tracking or accounts, and it never sends
  anything to its developer.

## What ccfox handles, and when

ccfox only reads a page when Claude uses a browser tool on it, because you asked something
in the side panel or a Claude Code session you started called one of its tools.

| Data | When | Where it goes |
| --- | --- | --- |
| Your side-panel messages and the files you attach | When you send a message | Helper, then Claude Code and its provider. Attached files are saved under `~/.ccfox/workspace/uploads/` so Claude can open them. |
| Title and URL of the tab in front of you, and of tabs you attach | With each side-panel message | Helper, then Claude Code and its provider |
| Titles and URLs of your open tabs | When Claude lists tabs (`tabs_context`) | Helper, then Claude Code and its provider |
| Page text, page outline and form field values | When Claude reads a page (`read_page`, `find`, `get_page_text`) | Helper, then Claude Code and its provider. Password field values are replaced with dots. |
| Screenshots of the visible part of a tab | When Claude takes one | Helper, then Claude Code and its provider. A screenshot shows whatever is on screen. |
| Console messages of a tab | Only tabs Claude has used, captured from then on, kept in the page until it navigates | Helper, then Claude Code and its provider, when Claude reads them |
| Network request list of a tab (method, URL, status, timing; no headers or bodies) | Only tabs Claude has used, kept in memory in the add-on (at most 500 per tab) until the tab closes or Claude releases it | Helper, then Claude Code and its provider, when Claude reads it |
| Your clicks, typing, selections and navigations | Only while you record a workflow, in the tabs you record in | The helper writes them into a Claude Code skill file (`~/.claude/skills/<name>/SKILL.md`) when you save. Values of password, card-number, one-time-code and similar fields are never recorded, and secret-looking URL parameters (tokens, keys, codes) are blanked. Claude reads the file when you run the skill. |

ccfox doesn't read or send cookies, saved passwords, bookmarks or browsing history, and it
doesn't run in private windows (the manifest sets `"incognito": "not_allowed"`).

## What is stored, and where

- **In the browser** (the add-on's local storage): your settings, your side-panel chat
  history (titles, messages, summaries of tool calls) and a cached list of your Claude Code
  skills and plugins. Delete a chat from the panel's history to remove it; removing the
  add-on deletes all of it.
- **On your computer, in `~/.ccfox/`**: the helper, its log (`host.log`: connection
  events, errors, chat ids and the paths of saved files, not message contents), and
  attached files under `workspace/uploads/`.
- **By Claude Code**: Claude Code keeps its own session transcripts (by default under
  `~/.claude/`), as it does for any Claude Code session.

Nothing is stored on any server run by ccfox's developer; there are none.

## Sharing

ccfox's developer doesn't receive, sell or share your data. The only party data goes to is
the AI provider your Claude Code is configured to use, because that is how Claude works.

## Your choices

- Firefox shows ccfox's data use when you install it, and under about:addons >
  ccfox > Permissions and data.
- In the side panel you choose, per site, whether Claude must ask before acting, and you
  can stop Claude at any time.
- Only Claude Code sessions you start yourself can use the browser tools, and only if you
  registered ccfox as an MCP server.
- Uninstall the add-on, and run `npm run uninstall-host` in the ccfox folder and delete
  `~/.ccfox/` to remove the helper and its files.

## Changes and contact

Changes to this policy are published with the add-on and in the GitHub repository. Questions:
https://github.com/thedankest/ccfox/issues
