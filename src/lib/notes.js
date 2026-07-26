import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import { findAudioFiles, reporter } from "./sync.js";
import { parseCues } from "./vtt.js";
import { getDurationSeconds, recordedDate } from "./media.js";

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
 * Builds the per-note data model the page renders from. `rel` doubles as the
 * note's id in every API call, so it's always a target-relative, forward-slash
 * path (the server resolves it back and refuses anything escaping the target).
 *
 * `onProgress` is how a caller shows this taking its time - an ffprobe per file
 * makes a large library a long silence otherwise. It's a callback rather than
 * any printing of our own because `lib/` is shared with the browser path, which
 * has no terminal to draw on. Events are `{ phase: "scan", dir, found }` while
 * the tree is being walked (no count known yet), then `{ phase: "work", done,
 * total, dir, name }` per file. `findAudioFiles` walks depth-first, so `dir`
 * advances one folder at a time rather than jumping around.
 */
export async function buildNotes(target, { onProgress } = {}) {
  const report = reporter(onProgress);

  const audioFiles = await findAudioFiles(target, { onProgress });
  const total = audioFiles.length;

  const notes = [];
  for (const audioPath of audioFiles) {
    const relRaw = path.relative(target, audioPath);
    const rel = relRaw.split(path.sep).join("/");
    const dirRaw = path.dirname(relRaw);
    // Folder the note lives in, relative to target, normalised to forward
    // slashes ("" for files sitting directly in the target root).
    const dir = dirRaw === "." ? "" : dirRaw.split(path.sep).join("/");

    // Reported before the work, so what's on screen is the file being read.
    report({ phase: "work", done: notes.length, total, dir, name: path.basename(audioPath) });

    const transcript = await readTranscript(audioPath);

    let size = null;
    try {
      size = (await fs.stat(audioPath)).size;
    } catch {
      // size stays null; the page shows a dash
    }

    // Recording date/time is pre-formatted here (it comes from the recorder's
    // wall-clock filename) so the browser doesn't shift it by time zone.
    const date = await recordedDate(audioPath);
    const durationSec = await getDurationSeconds(audioPath);

    notes.push({
      rel, // id used by every API call
      title: relRaw.split(path.sep).join(" / "),
      dir, // folder for sidebar grouping ("" = target root)
      name: path.basename(audioPath),
      src: "/media/" + rel.split("/").map(encodeURIComponent).join("/"),
      cues: transcript.cues, // [] when there's no timed transcript
      text: transcript.text, // shown when there are no cues
      hasTranscript: transcript.hasTranscript,
      transcriptExt: transcript.transcriptExt,
      size, // bytes, or null
      durationSec, // seconds, or null
      dateMs: date ? date.getTime() : null, // for sorting only
      dateStr: date ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` : "",
      timeStr: date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "",
    });
  }

  report({ phase: "work", done: notes.length, total, dir: "", name: "" });

  // Newest recording first; files with no determinable date sort to the end.
  notes.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));
  return notes;
}
