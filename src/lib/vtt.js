/**
 * Minimal WebVTT / SRT parsing shared by the transcriber (to derive a plain
 * .txt from whisper's timed .vtt) and the visualizer (to drive the
 * follow-along transcript highlight). No external dependency - the format is
 * simple enough to walk line by line.
 */

/**
 * Turns a timestamp like "00:01:02.500" (VTT) or "00:01:02,500" (SRT) - or
 * the short "01:02.500" form VTT allows - into seconds. Returns NaN if it
 * doesn't look like a timestamp.
 */
export function parseTimestamp(ts) {
  const cleaned = String(ts).trim().replace(",", ".");
  const parts = cleaned.split(":");
  if (parts.length < 2 || parts.length > 3) return NaN;
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return NaN;
    seconds = seconds * 60 + value;
  }
  return seconds;
}

const CUE_LINE =
  /(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}(?::\d{2})?[.,]\d{1,3})/;

/**
 * Parses VTT or SRT content into an array of { start, end, text } cues, with
 * start/end in seconds. Cue numbering, the "WEBVTT" header, NOTE blocks and
 * inline tags are ignored. Works for both formats since the only thing we
 * key on is the "-->" timing line.
 */
export function parseCues(content) {
  const cues = [];
  const lines = String(content).replace(/\r\n?/g, "\n").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(CUE_LINE);
    if (!match) continue;

    const start = parseTimestamp(match[1]);
    const end = parseTimestamp(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const textLines = [];
    i++;
    while (i < lines.length && lines[i].trim() !== "") {
      // Strip simple inline VTT tags (e.g. <c>, <00:00:01.000>) if present.
      textLines.push(lines[i].replace(/<[^>]*>/g, "").trim());
      i++;
    }
    const text = textLines.join(" ").replace(/\s+/g, " ").trim();
    if (text) cues.push({ start, end, text });
  }

  return cues;
}

/** Joins parsed cues back into a plain-text transcript, one cue per line. */
export function cuesToPlainText(cues) {
  return cues.map((c) => c.text).join("\n").trim() + "\n";
}

/** Seconds -> "00:01:02.500", the long VTT timestamp form. */
export function formatTimestamp(seconds) {
  const total = Math.max(0, Number(seconds) || 0);
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  return [
    pad(Math.floor(total / 3600)),
    pad(Math.floor((total % 3600) / 60)),
    pad(Math.floor(total % 60)),
  ].join(":") + "." + pad(Math.round((total % 1) * 1000), 3);
}

/**
 * Renders cues back into a WebVTT document. Used when a transcript is edited
 * in the browser: only the text changes, the original timings are written
 * back verbatim so follow-along highlighting keeps working.
 */
export function serializeCues(cues) {
  const body = cues
    .map((c) => `${formatTimestamp(c.start)} --> ${formatTimestamp(c.end)}\n${String(c.text ?? "").trim()}`)
    .join("\n\n");
  return `WEBVTT\n\n${body}\n`;
}
