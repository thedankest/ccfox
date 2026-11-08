// Opens a visible, throwaway Zen with ccfox loaded temporarily, next to your normal Zen.
// Fresh profile and its own bridge socket, so your real profile and tabs are untouched.
//   node dev/try-zen.mjs            # prints CCFOX_HOME; Ctrl+C to quit
//   CCFOX_HOME=<printed> node dev/call.mjs tabs_create '{"url":"https://example.com"}'
// Requires `npm run install-host` first.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import webExt from "web-ext";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const fxIdx = argv.indexOf("--firefox");
const firefox = fxIdx >= 0 ? argv[fxIdx + 1] : "/Applications/Zen.app/Contents/MacOS/zen";

// Unix socket paths max out around 104 bytes on macOS, so keep it short.
const home = fs.mkdtempSync(path.join("/tmp", "zc-"));
process.env.CCFOX_HOME = home;

const runner = await webExt.cmd.run(
  {
    sourceDir: path.join(ROOT, "extension"),
    firefox,
    noReload: true,
    noInput: true,
    browserConsole: false,
    // Skip Zen's first-run welcome screen and the "Update Complete!" sidebar popup
    // (shown whenever the profile's last-seen version differs, i.e. always on a fresh one).
    pref: { "zen.welcome-screen.seen": true, "zen.updates.show-update-notification": false },
  },
  { shouldExitProgram: false },
);

const sock = path.join(home, "bridge.sock");
for (let i = 0; i < 100 && !fs.existsSync(sock); i++) await new Promise((r) => setTimeout(r, 200));
console.log(fs.existsSync(sock) ? `ready CCFOX_HOME=${home}` : `native host never created ${sock}; see ${home}/host.log`);

const quit = async () => {
  try { await runner.exit(); } catch {}
  fs.rmSync(home, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", quit);
process.on("SIGTERM", quit);
runner.registerCleanup?.(() => fs.rmSync(home, { recursive: true, force: true }));
