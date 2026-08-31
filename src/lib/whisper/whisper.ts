import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import { which } from "../setup.ts";
import { resolveBinary, resolveModel, resolveVadModel } from "./whispercpp.ts";
import { normalizeLanguageMap } from "../shared/languages.ts";
import { repairSamsungM4A } from "../import/special-case-handling.ts";
import { parseCues, serializeCues } from "../notes/vtt.ts";
import { decodeArgs, neutralKnobs, LADDER } from "./decodeProfile.ts";
import { detectBadSpans, flaggedSeconds } from "./detect-hallucination.ts";
import type { DecodePlan } from "./decodeProfile.ts";
import type { AccelBackend, AccelState, Config, CrossLanguage, Cue } from "../../types.ts";

/** Receives whisper.cpp's output line by line. */
export type OutputCallback = (line: string) => void;

/**
 * Marks a line passed to `onOutput` as the job's current headline status -
 * e.g. "adaptive decode is retrying with a more conservative pass" - rather
 * than just one more line in the scrollback. context.ts:jobLog looks for this
 * prefix and mirrors the (stripped) line onto `job.status`, which the job
 * strip renders without the browser having to open the log panel.
 */
export const STATUS_PREFIX = "▸ ";

/** Thrown when a caller's AbortSignal fires mid-run; never a real transcription failure. */
export class TranscriptionCancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "TranscriptionCancelled";
  }
}

/**
 * Thrown by convertToWav when ffmpeg's own input listing shows no audio
 * stream at all - a screen recording with the mic muted/not granted, for
 * instance. Distinct from a genuine decode failure: there's no "-l"/model
 * combination that will ever produce speech from a file that never had
 * audio, so transcribeFile treats this as "nothing to transcribe" rather
 * than an error worth surfacing as a failure.
 */
export class NoAudioTrackError extends Error {
  constructor(fileName: string) {
    super(`${fileName} has no audio track`);
    this.name = "NoAudioTrackError";
  }
}

function throwIfAborted(signal: AbortSignal | null | undefined): void {
  if (signal?.aborted) throw new TranscriptionCancelled();
}

/**
 * Whether whisper.cpp is callable. Resolved by checking the vendored
 * whisper-cpp/bin/ (both install roots) and PATH under any of its binary
 * names, never by running it - a directory scan is instant, unlike the old
 * Python whisper which cost seconds to probe because it booted an interpreter.
 *
 * Installing it (and ffmpeg) is `cli/setup.ts`'s job - lib/ never prompts.
 */
export async function isWhisperInstalled(): Promise<boolean> {
  return Boolean(await resolveBinary({}));
}

export interface TranscribeOptions {
  model?: string;
  translate?: boolean;
  /** "cpu" forces `-ng`; anything else lets the binary use its built-in backend. */
  device?: string;
  threads?: number | null;
  onOutput?: OutputCallback | null;
  language?: string;
  crossLanguage?: CrossLanguage | null;
  /** Which decode strategy to run - see lib/whisper/decodeProfile.ts. Omitted = "auto". */
  decode?: DecodePlan | null;
  /** Aborting this kills the in-flight ffmpeg/whisper.cpp child and rejects with TranscriptionCancelled. */
  signal?: AbortSignal | null;
}

/**
 * Runs whisper.cpp on a single audio file, writing a timed transcript (.vtt)
 * next to the source file. VTT is plain, human-readable text plus the timing
 * that powers the follow-along highlight in `vno visualize`, so it's the
 * only transcript we keep - the rest of the tool keys off the `.vtt`.
 *
 * whisper.cpp only accepts 16kHz mono 16-bit PCM WAV, so every input is
 * first decoded through ffmpeg into a temp file, deleted in `finally` so a
 * mid-run throw can't leak gigabytes into the OS temp directory.
 *
 * With `translate: true` whisper.cpp translates into English instead of
 * transcribing verbatim (`-tr`). `device` is "cuda" (or another non-cpu
 * accelerator) to let the binary use whatever backend it was built with, or
 * "cpu" to force `-ng` even on an accelerator-capable build - the backend
 * itself is fixed at install time (see lib/whisper/whispercpp.ts), not chosen here.
 *
 * `crossLanguage` ({ model, map }) guides auto-detect rather than overriding
 * it: with a model set, a fast `-dl` pass decides the language first and its
 * answer is rewritten through `map` before the real run. Ignored unless
 * `language` is "auto" - a pinned language is the more specific instruction.
 *
 * `decode` picks how hard to work for a clean transcript: "auto" is one pass
 * on whisper.cpp's defaults, "manual" is one pass on the caller's flags, and
 * "adaptive" starts as "auto" then re-reads the transcript and retries on
 * more conservative settings if it looks hallucinated. See
 * lib/whisper/decodeProfile.ts; omitting it means "auto".
 *
 * `onOutput` receives whisper.cpp's output line by line; the viewer uses it
 * to stream progress into the browser. Without it, output goes to the
 * terminal.
 */
export async function transcribeFile(
  filePath: string,
  {
    model = "turbo",
    translate = false,
    device = "cpu",
    threads = null,
    onOutput = null,
    language = "auto",
    crossLanguage = null,
    decode = null,
    signal = null,
  }: TranscribeOptions = {}
): Promise<void> {
  const startedAt = Date.now();
  const outputDir = path.dirname(filePath);
  const baseName = path.basename(filePath, path.extname(filePath));
  const outputPrefix = path.join(outputDir, baseName);
  const transcript = `${outputPrefix}.vtt`;

  const binary = await resolveBinary({});
  if (!binary) {
    throw new Error("whisper.cpp isn't installed. Run `vno setup` to install it.");
  }
  const modelPath = await resolveModel(model);
  if (!modelPath) {
    throw new Error(`The "${model}" model isn't installed. Run \`vno setup --model ${model}\` to download it.`);
  }
  const ffmpeg = await which("ffmpeg");
  if (!ffmpeg) {
    throw new Error("ffmpeg isn't installed. Run `vno setup` to install it.");
  }

  // Runs the convert+transcribe+verify pipeline against a single input file.
  // Split out so it can be retried once against a repaired copy: a truncated
  // Samsung .m4a (see special-case-handling.ts) doesn't always make ffmpeg
  // *throw* - ffmpeg can open just enough of a mangled moov to exit 0 on a
  // near-empty decode, which whisper.cpp then also exits 0 on (0 timings, no
  // segments), so the real signal is the "no transcript on disk" check below,
  // not a caught exception from convertToWav.
  async function attempt(inputPath: string): Promise<void> {
    const wavPath = path.join(os.tmpdir(), `vno-whisper-${process.pid}-${Date.now()}.wav`);
    let whisperOutput = "";
    try {
      throwIfAborted(signal);
      announce("Converting to WAV...", onOutput);
      await convertToWav(ffmpeg!, inputPath, wavPath, signal);
      // Runs against the WAV we just made, so guiding the language costs a
      // model load and one 30s encoder window - not a second conversion.
      const spokenLanguage = await guideLanguage({
        binaryPath: binary!.path,
        wavPath,
        language,
        crossLanguage,
        device,
        threads: threads || Math.max(1, os.cpus().length - 1),
        onOutput,
        signal,
      });
      const plan = decode || { mode: "auto" as const, knobs: neutralKnobs() };
      const job = {
        wavPath,
        modelPath: modelPath!,
        translate,
        device,
        threads: threads || Math.max(1, os.cpus().length - 1),
        language: spokenLanguage,
        onOutput,
        signal,
      };

      announce("Transcribing with whisper.cpp...", onOutput);
      if (plan.mode === "adaptive") {
        // Writes `transcript` itself, from the best rung's cues - so the
        // freshness check below still applies unchanged.
        whisperOutput = await climbLadder(binary!.path, job, { transcript });
      } else {
        // "auto" and "manual" are one pass straight to the final path, the
        // way vno has always done it - no parse, no rewrite, whisper.cpp's
        // own VTT verbatim.
        whisperOutput = await runWhisperCpp(binary!.path, {
          ...job,
          outputPrefix,
          extraArgs: decodeArgs(plan.knobs, await resolveVadModel()),
        });
      }
    } finally {
      await fs.remove(wavPath).catch(() => {});
    }

    // Belt and braces: a zero exit code with no fresh transcript on disk is
    // still a failure (seen with an empty/near-silent recording, or a WAV
    // whisper.cpp accepted but couldn't align any segments in) - and the caller
    // is about to report "Saved" otherwise. Exit code 0 means runWhisperCpp
    // resolved rather than rejected, so there's no thrown error to relay; the
    // last lines of its own stdout/stderr are the only diagnostic there is.
    const stats = await fs.stat(transcript).catch(() => null);
    if (!stats || stats.mtimeMs < startedAt - 1000) {
      const tail = whisperOutput && lastLines(whisperOutput, 8);
      throw new Error(
        `whisper.cpp wrote no transcript for ${path.basename(filePath)}` +
          (tail ? ` - last output:\n${tail}` : " (it produced no output either)")
      );
    }
  }

  try {
    await attempt(filePath);
  } catch (err) {
    // A cancellation is never worth a repair-and-retry - the user asked to stop.
    if (err instanceof TranscriptionCancelled) throw err;
    // No audio track at all (e.g. a screen recording with a muted/absent
    // mic): there's nothing whisper.cpp could ever transcribe here, so
    // write a transcript that says so instead of failing the job the way a
    // genuine decode error would.
    if (err instanceof NoAudioTrackError) {
      status("No audio detected in this recording.", onOutput);
      await fs.writeFile(
        transcript,
        serializeCues([{ start: 0, end: 1, text: "[No audio detected in this recording]" }]),
        "utf8"
      );
      return;
    }
    // Only worth the extra decode/rebuild pass for that one known Samsung
    // shape; any other failure (corrupt audio, unsupported format, a real
    // silent recording, etc.) just propagates as before.
    if (path.extname(filePath).toLowerCase() !== ".m4a") throw err;
    // The repair replaces the recording in place (keeping the damaged file as
    // `<name>.original.m4a`), so the retry runs against the same path and the
    // transcript still lands under the name the user knows.
    const repaired = await repairSamsungM4A(filePath, { onOutput });
    if (!repaired) throw err;
    announce("Retrying transcription with the repaired recording...", onOutput);
    await attempt(repaired);
  }
}

/** Everything a single whisper.cpp pass needs except where to write it. */
interface LadderJob {
  wavPath: string;
  modelPath: string;
  translate: boolean;
  device: string;
  threads: number;
  language: string;
  onOutput: OutputCallback | null;
  signal?: AbortSignal | null;
}

/**
 * The adaptive mode: transcribe, read the result back, and only if it looks
 * hallucinated try again on more conservative settings.
 *
 * The first pass is deliberately identical to what "auto" would have done, so
 * a recording that transcribes cleanly - which is nearly all of them - costs
 * exactly what it always did. Only a file that actually trips a detector in
 * detect-hallucination.ts pays for a retry.
 *
 * Every pass writes to a temp prefix and is parsed back with `parseCues`;
 * the winner is written to the real path here with `serializeCues`. That's
 * the one behavioural difference from the other two modes - the VTT is
 * vno's rendering of whisper.cpp's cues rather than whisper.cpp's own file -
 * and it's unavoidable: picking between four candidate transcripts means
 * holding them somewhere other than the destination.
 *
 * A rung's output only replaces the incumbent if it flags *strictly less*
 * than what's already in hand. A more conservative decode can be worse as
 * easily as better, and escalating must never cost the user a transcript
 * they'd have been happy with.
 *
 * Returns the winning pass's whisper.cpp output, for the caller's failure
 * diagnostics.
 */
async function climbLadder(
  binaryPath: string,
  job: LadderJob,
  { transcript }: { transcript: string }
): Promise<string> {
  const { onOutput, signal } = job;
  const vadModelPath = await resolveVadModel();
  const tempPrefixes: string[] = [];

  // Each pass gets its own prefix: whisper.cpp overwrites `<prefix>.vtt`, and
  // we need the previous best still readable while the next rung runs.
  const nextPrefix = (name: string) =>
    path.join(os.tmpdir(), `vno-decode-${process.pid}-${Date.now()}-${name}`);

  async function pass(name: string, extraArgs: string[], modelPath: string): Promise<{ cues: Cue[]; output: string }> {
    throwIfAborted(signal);
    const prefix = nextPrefix(name);
    tempPrefixes.push(prefix);
    const output = await runWhisperCpp(binaryPath, { ...job, modelPath, outputPrefix: prefix, extraArgs, signal });
    const content = await fs.readFile(`${prefix}.vtt`, "utf8").catch(() => "");
    return { cues: parseCues(content), output };
  }

  try {
    let best = await pass("L0", [], job.modelPath);
    let bestName = "default settings";
    let flagged = detectBadSpans(best.cues);
    // Counted rather than derived from LADDER.length: a rung whose model isn't
    // installed, or that would re-run the model we're already on, is skipped
    // without a pass, and reporting it as an attempt would overstate the work.
    let attempts = 1;

    // Nothing came back at all. That's the silent-recording / mangled-input
    // case, which the caller already handles (including the Samsung repair
    // retry) - and no amount of decode tuning invents speech that isn't
    // there. Hand it back untouched rather than burning three more passes.
    if (best.cues.length === 0) return best.output;

    for (const rung of LADDER) {
      if (flagged.length === 0) break;

      status(
        `Gaps found (${flagged.length}) - attempting the "${rung.name}" pass...`,
        onOutput
      );
      for (const span of flagged) {
        announce(`  flagged ${span.start.toFixed(1)}-${span.end.toFixed(1)}s: ${span.reason}`, onOutput);
      }

      let rungModelPath = job.modelPath;
      if (rung.model) {
        // Never start a multi-gigabyte download inside a transcription job -
        // the user asked for a transcript, not an install.
        const resolved = await resolveModel(rung.model);
        if (!resolved) {
          announce(
            `Skipping the "${rung.name}" retry - it needs the ${rung.model} model. ` +
              `Run \`vno setup --model ${rung.model}\` to make it available.`,
            onOutput
          );
          continue;
        }
        // Already running the model this rung would switch to - which is the
        // normal case for someone whose default is large-v3 rather than turbo.
        // The rung's whole point is the change of model, so with the same
        // weights and the same flags as the previous rung it would spend a
        // full pass reproducing a transcript we already have.
        if (path.resolve(resolved) === path.resolve(job.modelPath)) {
          announce(`Skipping the "${rung.name}" retry - already running ${rung.model}.`, onOutput);
          continue;
        }
        rungModelPath = resolved;
      }

      const candidate = await pass(rung.name, decodeArgs(rung.knobs, vadModelPath), rungModelPath);
      attempts++;
      const candidateFlagged = detectBadSpans(candidate.cues);

      if (candidate.cues.length > 0 && flaggedSeconds(candidateFlagged) < flaggedSeconds(flagged)) {
        best = candidate;
        bestName = rung.name;
        flagged = candidateFlagged;
        if (flagged.length === 0) {
          status(`"${rung.name}" came back clean.`, onOutput);
          break;
        }
        status(`"${rung.name}" is better but still flagged - trying the next one...`, onOutput);
      } else {
        status(`"${rung.name}" was no better - keeping the previous transcript.`, onOutput);
      }
    }

    if (flagged.length > 0) {
      status(
        `Kept the best of ${attempts} attempt${attempts === 1 ? "" : "s"} (${bestName}), but ` +
          `${Math.round(flaggedSeconds(flagged))}s still looks hallucinated. ` +
          "Worth listening back before trusting this one.",
        onOutput
      );
    } else if (bestName !== "default settings") {
      status(`Settled on "${bestName}".`, onOutput);
    }

    await fs.writeFile(transcript, serializeCues(best.cues), "utf8");
    return best.output;
  } finally {
    for (const prefix of tempPrefixes) await fs.remove(`${prefix}.vtt`).catch(() => {});
    // Unused here, but whisper.cpp writes alongside the prefix for any output
    // format it was asked for - cheap insurance against a future flag change.
    for (const prefix of tempPrefixes) await fs.remove(prefix).catch(() => {});
  }
}

interface GuideLanguageArgs {
  binaryPath: string;
  wavPath: string;
  language: string;
  crossLanguage: CrossLanguage | null;
  device: string;
  threads: number;
  onOutput: OutputCallback | null;
  signal?: AbortSignal | null;
}

/**
 * The language to hand `-l`, having optionally let whisper.cpp vote first.
 *
 * whisper.cpp offers no way to bias or restrict auto-detect - `-l` is a pin
 * or nothing, and `--prompt` isn't in play during detection, which runs off a
 * single decoder step over the first 30s. So "auto, but never Urdu" has to be
 * built out here: detect with `-dl`, then rewrite the answer through the
 * user's map. A code with no entry passes through as detected.
 *
 * Every failure path degrades to plain "auto" rather than throwing. The
 * detection is an optimisation on top of what whisper.cpp would have done by
 * itself, so a missing model or an unparsable line must cost the user a
 * better guess, never the transcript.
 */
async function guideLanguage({
  binaryPath,
  wavPath,
  language,
  crossLanguage,
  device,
  threads,
  onOutput,
  signal,
}: GuideLanguageArgs): Promise<string> {
  const { model, map } = crossLanguageState({ crossLanguage });
  if (language !== "auto" || !model) return language;

  const modelPath = await resolveModel(model);
  if (!modelPath) {
    announce(`Language detection needs the "${model}" model - run \`vno setup --model ${model}\`. Detecting as usual instead.`, onOutput);
    return "auto";
  }

  let detected: string | null = null;
  try {
    announce(`Detecting the language with "${model}"...`, onOutput);
    detected = await detectLanguage(binaryPath, { wavPath, modelPath, device, threads, signal });
  } catch (err) {
    if (err instanceof TranscriptionCancelled) throw err;
    announce(`Language detection failed (${lastLine(errorMessage(err))}). Detecting as usual instead.`, onOutput);
    return "auto";
  }
  if (!detected) {
    announce("Language detection returned nothing. Detecting as usual instead.", onOutput);
    return "auto";
  }

  const chosen = map[detected] || detected;
  announce(
    chosen === detected
      ? `Detected ${detected}.`
      : `Detected ${detected}, transcribing as ${chosen}.`,
    onOutput
  );
  return chosen;
}

interface DetectLanguageArgs {
  wavPath: string;
  modelPath: string;
  device: string;
  threads: number;
  signal?: AbortSignal | null;
}

/**
 * Wires an AbortSignal to a spawned child: firing it kills the child and
 * rejects the caller's promise with TranscriptionCancelled instead of
 * whatever exit-code error the kill would otherwise produce. Every spawn in
 * this file goes through it so cancelling a job actually stops the running
 * ffmpeg/whisper.cpp process rather than just the job loop between files.
 */
function killOnAbort(
  child: ReturnType<typeof spawn>,
  signal: AbortSignal | null | undefined,
  reject: (err: Error) => void
): () => void {
  if (!signal) return () => {};
  const onAbort = () => {
    child.kill();
    reject(new TranscriptionCancelled());
  };
  if (signal.aborted) {
    onAbort();
    return () => {};
  }
  signal.addEventListener("abort", onAbort);
  return () => signal.removeEventListener("abort", onAbort);
}

/**
 * One `-dl` pass: whisper.cpp detects the language and exits without
 * transcribing. The answer only ever appears in its log output, so it has to
 * be read back off stderr - there's no machine-readable form of it, which is
 * why this parses rather than asks.
 */
function detectLanguage(
  binaryPath: string,
  { wavPath, modelPath, device, threads, signal }: DetectLanguageArgs
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = ["-m", modelPath, "-f", wavPath, "-l", "auto", "-dl", "-t", String(threads)];
    if (device === "cpu") args.push("-ng");

    const child = spawn(binaryPath, args, { windowsHide: true });
    const cleanup = killOnAbort(child, signal, reject);
    let combined = "";
    // Not streamed to onOutput: this pass prints its own model/backend banner,
    // and repeating that before every file would bury the actual progress.
    const collect = (d: Buffer) => {
      combined = (combined + d.toString()).slice(-MAX_KEPT_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(lastLines(combined, 4)));
        return;
      }
      const match = /auto-detected language:\s*([a-z]{2,3})\b/i.exec(combined);
      resolve(match ? match[1].toLowerCase() : null);
    });
  });
}

/**
 * Announces the start of a phase (WAV conversion, then transcription) so a
 * plain terminal run isn't silent for the whole file - previously the only
 * feedback was whichever of whisper.cpp's stdout/stderr streams happened to
 * carry output, so a run could sit with no visible progress at all.
 */
function announce(message: string, onOutput: OutputCallback | null): void {
  if (onOutput) onOutput(message);
  else console.log(chalk.dim(message));
}

/** Like `announce`, but also marks the line as the job's current headline status - see STATUS_PREFIX. */
function status(message: string, onOutput: OutputCallback | null): void {
  announce(STATUS_PREFIX + message, onOutput);
}

/** Decodes any input format into the 16kHz mono s16 WAV whisper.cpp requires. */
function convertToWav(ffmpeg: string, inputPath: string, wavPath: string, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { windowsHide: true }
    );
    const cleanup = killOnAbort(child, signal, reject);
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        // ffmpeg lists every input stream before it starts converting, so
        // "no Audio: stream in the input listing" is a reliable signal that
        // this file never had audio to decode - not just that this
        // particular attempt failed. Checked ahead of the input's own
        // "Stream #0:0" marker so we don't false-positive on an unrelated
        // "Audio:" mention later in the log (e.g. an output-side error).
        const inputSection = stderr.split(/^Output #0/m)[0];
        const hasAudioStream = /Stream #\d+:\d+(?:\[[^\]]*\])?(?:\([^)]*\))?:\s*Audio:/.test(inputSection);
        if (!hasAudioStream) reject(new NoAudioTrackError(path.basename(inputPath)));
        else reject(new Error(`ffmpeg couldn't decode ${path.basename(inputPath)}:\n${lastLines(stderr)}`));
      } else resolve();
    });
  });
}

// Caps how much of a child's output is kept for an error message. whisper.cpp
// (like ffmpeg) can print a line per segment on a long file, and holding all
// of it just to report a failure would be a needless multi-megabyte retention.
const MAX_KEPT_OUTPUT = 64 * 1024;

interface RunWhisperArgs {
  wavPath: string;
  modelPath: string;
  translate: boolean;
  device: string;
  threads: number;
  outputPrefix: string;
  onOutput: OutputCallback | null;
  language?: string;
  /** Decode flags from lib/whisper/decodeProfile.ts, appended last. */
  extraArgs?: string[];
  signal?: AbortSignal | null;
}

function runWhisperCpp(
  binaryPath: string,
  {
    wavPath,
    modelPath,
    translate,
    device,
    threads,
    outputPrefix,
    onOutput,
    language = "auto",
    extraArgs = [],
    signal,
  }: RunWhisperArgs
): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      modelPath,
      "-f",
      wavPath,
      "-l",
      language,
      "-ovtt",
      "-of",
      outputPrefix,
      "-t",
      String(threads),
    ];
    if (translate) args.push("-tr");
    // The backend a binary was built with is fixed at install time; `-ng`
    // is the one runtime lever left, for a user who wants to force the CPU
    // on an accelerator-capable build.
    if (device === "cpu") args.push("-ng");
    // Last, so a decode profile can override anything above it - whisper.cpp
    // takes the final occurrence of a repeated flag.
    args.push(...extraArgs);

    const child = spawn(binaryPath, args, { windowsHide: true });
    const cleanup = killOnAbort(child, signal, reject);

    // Both streams are kept (not just stderr) so a clean exit that still
    // wrote no transcript - whisper.cpp does this for a silent/near-empty
    // recording - has something to show beyond a bare "no transcript" error.
    let combined = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      combined = (combined + text).slice(-MAX_KEPT_OUTPUT);
      if (onOutput) emitLines(text, onOutput);
      else process.stdout.write(chalk.dim(text));
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-MAX_KEPT_OUTPUT);
      combined = (combined + text).slice(-MAX_KEPT_OUTPUT);
      // whisper.cpp logs backend selection and progress to stderr, so it's
      // worth surfacing live (same as stdout) even though it's also kept for
      // the failure message.
      if (onOutput) emitLines(text, onOutput);
      else process.stdout.write(chalk.dim(text));
    });
    child.on("error", (err) => {
      cleanup();
      reject(err);
    });
    child.on("close", (code) => {
      cleanup();
      if (code !== 0) {
        reject(new Error(stderr ? lastLines(stderr) : `whisper.cpp exited with code ${code}`));
        return;
      }
      resolve(combined);
    });
  });
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Splits a chunk of child output into non-empty lines for `onOutput`. */
function emitLines(chunk: string, onOutput: OutputCallback): void {
  for (const line of chunk.split(/\r?\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed) onOutput(trimmed);
  }
}

/** The tail of a child's output, trimmed to the useful part of a failure. */
function lastLines(text: string, count = 20): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-count).join("\n") || "no output";
}

/**
 * Acceleration state and the device decision, replacing lib/gpu.js's torch
 * probe. whisper.cpp has no runtime CUDA/CPU switch the way PyTorch does -
 * the backend (CUDA or Metal, whichever `vno setup` installed - or Vulkan
 * for a Vulkan-capable binary the user pointed at directly, since vno itself
 * ships no Vulkan asset) is fixed by which binary is in use, recorded in
 * vno-install.json, not re-probed on a hot path. `use` is still a real user
 * choice though: `-ng` forces the CPU even on an accelerator-capable build,
 * so "detected, but the user said no" survives.
 */

/** What the accel helpers accept: a whole config, or just the block. */
type AccelConfigLike = { accel?: Partial<AccelState> | null } | null | undefined;

/** The `accel` block, defaulted, for a config that predates the setting. */
export function accelState(config: AccelConfigLike): AccelState {
  return { backend: null, name: null, use: null, resolvedAt: null, ...(config?.accel || {}) };
}

/**
 * The device transcribeFile should run on. A non-CPU build is used unless
 * the user has said no - the browser has nowhere to ask at job time, and
 * "not asked yet" on a machine with a working accelerator build should be
 * fast rather than cautious.
 */
export function resolveAccel(config: AccelConfigLike): AccelBackend {
  const accel = accelState(config);
  return accel.backend && accel.backend !== "cpu" && accel.use !== false ? accel.backend : "cpu";
}

/** Whether the user has an accelerator-capable install they were never asked about. */
export function accelUnasked(config: AccelConfigLike): boolean {
  const accel = accelState(config);
  return Boolean(accel.backend) && accel.backend !== "cpu" && accel.use === null;
}

/** What the language helpers accept: a whole config, or just the block. */
type CrossLanguageConfigLike =
  | { crossLanguage?: Partial<CrossLanguage> | null }
  | null
  | undefined;

/** The `crossLanguage` block, defaulted, for a config that predates it. */
export function crossLanguageState(config: CrossLanguageConfigLike): CrossLanguage {
  const raw = config?.crossLanguage || {};
  return { model: raw.model || null, map: normalizeLanguageMap(raw.map) };
}

export interface LanguagePlan {
  language: string;
  crossLanguage: CrossLanguage;
}

/**
 * Everything the language decision needs, read from config in one place -
 * the `resolveAccel` of languages, and for the same reason: the browser has
 * nowhere to ask at job time, so the rule has to live somewhere both paths
 * call rather than being re-derived at each call site.
 *
 * A pinned `transcribeLanguage` wins outright: it's the more specific
 * instruction, and detecting only to overrule it would waste a model load.
 *
 * `override` is a per-job pin from the Transcribe dialog's own language
 * dropdown (single-take re-transcribe only) - it takes the same "wins
 * outright" treatment as the configured pin, without writing it back to
 * config, since it's a one-off for this run rather than a standing setting.
 */
export function resolveLanguagePlan(config: Partial<Config> | null | undefined, override?: string | null): LanguagePlan {
  const language = override || config?.transcribeLanguage || "auto";
  const cross = crossLanguageState(config);
  return { language, crossLanguage: language === "auto" ? cross : { model: null, map: {} } };
}

/**
 * Whether a whisper.cpp failure is about the accelerator rather than the
 * audio. Deliberately narrow - a false positive would retry a genuinely
 * broken file on the CPU and report the wrong cause. ggml's own error text,
 * not torch's - this replaces lib/gpu.js's torch-specific regex.
 */
export function isDeviceError(message: string | null | undefined): boolean {
  return /ggml_cuda_init|ggml_metal_init|no CUDA-capable device|CUDA error|cudaMalloc|out of memory|ggml_backend_.*failed|CUDA_ERROR/i.test(
    message || ""
  );
}

/**
 * The useful line of a whisper.cpp failure: a build/init failure can print
 * several lines, but also trailing blank ones, so "the last line" isn't it.
 */
export function lastLine(message: string | null | undefined): string {
  const lines = (message || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "no output";
}
