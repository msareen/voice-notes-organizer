import path from "node:path";
import { spawn } from "node:child_process";

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
