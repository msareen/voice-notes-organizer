import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import { which } from "./setup.js";
import { resolveBinary, resolveModel } from "./whispercpp.js";

/**
 * Whether whisper.cpp is callable. Resolved by checking the vendored
 * whisper-cpp/bin/ (both install roots) and PATH under any of its binary
 * names, never by running it - a directory scan is instant, unlike the old
 * Python whisper which cost seconds to probe because it booted an interpreter.
 *
 * Installing it (and ffmpeg) is `cli/setup.js`'s job - lib/ never prompts.
 */
export async function isWhisperInstalled() {
  return Boolean(await resolveBinary({}));
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
 * itself is fixed at install time (see lib/whispercpp.js), not chosen here.
 *
 * `onOutput` receives whisper.cpp's output line by line; the viewer uses it
 * to stream progress into the browser. Without it, output goes to the
 * terminal.
 */
export async function transcribeFile(
  filePath,
  { model = "turbo", translate = false, device = "cpu", threads = null, onOutput = null } = {}
) {
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

  const wavPath = path.join(os.tmpdir(), `vno-whisper-${process.pid}-${Date.now()}.wav`);
  try {
    await convertToWav(ffmpeg, filePath, wavPath);
    await runWhisperCpp(binary.path, {
      wavPath,
      modelPath,
      translate,
      device,
      threads: threads || Math.max(1, os.cpus().length - 1),
      outputPrefix,
      onOutput,
    });
  } finally {
    await fs.remove(wavPath).catch(() => {});
  }

  // Belt and braces: a zero exit code with no fresh transcript on disk is
  // still a failure, and the caller is about to report "Saved" otherwise.
  const stats = await fs.stat(transcript).catch(() => null);
  if (!stats || stats.mtimeMs < startedAt - 1000) {
    throw new Error(`whisper.cpp wrote no transcript for ${path.basename(filePath)}`);
  }
}

/** Decodes any input format into the 16kHz mono s16 WAV whisper.cpp requires. */
function convertToWav(ffmpeg, inputPath, wavPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ["-y", "-i", inputPath, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wavPath],
      { windowsHide: true }
    );
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d.toString()));
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

function runWhisperCpp(binaryPath, { wavPath, modelPath, translate, device, threads, outputPrefix, onOutput }) {
  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      modelPath,
      "-f",
      wavPath,
      "-l",
      "auto",
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

    let stderr = "";
    child.stdout.on("data", (d) => {
      const text = d.toString();
      if (onOutput) emitLines(text, onOutput);
      else process.stdout.write(chalk.dim(text));
    });
    child.stderr.on("data", (d) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-MAX_KEPT_OUTPUT);
      // whisper.cpp logs backend selection and progress to stderr, so it's
      // worth surfacing live even though it's also kept for the failure message.
      if (onOutput) emitLines(text, onOutput);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr ? lastLines(stderr) : `whisper.cpp exited with code ${code}`));
        return;
      }
      resolve();
    });
  });
}

/** Splits a chunk of child output into non-empty lines for `onOutput`. */
function emitLines(chunk, onOutput) {
  for (const line of chunk.split(/\r?\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed) onOutput(trimmed);
  }
}

/** The tail of a child's output, trimmed to the useful part of a failure. */
function lastLines(text, count = 20) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-count).join("\n") || "no output";
}

/**
 * Acceleration state and the device decision, replacing lib/gpu.js's torch
 * probe. whisper.cpp has no runtime CUDA/CPU switch the way PyTorch does -
 * the backend (CUDA or Metal, whichever `vno setup` installed - or Vulkan
 * for a Vulkan-capable binary the user pointed at directly, since vno itself
 * ships no Vulkan asset) is fixed by which binary is in use, recorded in
 * install.json, not re-probed on a hot path. `use` is still a real user
 * choice though: `-ng` forces the CPU even on an accelerator-capable build,
 * so "detected, but the user said no" survives.
 */

/** The `accel` block, defaulted, for a config that predates the setting. */
export function accelState(config) {
  return { backend: null, name: null, use: null, resolvedAt: null, ...(config?.accel || {}) };
}

/**
 * The device transcribeFile should run on. A non-CPU build is used unless
 * the user has said no - the browser has nowhere to ask at job time, and
 * "not asked yet" on a machine with a working accelerator build should be
 * fast rather than cautious.
 */
export function resolveAccel(config) {
  const accel = accelState(config);
  return accel.backend && accel.backend !== "cpu" && accel.use !== false ? accel.backend : "cpu";
}

/** Whether the user has an accelerator-capable install they were never asked about. */
export function accelUnasked(config) {
  const accel = accelState(config);
  return Boolean(accel.backend) && accel.backend !== "cpu" && accel.use === null;
}

/**
 * Whether a whisper.cpp failure is about the accelerator rather than the
 * audio. Deliberately narrow - a false positive would retry a genuinely
 * broken file on the CPU and report the wrong cause. ggml's own error text,
 * not torch's - this replaces lib/gpu.js's torch-specific regex.
 */
export function isDeviceError(message) {
  return /ggml_cuda_init|ggml_metal_init|no CUDA-capable device|CUDA error|cudaMalloc|out of memory|ggml_backend_.*failed|CUDA_ERROR/i.test(
    message || ""
  );
}

/**
 * The useful line of a whisper.cpp failure: a build/init failure can print
 * several lines, but also trailing blank ones, so "the last line" isn't it.
 */
export function lastLine(message) {
  const lines = (message || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "no output";
}
