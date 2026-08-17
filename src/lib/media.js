import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import fs from "fs-extra";
import { repairSamsungM4A } from "./special-case-handling.js";

const execFileAsync = promisify(execFile);

async function probeDuration(filePath) {
  const { stdout } = await execFileAsync(
    "ffprobe",
    ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
    { windowsHide: true }
  );
  const value = parseFloat(stdout.trim());
  return Number.isFinite(value) ? value : null;
}

/**
 * Reads duration in seconds via ffprobe (bundled with ffmpeg, which whisper
 * already requires on PATH). Returns null if it can't be determined (e.g.
 * ffprobe isn't installed) so callers can degrade gracefully.
 *
 * A .m4a that won't probe at all gets one repair attempt (see
 * special-case-handling.js) before giving up - a Samsung recording cut badly
 * enough to lose the movie header lands here. The *usual* damage doesn't:
 * duration survives that truncation, so those files probe fine and are healed
 * by `buildNote` instead, which is the one call every recording passes through.
 */
export async function getDurationSeconds(filePath) {
  try {
    return await probeDuration(filePath);
  } catch {
    if (path.extname(filePath).toLowerCase() !== ".m4a") return null;
    const repaired = await repairSamsungM4A(filePath);
    if (!repaired) return null;
    try {
      return await probeDuration(repaired);
    } catch {
      return null;
    }
  }
}

/** "1:23" (m:ss) or "1:02:03" (h:mm:ss); "?" when unknown. */
export function formatDuration(seconds) {
  if (seconds == null || !Number.isFinite(seconds)) return "?";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "2025-08-10 13:28"; "?" for a missing/invalid date. */
export function formatDate(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return "?";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function makeDate(y, mo, d, h, mi, s) {
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || s > 59) return null;
  const dt = new Date(y, mo - 1, d, h, mi, s);
  // Reject values that silently rolled over (e.g. Feb 30 -> Mar 2).
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

/**
 * Extracts a recording date/time embedded in the filename, which is how most
 * voice recorders name their files. Handles common shapes:
 *   250810_1328        -> 2025-08-10 13:28   (YYMMDD_HHMM[SS])
 *   20250810_132845    -> 2025-08-10 13:28   (YYYYMMDD_HHMMSS)
 *   2025-08-10 13.28   -> 2025-08-10 13:28   (with separators)
 * Returns a Date, or null if no plausible date is found.
 */
function parseDateFromName(name) {
  const stem = name.replace(/\.[^.]+$/, "");

  // 4-digit year first, optional time. The year must be plausible (1970-2099)
  // so a YYMMDD_HHMM name like "250810_1328" isn't misread as year 2508 - it
  // falls through to the 2-digit-year branch below instead.
  let m = stem.match(/(\d{4})[-_.]?(\d{2})[-_.]?(\d{2})(?:[-_ .T]?(\d{2})[-_:.]?(\d{2})(?:[-_:.]?(\d{2}))?)?/);
  if (m && +m[1] >= 1970 && +m[1] <= 2099) {
    const dt = makeDate(+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0));
    if (dt) return dt;
  }

  // 2-digit year (assume 20xx) with a separator before the time.
  m = stem.match(/(\d{2})(\d{2})(\d{2})[-_ .T](\d{2})[-_:.]?(\d{2})(?:[-_:.]?(\d{2}))?/);
  if (m) {
    const dt = makeDate(2000 + +m[1], +m[2], +m[3], +m[4], +m[5], +(m[6] ?? 0));
    if (dt) return dt;
  }

  return null;
}

/**
 * Best-effort recording date for a file: the timestamp encoded in its name
 * if present, otherwise the file's modified time. Returns null on failure.
 */
export async function recordedDate(filePath) {
  const fromName = parseDateFromName(path.basename(filePath));
  if (fromName) return fromName;
  try {
    return (await fs.stat(filePath)).mtime;
  } catch {
    return null;
  }
}
