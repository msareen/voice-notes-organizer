import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/**
 * The server's session token gates every mutating route (delete, import,
 * transcribe, settings...) against drive-by requests from any other page in
 * the browser - loopback is reachable by anything on the machine, including
 * a hostile site's hidden iframe, so the token is what stops that iframe
 * from getting a live session just by loading the page.
 *
 * It used to be regenerated every `vno v` run. Persisting it here instead is
 * what lets an installed PWA's fixed start_url (baked in at install time,
 * with no way to receive a fresh one) keep working across restarts, while
 * still requiring a secret nothing outside the machine can know.
 */

const TOKEN_DIR = path.join(os.homedir(), ".vno");
const TOKEN_FILE = path.join(TOKEN_DIR, "session-token");
const TOKEN_RE = /^[0-9a-f]{48}$/;

export function sessionTokenFilePath(): string {
  return TOKEN_FILE;
}

export async function getSessionToken(): Promise<string> {
  try {
    const existing = (await fs.readFile(TOKEN_FILE, "utf8")).trim();
    if (TOKEN_RE.test(existing)) return existing;
  } catch {
    // missing or unreadable - fall through to generating a fresh one
  }

  const token = crypto.randomBytes(24).toString("hex");
  try {
    await fs.ensureDir(TOKEN_DIR);
    await fs.writeFile(TOKEN_FILE, token, "utf8");
  } catch {
    // Can't persist - the server still works for this run, but a restart
    // (or an installed PWA's fixed start_url) will need a fresh token.
  }
  return token;
}
