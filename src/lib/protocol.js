import { fileURLToPath } from "node:url";
import { runStep } from "./setup.js";

/**
 * Registers `vno://` as a Windows URL protocol, so a browser link/navigation
 * to it triggers the OS's native "Open vno?" dialog - the same mechanism
 * `msteams://` and `zoommtg://` links use - and, on approval, launches
 * `vno v` (via `vno open-protocol`, bin/vno.js's handler for it).
 *
 * Windows-only for now: macOS needs an actual .app bundle with the scheme
 * declared in its Info.plist (a bare script can't be registered with
 * LaunchServices), and Linux needs a .desktop file plus `xdg-mime` - both
 * meaningfully more work than a registry key, and left for later.
 *
 * HKEY_CURRENT_USER rather than HKEY_CLASSES_ROOT/HKLM: per-user, so it
 * needs no elevation, matching every other part of setup that installs
 * without asking for admin.
 */

const SCHEME = "vno";
const KEY_ROOT = `HKCU\\Software\\Classes\\${SCHEME}`;
const KEY_COMMAND = `${KEY_ROOT}\\shell\\open\\command`;

/** The exact command line the registry should invoke - also what a stale
 *  registration (an older vno install's paths) is compared against. */
export function protocolCommandLine() {
  const vnoJs = fileURLToPath(new URL("../../bin/vno.js", import.meta.url));
  return `"${process.execPath}" "${vnoJs}" open-protocol "%1"`;
}

/** Reads the currently registered command line, or null if nothing's registered. */
async function readRegisteredCommand() {
  const result = await runStep({ command: "reg", args: ["query", KEY_COMMAND, "/ve"] });
  if (!result.ok) return null;

  // `reg query ... /ve` prints the default value on a line shaped like:
  //   (Default)    REG_SZ    "C:\...\node.exe" "C:\...\vno.js" open-protocol "%1"
  const line = result.output.split(/\r?\n/).find((l) => l.includes("REG_SZ"));
  if (!line) return null;
  const value = line.split("REG_SZ")[1];
  return value ? value.trim() : null;
}

/**
 * Current registration state: whether `vno://` is registered at all, and
 * whether it points at *this* install (paths drift after a reinstall
 * somewhere else, or an `npm update` that moves the global install root).
 */
export async function protocolStatus() {
  const registered = await readRegisteredCommand();
  const expected = protocolCommandLine();
  return { registered: registered !== null, current: registered, expected, upToDate: registered === expected };
}

/** Writes the registry keys. Idempotent - safe to call to refresh a stale registration. */
export async function registerProtocol() {
  const command = protocolCommandLine();
  const steps = [
    { command: "reg", args: ["add", KEY_ROOT, "/ve", "/d", "URL:vno Protocol", "/f"] },
    { command: "reg", args: ["add", KEY_ROOT, "/v", "URL Protocol", "/t", "REG_SZ", "/d", "", "/f"] },
    { command: "reg", args: ["add", KEY_COMMAND, "/ve", "/d", command, "/f"] },
  ];
  for (const step of steps) {
    const result = await runStep(step);
    if (!result.ok) return { ok: false, output: result.output };
  }
  return { ok: true };
}

/** Removes the registration entirely. */
export async function unregisterProtocol() {
  const result = await runStep({ command: "reg", args: ["delete", KEY_ROOT, "/f"] });
  return { ok: result.ok, output: result.output };
}
