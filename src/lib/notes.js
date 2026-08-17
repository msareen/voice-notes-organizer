import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import { findAudioFiles, reporter } from "./sync.js";
import { parseCues } from "./vtt.js";
import { getDurationSeconds, recordedDate } from "./media.js";
import { healIfDamaged } from "./special-case-handling.js";
import { loadNotesCache, saveNotesCache } from "./notesCache.js";

// Preference order for a note's transcript: timed formats first (they unlock
// the follow-along highlight), plain text last (shown, but not highlighted).
export const TRANSCRIPT_EXTS = [".vtt", ".srt", ".txt"];

const stripExt = (p) => p.slice(0, -path.extname(p).length);
const pad2 = (n) => String(n).padStart(2, "0");

export async function findTranscript(audioPath) {
  const base = stripExt(audioPath);
  for (const ext of TRANSCRIPT_EXTS) {
    const candidate = base + ext;
    if (await fs.pathExists(candidate)) return { path: candidate, ext };
  }
  return null;
}

/**
 * Resolves a user-provided file name to one of the discovered audio files.
 * Accepts an absolute path, a path relative to the target folder, or a bare
 * filename matched (case-insensitively) against the known audio files.
 *
 * Returns `{ file, matches }`: `file` is null when nothing matched *and* when
 * the name was ambiguous, with `matches` holding the candidates in the second
 * case so the caller can tell the two apart. Printing is left to the caller -
 * see `reportUnresolved`.
 *
 * Shared by `vno transcribe -f` and `vno cleanup -f` so that naming a file
 * means the same thing whichever command you're pointing at it.
 */
export async function resolveNamedFile(name, allAudio, target) {
  const candidates = [];
  if (path.isAbsolute(name)) candidates.push(name);
  candidates.push(path.resolve(target, name));

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      const resolved = path.resolve(candidate);
      const inList = allAudio.find((f) => path.resolve(f) === resolved);
      if (inList) return { file: inList, matches: [inList] };
      // Exists but wasn't discovered as audio (e.g. unsupported extension).
      return { file: resolved, matches: [resolved] };
    }
  }

  // Fall back to matching against just the filename, case-insensitively:
  // exact basename first, then the name with the extension dropped (so
  // "250810_1328" finds "250810_1328.mp3"), then a unique substring match.
  const wanted = path.basename(name).toLowerCase();
  const wantedStem = wanted.slice(0, wanted.length - path.extname(wanted).length) || wanted;
  const baseOf = (f) => path.basename(f).toLowerCase();
  const stemOf = (f) => {
    const b = baseOf(f);
    return b.slice(0, b.length - path.extname(b).length);
  };

  let matches = allAudio.filter((f) => baseOf(f) === wanted);
  if (matches.length === 0) matches = allAudio.filter((f) => stemOf(f) === wantedStem);
  if (matches.length === 0) matches = allAudio.filter((f) => baseOf(f).includes(wantedStem));

  return { file: matches.length === 1 ? matches[0] : null, matches };
}

/**
 * Prints why a `-f` name didn't resolve: either it matched nothing, or it
 * matched several files and the user has to narrow it down. Shared so both
 * commands explain a miss the same way.
 */
export function reportUnresolved(name, result, target) {
  if (result.matches.length > 1) {
    console.log(chalk.yellow(`"${name}" matches ${result.matches.length} files; be more specific:`));
    for (const f of result.matches) console.log(`  - ${path.relative(target, f)}`);
    return;
  }
  console.log(chalk.red(`No audio file matching "${name}" was found in ${target}.`));
}

/** Reads a note's transcript into the shape the page renders from. */
export async function readTranscript(audioPath) {
  const transcript = await findTranscript(audioPath);
  if (!transcript) return { cues: [], text: "", hasTranscript: false, transcriptExt: null };

  const raw = await fs.readFile(transcript.path, "utf8");
  if (transcript.ext === ".txt") {
    return { cues: [], text: raw.trim(), hasTranscript: true, transcriptExt: ".txt" };
  }
  const cues = parseCues(raw);
  return {
    cues,
    text: cues.map((c) => c.text).join("\n"),
    hasTranscript: true,
    transcriptExt: transcript.ext,
  };
}

/**
 * Builds one note's fields. `durationSec` is the one field worth skipping
 * when a cached value is trustworthy (it costs an ffprobe spawn; everything
 * else here is a stat, a regex and a small file read) - pass a number to
 * reuse it, or `undefined` to always probe fresh, which is what a single-file
 * recheck (`refreshNote`) wants.
 */
async function buildNote(target, audioPath, { size, mtimeMs, durationSec } = {}) {
  const relRaw = path.relative(target, audioPath);
  const rel = relRaw.split(path.sep).join("/");
  const dirRaw = path.dirname(relRaw);
  // Folder the note lives in, relative to target, normalised to forward
  // slashes ("" for files sitting directly in the target root).
  const dir = dirRaw === "." ? "" : dirRaw.split(path.sep).join("/");

  // Damaged Samsung recordings are repaired in place before anything reads
  // them (lib/special-case-handling.js). This sits here rather than behind a
  // failed probe or a cache miss because it has to run for every note either
  // way - see `healIfDamaged`. When it fires, the file on disk is a different
  // one, so the passed-in stat and any cached duration describe the old file.
  if (await healIfDamaged(audioPath)) {
    durationSec = undefined;
    const after = await fs.stat(audioPath).catch(() => null);
    if (after) {
      size = after.size;
      mtimeMs = after.mtimeMs;
    }
  }

  const transcript = await readTranscript(audioPath);

  // Recording date/time is pre-formatted here (it comes from the recorder's
  // wall-clock filename) so the browser doesn't shift it by time zone.
  const date = await recordedDate(audioPath);
  if (durationSec === undefined) durationSec = await getDurationSeconds(audioPath);

  return {
    rel, // id used by every API call
    title: relRaw.split(path.sep).join(" / "),
    dir, // folder for sidebar grouping ("" = target root)
    name: path.basename(audioPath),
    src: "/media/" + rel.split("/").map(encodeURIComponent).join("/"),
    cues: transcript.cues, // [] when there's no timed transcript
    text: transcript.text, // shown when there are no cues
    hasTranscript: transcript.hasTranscript,
    transcriptExt: transcript.transcriptExt,
    size: size ?? null, // bytes, or null
    mtimeMs: mtimeMs ?? null, // used to detect a changed file against the cache
    durationSec, // seconds, or null
    dateMs: date ? date.getTime() : null, // for sorting only
    dateStr: date ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` : "",
    timeStr: date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "",
  };
}

/**
 * Builds the per-note data model the page renders from. `rel` doubles as the
 * note's id in every API call, so it's always a target-relative, forward-slash
 * path (the server resolves it back and refuses anything escaping the target).
 *
 * `onProgress` is how a caller shows this taking its time - a full ffprobe
 * sweep makes a large library a long silence otherwise. It's a callback
 * rather than any printing of our own because `lib/` is shared with the
 * browser path, which has no terminal to draw on. Events are `{ phase: "scan",
 * dir, found }` while the tree is being walked (no count known yet), then
 * `{ phase: "work", done, total, dir, name }` per file. `findAudioFiles` walks
 * depth-first, so `dir` advances one folder at a time rather than jumping around.
 *
 * Duration is the slow part (an ffprobe spawn per file), so it's cached on
 * disk keyed by size+mtime (`lib/notesCache.js`) - a file that hasn't changed
 * since the last build is never re-probed. Everything else is cheap enough to
 * always compute fresh, so it can't go stale between builds. Selecting a note
 * in the UI triggers `refreshNote` for a one-file recheck that bypasses the
 * cache, which is what keeps a file edited outside vno from showing stale
 * data indefinitely.
 */
export async function buildNotes(target, { onProgress } = {}) {
  const report = reporter(onProgress);

  const audioFiles = await findAudioFiles(target, { onProgress });
  const total = audioFiles.length;
  const cache = await loadNotesCache(target);
  const nextCache = {};

  const notes = [];
  for (const audioPath of audioFiles) {
    // Reported before the work, so what's on screen is the file being read.
    const relRaw = path.relative(target, audioPath);
    const rel = relRaw.split(path.sep).join("/");
    const dirRaw = path.dirname(relRaw);
    const dir = dirRaw === "." ? "" : dirRaw.split(path.sep).join("/");
    report({ phase: "work", done: notes.length, total, dir, name: path.basename(audioPath) });

    let size = null;
    let mtimeMs = null;
    try {
      const stat = await fs.stat(audioPath);
      size = stat.size;
      mtimeMs = stat.mtimeMs;
    } catch {
      // size/mtime stay null; the page shows a dash, and there's nothing to
      // key a cache entry on, so this file is always re-probed.
    }

    const cached = cache[rel];
    const fresh = cached && size != null && cached.size === size && cached.mtimeMs === mtimeMs;

    const note = await buildNote(target, audioPath, {
      size,
      mtimeMs,
      durationSec: fresh ? cached.durationSec : undefined,
    });

    notes.push(note);
    // Keyed off the note rather than the stat above: an in-place repair inside
    // buildNote replaces the file, and the entry has to describe the one that's
    // there now or every future build re-probes it.
    if (note.size != null) {
      nextCache[rel] = { size: note.size, mtimeMs: note.mtimeMs, durationSec: note.durationSec };
    }
  }

  report({ phase: "work", done: notes.length, total, dir: "", name: "" });
  // Awaited so the cache is actually on disk before a short-lived caller can
  // exit out from under it; saveNotesCache swallows its own errors, so a
  // failed write still can't turn a successful scan into one.
  await saveNotesCache(target, nextCache);

  // Newest recording first; files with no determinable date sort to the end.
  notes.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));
  return notes;
}

/**
 * Rechecks a single note against disk, bypassing the duration cache - the
 * one-file counterpart to `buildNotes`'s full sweep, used when the browser
 * selects a note so a change made outside vno (re-recorded, edited transcript,
 * replaced file) shows up without waiting for the next full rebuild. Updates
 * the on-disk cache entry too, so a subsequent full build doesn't re-probe it.
 */
export async function refreshNote(target, audioPath) {
  let size = null;
  let mtimeMs = null;
  try {
    const stat = await fs.stat(audioPath);
    size = stat.size;
    mtimeMs = stat.mtimeMs;
  } catch {
    // file may be gone; buildNote's own reads will surface that
  }

  const note = await buildNote(target, audioPath, { size, mtimeMs });

  if (note.size != null) {
    const cache = await loadNotesCache(target);
    cache[note.rel] = { size: note.size, mtimeMs: note.mtimeMs, durationSec: note.durationSec };
    await saveNotesCache(target, cache);
  }

  return note;
}
