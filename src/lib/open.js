import path from "node:path";
import { spawn } from "node:child_process";
import fs from "fs-extra";

function launch(cmd, args) {
  try {
    // windowsHide is deliberately omitted: these calls launch a GUI file
    // manager window for the user to see, not a background helper process -
    // Windows honors the hint on Explorer's own window too, so setting it
    // opens the window invisibly with no error and nothing to show for it.
    spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Hands a file, folder or URL to the OS default handler (Explorer / Finder /
 * xdg-open). Best-effort: a failure is swallowed, since callers always print
 * the path first so the user can open it manually.
 */
export function openPath(target) {
  if (process.platform === "win32") return launch("cmd", ["/c", "start", "", target]);
  if (process.platform === "darwin") return launch("open", [target]);
  return launch("xdg-open", [target]);
}

/**
 * Opens the file manager at a file's containing folder. Selecting the file
 * itself (explorer /select, open -R) is dropped: it depends on Explorer
 * building shell context info for the item, which a broken or unreachable
 * third-party shell extension (cloud-sync tools are common offenders) can
 * make fail silently with no way for us to detect it - opening the plain
 * folder has none of that dependency.
 */
export function revealInFolder(target) {
  const dir = path.dirname(path.resolve(target));
  if (process.platform === "win32") return launch("explorer", [dir]);
  if (process.platform === "darwin") return launch("open", [dir]);
  return launch("xdg-open", [dir]);
}

// Matches the manifest's `name` (web/page.js:renderManifest) - Chrome/Edge
// name an installed PWA's Start Menu shortcut after it verbatim.
const PWA_SHORTCUT_NAME = "Voice Notes.lnk";

/**
 * Finds the Start Menu shortcut an installed PWA leaves behind, so launching
 * `vno v` can open the installed app window instead of a plain browser tab.
 * Windows-only: this mirrors the vno:// protocol handler's own scope
 * (lib/protocol.js), since neither Chrome's nor Edge's PWA install leaves an
 * equivalent well-known shortcut on macOS/Linux to search for. Best-effort -
 * a scan that turns up nothing just means "not installed, or installed
 * somewhere this didn't think to look," not an error.
 */
export async function findInstalledPwaShortcut() {
  if (process.platform !== "win32") return null;

  const roots = [
    process.env.APPDATA && path.join(process.env.APPDATA, "Microsoft", "Windows", "Start Menu", "Programs"),
    process.env.ProgramData &&
      path.join(process.env.ProgramData, "Microsoft", "Windows", "Start Menu", "Programs"),
  ].filter(Boolean);

  for (const root of roots) {
    const found = await findShortcutIn(root, 2);
    if (found) return found;
  }
  return null;
}

async function findShortcutIn(dir, depth) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return null; // folder doesn't exist or isn't readable - not installed here
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.toLowerCase() === PWA_SHORTCUT_NAME.toLowerCase()) return full;
  }
  if (depth <= 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findShortcutIn(path.join(dir, entry.name), depth - 1);
    if (found) return found;
  }
  return null;
}
