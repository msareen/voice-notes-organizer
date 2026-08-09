import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";

const CACHE_DIR = path.join(os.homedir(), ".vno", "notes-cache");

/**
 * One cache file per target folder (there can be more than one over a user's
 * lifetime - a moved target, a second machine's config copied over), keyed by
 * a hash of the resolved path so nothing has to sanitize it into a filename.
 */
function cacheFileFor(target) {
  const hash = crypto.createHash("sha1").update(path.resolve(target)).digest("hex").slice(0, 20);
  return path.join(CACHE_DIR, `${hash}.json`);
}

/**
 * The expensive-to-compute part of a note (currently just ffprobe's
 * duration), keyed by rel path, alongside the size+mtime it was computed
 * from so a changed file is detected and re-probed rather than trusting a
 * stale value. Corrupt or missing is just "nothing cached" - this file is
 * purely an optimization, never load-bearing, so a read failure can't turn
 * into a build failure.
 */
export async function loadNotesCache(target) {
  try {
    return await fs.readJson(cacheFileFor(target));
  } catch {
    return {};
  }
}

/**
 * Overwrites the cache with exactly the entries passed in - callers rebuild
 * it fresh each time from what's currently on disk, so a renamed or deleted
 * file's stale entry doesn't linger forever. Failure is swallowed the same
 * way a failed write can't turn a successful scan into an error.
 */
export async function saveNotesCache(target, cache) {
  try {
    await fs.ensureDir(CACHE_DIR);
    await fs.writeJson(cacheFileFor(target), cache);
  } catch {
    // best-effort - the next run just re-probes everything
  }
}
