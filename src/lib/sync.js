import fs from "fs-extra";
import path from "node:path";
import { loadDeletionMatcher } from "./ledger.js";

export const AUDIO_EXTENSIONS = new Set([
  ".mp3",
  ".wav",
  ".m4a",
  ".aac",
  ".flac",
  ".ogg",
  ".oga",
  ".wma",
  ".aiff",
  ".opus",
  ".amr",
  ".3gp",
]);

/**
 * Every audio file under `root`, depth-first. The walk itself is slow enough to
 * be worth reporting on a large or network-backed folder, so `onProgress` gets
 * a `{ phase: "scan", dir, found }` per directory entered - `dir` relative to
 * `root`. See `reporter` for why the callback can't break the walk.
 */
export async function findAudioFiles(root, { onProgress } = {}) {
  const results = [];
  await walk(root, results, root, reporter(onProgress));
  return results;
}

async function walk(dir, results, root, report) {
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable directory (permissions, disconnected drive, etc.)
  }
  const rel = path.relative(root, dir);
  report({ phase: "scan", dir: rel ? rel.split(path.sep).join("/") : "", found: results.length });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(full, results, root, report);
    } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      results.push(full);
    }
  }
}

/**
 * Wraps a progress callback so it can never fail the work it reports on, and
 * so callers that passed nothing don't need a null check at every call site.
 */
export function reporter(onProgress) {
  if (typeof onProgress !== "function") return () => {};
  return (event) => {
    try {
      onProgress(event);
    } catch {
      // reporting is decoration; keep going
    }
  };
}

/**
 * Copies audio files found under `volume.mountPath` into a single, flat
 * `target/<volume.name>/` folder. Devices like voice recorders bury audio
 * several folders deep (e.g. PRIVATE/SONY/REC_FILE/FOLDER01/...); mirroring
 * that structure locally is noise, so we drop every recording directly into
 * the one device folder and only keep the substructure in play if two files
 * would otherwise collide by name. Existing imports that were mirrored the
 * old (nested) way are flattened in place first, so re-running heals them.
 *
 * `rememberDeletions` (the config setting of the same name) decides whether
 * recordings previously deleted through vno are left alone instead of being
 * copied back; they're counted separately from ordinary already-there skips.
 *
 * Displaying any of this is the caller's job - the terminal draws a progress
 * bar from `onProgress`, the browser turns the same events into job log lines.
 * That's why nothing here prints: the two callers need different output, and
 * `lib/` can't know which one it's running under.
 */
export async function syncVolume(volume, target, { rememberDeletions = true, onProgress } = {}) {
  const report = reporter(onProgress);
  const destRoot = path.join(target, sanitize(volume.destName || volume.name));
  await fs.ensureDir(destRoot);

  // Read once per volume, not once per file.
  const wasDeleted = await loadDeletionMatcher(target, { enabled: rememberDeletions });
  const isDeleted = (dest, size) => wasDeleted(path.relative(target, dest).split(path.sep).join("/"), size);

  // Self-heal any previously nested import into the flat layout.
  const flattened = await flattenVolumeFolder(destRoot);
  if (flattened > 0) {
    report({ phase: "log", message: `Flattened ${flattened} previously nested file(s) in ${destRoot}.` });
  }

  const files = (await findAudioFiles(volume.mountPath, { onProgress })).sort((a, b) => a.localeCompare(b));
  let copied = 0;
  let skipped = 0;
  let suppressed = 0;
  const copiedFiles = [];
  let done = 0;

  for (const src of files) {
    const label = path.basename(src);
    const rel = path.relative(volume.mountPath, path.dirname(src));
    report({
      phase: "work",
      done,
      total: files.length,
      dir: rel && rel !== "." ? rel.split(path.sep).join("/") : "",
      name: label,
    });
    try {
      const srcSize = (await fs.stat(src)).size;
      const { dest, skip, wasDeletedBefore } = await resolveFlatDest(destRoot, label, srcSize, isDeleted);
      if (skip) {
        if (wasDeletedBefore) suppressed++;
        else skipped++;
        continue;
      }
      await fs.copy(src, dest, { overwrite: true });
      copied++;
      copiedFiles.push(dest);
    } catch (err) {
      report({ phase: "log", level: "warn", message: `Failed to copy ${label}: ${err.message}` });
    } finally {
      done++;
    }
  }

  report({ phase: "work", done, total: files.length, dir: "", name: "" });

  return { destRoot, copied, skipped, suppressed, total: files.length, copiedFiles };
}

/**
 * Picks a flat destination path inside destRoot for a file named `base`.
 * If a same-named file already there has the same size, it's treated as the
 * same recording already imported (skip). If it exists but differs, we look
 * for the next free `name_2.ext`, `name_3.ext`, ... slot. This keeps re-runs
 * idempotent while still handling genuine name collisions between subfolders.
 *
 * `isDeleted` applies the same name+size test to the deletion ledger, so an
 * empty slot that's empty *because the user deleted that recording* stays
 * empty instead of being refilled from the device.
 *
 * Exported so the browser's drag-and-drop upload can reuse the same
 * dedup/collision logic outside of a full `syncVolume` walk.
 */
export async function resolveFlatDest(destRoot, base, srcSize, isDeleted = () => false) {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem}_${n}${ext}`;
    const dest = path.join(destRoot, name);
    if (!(await fs.pathExists(dest))) {
      if (isDeleted(dest, srcSize)) return { dest, skip: true, wasDeletedBefore: true };
      return { dest, skip: false, wasDeletedBefore: false };
    }
    const stat = await fs.stat(dest);
    if (stat.isFile() && stat.size === srcSize) return { dest, skip: true, wasDeletedBefore: false };
  }
}

/**
 * Moves every file nested in subfolders of `folder` up to `folder` itself and
 * removes the emptied subdirectories, so the device folder ends up flat.
 * Returns the number of files moved. Best-effort: unreadable dirs are skipped.
 */
export async function flattenVolumeFolder(folder) {
  let moved = 0;
  let entries;
  try {
    entries = await fs.readdir(folder, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      moved += await moveFilesUp(path.join(folder, entry.name), folder);
    }
  }
  return moved;
}

async function moveFilesUp(dir, root) {
  let moved = 0;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      moved += await moveFilesUp(full, root);
    } else {
      try {
        await fs.move(full, await freeName(root, entry.name), { overwrite: false });
        moved++;
      } catch {
        // leave the file where it is rather than risk clobbering anything
      }
    }
  }
  try {
    await fs.rmdir(dir); // only succeeds once the directory is empty
  } catch {
    // not empty (something couldn't be moved) - leave it in place
  }
  return moved;
}

/** First unused `base`, `base_2`, `base_3`, ... path directly inside `root`. */
async function freeName(root, base) {
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem}_${n}${ext}`;
    const candidate = path.join(root, name);
    if (!(await fs.pathExists(candidate))) return candidate;
  }
}

function sanitize(name) {
  return name.replace(/[<>:"/\\|?*]/g, "_").trim() || "volume";
}
