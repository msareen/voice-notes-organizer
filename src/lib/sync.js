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
 * Translates a "*"/"?" wildcard pattern into a case-insensitive matcher against
 * a bare filename. "*" matches any run of characters, "?" matches exactly one;
 * everything else is matched literally. Comma-separated patterns match if any
 * one of them does (e.g. "*.mp3,*.wav" — how the UI's multi-select extension
 * picker expresses "several of these"). No existing glob dependency in this
 * repo, and this is the only place that needs one, so it isn't worth adding one.
 */
export function matchGlob(pattern, filename) {
  return pattern
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean)
    .some((p) => {
      const escaped = p.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
      return new RegExp(`^${escaped}$`, "i").test(filename);
    });
}

/**
 * Every audio file under `root`, depth-first. The walk itself is slow enough to
 * be worth reporting on a large or network-backed folder, so `onProgress` gets
 * a `{ phase: "scan", dir, found }` per directory entered - `dir` relative to
 * `root`. See `reporter` for why the callback can't break the walk.
 *
 * `pattern` (a "*"/"?" wildcard) filters by filename instead of the default
 * audio-extension check when given and isn't "*" - used by manually configured
 * source folders that want to restrict what's picked up (see lib/config.js).
 *
 * `recursive` (default true) descends into subfolders; passing false scans
 * only `root` itself. Detected removable volumes never pass this (recorders
 * bury audio several folders deep, so they need the default), but a manually
 * configured source folder defaults to false at the config layer - see
 * lib/config.js:normalizeSources.
 */
export async function findAudioFiles(root, { onProgress, pattern, recursive = true } = {}) {
  const results = [];
  const matches =
    pattern && pattern !== "*"
      ? (name) => matchGlob(pattern, name)
      : (name) => AUDIO_EXTENSIONS.has(path.extname(name).toLowerCase());
  await walk(root, results, root, reporter(onProgress), matches, recursive);
  return results;
}

async function walk(dir, results, root, report, matches, recursive) {
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
      if (recursive) await walk(full, results, root, report, matches, recursive);
    } else if (entry.isFile() && matches(entry.name)) {
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
 * `volume.pattern`, when set, restricts the walk to filenames matching that
 * "*"/"?" wildcard instead of the default audio-extension check - only ever
 * set on manually configured source folders, never on detected volumes.
 *
 * `volume.recursive`, when explicitly false, scans only `volume.mountPath`
 * itself instead of every subfolder - again only ever set on source folders;
 * left undefined for detected volumes so `findAudioFiles` keeps its default
 * (always recursive, since a device's own layout isn't something the user
 * chose).
 *
 * `volume.deleteAfterImport`, when true, removes the source file once it's
 * either freshly copied in or found to already match the destination (a
 * duplicate re-drop of an already-imported file) - also source-folder-only.
 * A file the ledger *suppresses* (the user deliberately deleted this exact
 * target path before) is left alone instead: silently deleting the source's
 * only remaining copy of something the user chose not to import would be
 * wrong. A copy that throws also leaves the source alone. This is the one
 * place `syncVolume` deletes anything - every other caller (detected
 * removable volumes) never sets the flag, so "nothing is ever deleted from
 * the device" still holds for actual hardware.
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

  const files = (await findAudioFiles(volume.mountPath, {
    onProgress,
    pattern: volume.pattern,
    recursive: volume.recursive,
  })).sort((a, b) =>
    a.localeCompare(b)
  );
  let copied = 0;
  let skipped = 0;
  let suppressed = 0;
  let deleted = 0;
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
        if (wasDeletedBefore) {
          suppressed++;
        } else {
          skipped++;
          if (volume.deleteAfterImport) deleted += await tryDeleteSource(src, label, report);
        }
        continue;
      }
      await fs.copy(src, dest, { overwrite: true });
      copied++;
      copiedFiles.push(dest);
      if (volume.deleteAfterImport) deleted += await tryDeleteSource(src, label, report);
    } catch (err) {
      report({ phase: "log", level: "warn", message: `Failed to copy ${label}: ${err.message}` });
    } finally {
      done++;
    }
  }

  report({ phase: "work", done, total: files.length, dir: "", name: "" });

  return { destRoot, copied, skipped, suppressed, deleted, total: files.length, copiedFiles };
}

/** Best-effort source removal after a successful import copy; failures are logged, not thrown. */
async function tryDeleteSource(src, label, report) {
  try {
    await fs.remove(src);
    return 1;
  } catch (err) {
    report({ phase: "log", level: "warn", message: `Imported ${label} but couldn't delete it from the source: ${err.message}` });
    return 0;
  }
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
