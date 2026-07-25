import path from "node:path";
import { spawn } from "node:child_process";

function launch(cmd, args) {
  try {
    spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
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
 * Opens the file manager at a file's location with the file itself selected.
 * Linux has no portable "select this file" verb, so there we just open the
 * containing folder.
 */
export function revealInFolder(target) {
  if (process.platform === "win32") return launch("explorer", [`/select,${path.resolve(target)}`]);
  if (process.platform === "darwin") return launch("open", ["-R", target]);
  return openPath(path.dirname(path.resolve(target)));
}
