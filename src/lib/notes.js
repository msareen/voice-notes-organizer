import fs from "fs-extra";
import path from "node:path";
import { findAudioFiles } from "./sync.js";
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
 */
export async function buildNotes(target) {
  const audioFiles = await findAudioFiles(target);

  const notes = [];
  for (const audioPath of audioFiles) {
    const relRaw = path.relative(target, audioPath);
    const rel = relRaw.split(path.sep).join("/");
    const dirRaw = path.dirname(relRaw);
    // Folder the note lives in, relative to target, normalised to forward
    // slashes ("" for files sitting directly in the target root).
    const dir = dirRaw === "." ? "" : dirRaw.split(path.sep).join("/");

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

  // Newest recording first; files with no determinable date sort to the end.
  notes.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));
  return notes;
}
