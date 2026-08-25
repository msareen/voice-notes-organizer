import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import { which } from "./setup.ts";
import { resolveBinary, resolveModel } from "./whispercpp.ts";
import { normalizeLanguageMap } from "./languages.ts";
import { repairSamsungM4A } from "./special-case-handling.ts";
import type { AccelBackend, AccelState, Config, CrossLanguage } from "../types.ts";

/** Receives whisper.cpp's output line by line. */
export type OutputCallback = (line: string) => void;

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
 * itself is fixed at install time (see lib/whispercpp.ts), not chosen here.
 *
 * `crossLanguage` ({ model, map }) guides auto-detect rather than overriding
 * it: with a model set, a fast `-dl` pass decides the language first and its
 * answer is rewritten through `map` before the real run. Ignored unless
 * `language` is "auto" - a pinned language is the more specific instruction.
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
      announce("Converting to WAV...", onOutput);
      await convertToWav(ffmpeg!, inputPath, wavPath);
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
      });
      announce("Transcribing with whisper.cpp...", onOutput);
      whisperOutput = await runWhisperCpp(binary!.path, {
        wavPath,
        modelPath: modelPath!,
        translate,
        device,
        threads: threads || Math.max(1, os.cpus().length - 1),
        outputPrefix,
        onOutput,
        language: spokenLanguage,
      });
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

interface GuideLanguageArgs {
  binaryPath: string;
  wavPath: string;
  language: string;
  crossLanguage: CrossLanguage | null;
  device: string;
  threads: number;
  onOutput: OutputCallback | null;
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
    detected = await detectLanguage(binaryPath, { wavPath, modelPath, device, threads });
  } catch (err) {
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
}

/**
 * One `-dl` pass: whisper.cpp detects the language and exits without
 * transcribing. The answer only ever appears in its log output, so it has to
 * be read back off stderr - there's no machine-readable form of it, which is
 * why this parses rather than asks.
 */
function detectLanguage(
  binaryPath: string,
  { wavPath, modelPath, device, threads }: DetectLanguageArgs
): Promise<string | null> {
  return new Promise((resolve, reject) => {
    const args = ["-m", modelPath, "-f", wavPath, "-l", "auto", "-dl", "-t", String(threads)];
    if (device === "cpu") args.push("-ng");

    const child = spawn(binaryPath, args, { windowsHide: true });
    let combined = "";
    // Not streamed to onOutput: this pass prints its own model/backend banner,
    // and repeating that before every file would bury the actual progress.
    const collect = (d: Buffer) => {
      combined = (combined + d.toString()).slice(-MAX_KEPT_OUTPUT);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", reject);
    child.on("close", (code) => {
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

/** Decodes any input format into the 16kHz mono s16 WAV whisper.cpp requires. */
function convertToWav(ffmpeg: string, inputPath: string, wavPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { windowsHide: true }
    );
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`ffmpeg couldn't decode ${path.basename(inputPath)}:\n${lastLines(stderr)}`));
      else resolve();
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
}

function runWhisperCpp(
  binaryPath: string,
  { wavPath, modelPath, translate, device, threads, outputPrefix, onOutput, language = "auto" }: RunWhisperArgs
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

    const child = spawn(binaryPath, args, { windowsHide: true });

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
    child.on("error", reject);
    child.on("close", (code) => {
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
