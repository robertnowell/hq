#!/usr/bin/env node
// Install this Mac's status-only observer after /api/shipping is deployed.
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, writeFile, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
const label = "dev.tranquilitybase.shipping-observer";
const folder = join(homedir(), "Library/Application Support/hq/shipping");
const plist = join(homedir(), "Library/LaunchAgents", `${label}.plist`);
const domain = `gui/${process.getuid()}`;
if (process.argv.includes("--stop")) {
  execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { stdio: "inherit" });
  process.exit(0);
}
await mkdir(folder, { recursive: true, mode: 0o700 });
await mkdir(dirname(plist), { recursive: true });
const script = join(folder, "shipping-status.mjs");
await copyFile(new URL("./shipping-status.mjs", import.meta.url), script); await chmod(script, 0o600);
const gh = execFileSync("/usr/bin/which", ["gh"], { encoding: "utf8" }).trim();
const escape = s => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const str = s => `<string>${escape(s)}</string>`;
await writeFile(plist, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key>${str(label)}
<key>ProgramArguments</key><array>${str(process.execPath)}${str(script)}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key>${str(`${dirname(gh)}:/usr/bin:/bin:/usr/sbin:/sbin`)}</dict>
<key>StartInterval</key><integer>60</integer><key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string><key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key>${str(join(folder, "observer.log"))}
<key>StandardErrorPath</key>${str(join(folder, "observer-error.log"))}
</dict></plist>`, { mode: 0o600 });
try { execFileSync("/bin/launchctl", ["bootout", `${domain}/${label}`], { stdio: "ignore" }); } catch {}
execFileSync("/bin/launchctl", ["bootstrap", domain, plist], { stdio: "inherit" });
console.log("Shipping observer installed. It refreshes private status every minute and never builds or activates the app.");
