/**
 * Spotting a hallucinated transcript from its shape alone.
 *
 * whisper doesn't fail loudly. When it goes wrong it produces fluent,
 * confident, completely fabricated text - usually the same sentence repeated
 * across a stretch of silence, on suspiciously regular timestamps. The
 * process exits 0, the .vtt is well-formed, and nothing in whisper.cpp's
 * output says anything is wrong.
 *
 * So detection has to work off the transcript itself. Everything here reads
 * only the cue text and timings, which is exactly what a .vtt already gives
 * us via lib/notes/vtt.ts's parseCues - no extra whisper.cpp flags, no
 * second output format, no re-decode.
 *
 * Deliberately *not* used: avg_logprob and no_speech_prob. Those are the
 * obvious signals and they're the wrong ones - fabricated text is typically
 * produced with high confidence, which is what makes it fabricated rather
 * than garbled. Text shape catches what confidence misses.
 *
 * Used by lib/whisper/whisper.ts to decide whether the adaptive mode should
 * climb another rung of decodeProfile.ts's LADDER.
 */
import zlib from "node:zlib";
import type { Cue } from "../../types.ts";

/** A stretch of transcript that looks fabricated, and why. */
export interface BadSpan {
  start: number;
  end: number;
  reason: string;
}

/** Tunables, all four detectors' thresholds in one place. */
export interface DetectOptions {
  /** Identical cues in a row before it counts as a loop. */
  maxRepeats?: number;
  /** As `maxRepeats`, but for phrases people genuinely repeat - see COMMON_PHRASES. */
  maxCommonPhraseRepeats?: number;
  /** zlib expansion ratio above which a window is too compressible to be speech. */
  zlibLimit?: number;
  /** Unique-word fraction below which a window is too repetitive to be speech. */
  minUniqueRatio?: number;
  /** Characters per second above which a cue holds more text than is speakable. */
  maxCps?: number;
}

const DEFAULTS: Required<DetectOptions> = {
  maxRepeats: 3,
  maxCommonPhraseRepeats: 10,
  zlibLimit: 3.2,
  minUniqueRatio: 0.35,
  maxCps: 25,
};

/**
 * Short utterances a real person repeats without anything being wrong.
 *
 * This exists because the two things look identical from the transcript.
 * "Thank you." over and over is whisper's single most famous hallucination -
 * it's what the model emits over silence - and it's also exactly what the end
 * of a real call sounds like, or a run of back-channel "yeah"s and "mm-hmm"s
 * through someone else's long answer. Nothing in the text or the timings
 * separates the two.
 *
 * So the rule isn't an exemption, it's a higher bar: three of these in a row
 * is a conversation, `maxCommonPhraseRepeats` of them is a machine stuck in a
 * loop. Anything not on this list still trips at three, because "the quarterly
 * revenue figures came in ahead of plan" said four times running is not
 * something a person does.
 *
 * Entries are compared after `normalize`, so lowercase and unpunctuated. The
 * Devanagari entries are here for the same reason the Hindi/Urdu language pin
 * is - it's a language this tool is actually used in.
 */
export const COMMON_PHRASES: ReadonlySet<string> = new Set([
  // Acknowledgement and back-channel
  "yeah", "yes", "yep", "no", "nope", "ok", "okay", "right", "sure", "alright",
  "mm", "mhm", "mm-hmm", "mmhmm", "uh-huh", "uh huh", "hmm", "huh", "ah", "oh",
  "i see", "got it", "exactly", "of course", "indeed", "true", "fair enough",
  // Openings and closings
  "hello", "hi", "hey", "bye", "goodbye", "bye bye", "see you", "take care",
  "thank you", "thanks", "thank you so much", "thank you very much",
  "thanks a lot", "you're welcome", "please", "sorry", "excuse me",
  "good morning", "good afternoon", "good evening", "good night",
  // Fillers whisper emits as whole cues
  "so", "well", "and", "but", "like", "you know", "i mean", "anyway",
  // Non-speech markers whisper writes when it hears nothing in particular
  "music", "applause", "laughter", "silence", "blank_audio", "inaudible",
  // Hindi - the language pair this tool is most used across
  "धन्यवाद", "शुक्रिया", "हाँ", "हां", "नहीं", "अच्छा", "ठीक है", "जी", "जी हाँ", "नमस्ते",
]);

/** Whether a cue is short enough, and ordinary enough, to be genuinely repeated. */
function isCommonPhrase(normalized: string): boolean {
  if (!normalized) return false;
  // The word cap is doing real work: it stops a long sentence that happens to
  // *begin* with "thank you" from inheriting the relaxed threshold.
  if (normalized.split(" ").length > 4) return false;
  return COMMON_PHRASES.has(normalized) || COMMON_PHRASES.has(normalized.replace(/[[\]()]/g, ""));
}

/** Cue length in seconds, floored away from zero so it's safe to divide by. */
function duration(cue: Cue): number {
  return Math.max(cue.end - cue.start, 1e-6);
}

/** Case, whitespace and trailing punctuation removed, for comparing two cues. */
function normalize(text: string): string {
  return String(text || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .join(" ")
    .replace(/^[.,!?—-]+|[.,!?—-]+$/g, "")
    .trim();
}

/**
 * How much shorter zlib can make this text. Real speech is around 1.5-2.5x;
 * a repeated sentence compresses far better than that, which is the cheapest
 * possible test for "this is the same thing over and over".
 */
function zlibRatio(text: string): number {
  const raw = Buffer.from(text, "utf8");
  // Too short to say anything - deflate's own header would dominate.
  if (raw.length < 16) return 0;
  return raw.length / zlib.deflateSync(raw).length;
}

/**
 * Regions of a transcript that look hallucinated rather than transcribed.
 *
 * Four independent signals, because no single one is reliable on its own:
 *
 *  (a) the same cue text repeated - the classic loop;
 *  (b) a run of identically-sized cues - genuine speech segments vary in
 *      length, so uniform timings mean the timestamps were invented;
 *  (c) a low-diversity / highly-compressible window - catches loops that
 *      vary slightly between repeats, which (a) misses;
 *  (d) more characters than the audio has time for - text that no one could
 *      have said that fast.
 *
 * Overlapping and adjacent hits are merged, so the result is a small set of
 * spans rather than one entry per cue.
 */
export function detectBadSpans(cues: Cue[], options: DetectOptions = {}): BadSpan[] {
  const { maxRepeats, maxCommonPhraseRepeats, zlibLimit, minUniqueRatio, maxCps } = { ...DEFAULTS, ...options };
  const bad: BadSpan[] = [];
  if (!cues || cues.length === 0) return bad;

  // (a) N consecutive cues with identical normalised text. "Thank you" and
  // friends get a much longer rope - see COMMON_PHRASES for why.
  let runStart = 0;
  for (let i = 1; i <= cues.length; i++) {
    const same = i < cues.length && normalize(cues[i].text) === normalize(cues[runStart].text);
    if (same) continue;
    const runLength = i - runStart;
    const text = normalize(cues[runStart].text);
    const limit = isCommonPhrase(text) ? maxCommonPhraseRepeats : maxRepeats;
    if (runLength >= limit && text) {
      bad.push({
        start: cues[runStart].start,
        end: cues[i - 1].end,
        reason: `repeated x${runLength}: "${cues[runStart].text.trim().slice(0, 40)}"`,
      });
    }
    runStart = i;
  }

  // (b) Uniform-duration signature. Only short cues count: a run of identical
  // *long* cues is what a hard `-ml` split legitimately produces.
  //
  // Common phrases are excluded here for the same reason as in (a) and (c),
  // and it matters most of all in this detector: "Yeah." and "Okay." are
  // short by nature, so a conversation with a lot of back-channel piles them
  // into one narrow duration bucket and looks machine-generated on the
  // timings alone. If that really is a loop, (a) catches it at ten.
  const substantive = cues.filter((c) => !isCommonPhrase(normalize(c.text)));
  const counts = new Map<number, number>();
  for (const cue of substantive) {
    const key = Math.round(duration(cue) * 10) / 10;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  let modal = 0;
  let modalCount = 0;
  for (const [value, count] of counts) {
    if (count > modalCount) {
      modal = value;
      modalCount = count;
    }
  }
  if (modalCount >= Math.max(6, substantive.length * 0.5) && modal <= 1.5) {
    const hits = substantive.filter((c) => Math.round(duration(c) * 10) / 10 === modal);
    bad.push({
      start: hits[0].start,
      end: hits[hits.length - 1].end,
      reason: `uniform ${modal}s timestamps across ${modalCount} cues`,
    });
  }

  // (c) Sliding window over lexical diversity and compressibility.
  const window = 8;
  for (let i = 0; i + 1 <= Math.max(cues.length - window + 1, 1); i++) {
    const chunk = cues.slice(i, i + window);
    // Same false positive as (a), and it has to be handled here too or the
    // exemption there is worthless: a run of "yeah" / "okay" / "thank you"
    // is low-diversity and highly compressible by construction. When the
    // whole window is that kind of chatter, (a)'s longer rope is the rule
    // that governs it - if it really is a loop, (a) catches it at ten.
    if (chunk.every((c) => isCommonPhrase(normalize(c.text)))) continue;
    const blob = chunk.map((c) => c.text).join(" ");
    const words = blob.split(/\s+/).filter(Boolean);
    if (words.length < 12) continue;
    const unique = new Set(words.map((w) => w.toLowerCase())).size / words.length;
    const ratio = zlibRatio(blob);
    if (unique < minUniqueRatio || ratio > zlibLimit) {
      bad.push({
        start: chunk[0].start,
        end: chunk[chunk.length - 1].end,
        reason: `low diversity (unique=${unique.toFixed(2)}, zlib=${ratio.toFixed(2)})`,
      });
    }
  }

  // (d) Implausible speech rate. The duration floor keeps a very short cue -
  // where one long word is enough to blow the ratio - from tripping it.
  for (const cue of cues) {
    const seconds = duration(cue);
    if (seconds <= 0.5) continue;
    const cps = cue.text.trim().length / seconds;
    if (cps > maxCps) {
      bad.push({ start: cue.start, end: cue.end, reason: `${Math.round(cps)} chars/sec is not speakable` });
    }
  }

  return mergeSpans(bad);
}

/**
 * Collapses overlapping and near-adjacent spans, keeping every distinct
 * reason. The 2s gap is there because two detectors firing on the same loop
 * rarely agree on its exact edges.
 */
export function mergeSpans(spans: BadSpan[], gap = 2): BadSpan[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const out: BadSpan[] = [{ ...sorted[0] }];
  for (const span of sorted.slice(1)) {
    const last = out[out.length - 1];
    if (span.start <= last.end + gap) {
      last.end = Math.max(last.end, span.end);
      if (!last.reason.includes(span.reason)) last.reason += `; ${span.reason}`;
    } else {
      out.push({ ...span });
    }
  }
  return out;
}

/**
 * Total seconds flagged. This is the score the adaptive mode ranks rungs by -
 * a retry only replaces the transcript it was trying to improve on if it
 * flags strictly less, so a rung that makes things worse can't cost the user
 * a usable result.
 */
export function flaggedSeconds(spans: BadSpan[]): number {
  return spans.reduce((total, s) => total + Math.max(0, s.end - s.start), 0);
}
