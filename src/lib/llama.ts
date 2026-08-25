import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import { resolveBinary, resolveModel } from "./llamacpp.ts";
import type { AccelBackend, AccelState } from "../types.ts";

/** Receives llama.cpp's output line by line. */
export type OutputCallback = (line: string) => void;

/**
 * Whether llama.cpp is callable - a directory/manifest scan, never a spawn,
 * matching `isWhisperInstalled`'s contract. Summarization is entirely
 * optional, so every caller must check this (or catch the resulting error)
 * rather than assume it's there.
 */
export async function isLlamaInstalled(): Promise<boolean> {
  return Boolean(await resolveBinary({}));
}

const INSTRUCTION =
  "Summarize the following voice-note transcript in a few plain-prose sentences. " +
  "No preamble, no headings, no bullet points - just the summary itself.\n\nTranscript:\n";

// llama.cpp's default context window is small for a chatty voice note; this
// is a conservative cap that keeps prompt + generation comfortably inside
// what a 3-4B instruct model handles well on CPU, matching the `-c` flag
// below. Transcripts longer than this are truncated from the end - a v1
// guard, not chunked map-reduce summarization.
const CONTEXT_TOKENS = 4096;
// Rough chars-per-token for cheap truncation without a tokenizer.
const CHARS_PER_TOKEN = 4;
const MAX_PROMPT_CHARS = (CONTEXT_TOKENS - 256) * CHARS_PER_TOKEN;
const MAX_OUTPUT_TOKENS = 220;

export interface SummarizeOptions {
  model?: string | null;
  /** "cpu" forces -ngl 0; anything else offloads every layer (-ngl 999). */
  device?: string;
  threads?: number | null;
  onOutput?: OutputCallback | null;
}

/**
 * Runs llama.cpp once over `text` (a transcript) and returns a short summary.
 * No ffmpeg/WAV step - text in, text out. Mirrors whisper.ts's
 * `transcribeFile` shape (resolve binary+model, spawn, stream output,
 * verify), minus the audio-specific pieces (no repair-and-retry, no
 * language guiding).
 */
export async function summarizeText(
  text: string,
  { model = null, device = "cpu", threads = null, onOutput = null }: SummarizeOptions = {}
): Promise<string> {
  if (!model) {
    throw new Error('No summarization model is configured. Set one in Settings, or run `vno setup --llama`.');
  }

  const binary = await resolveBinary({});
  if (!binary) {
    throw new Error("llama.cpp isn't installed. Run `vno setup --llama` to install it.");
  }
  const modelPath = await resolveModel(model);
  if (!modelPath) {
    throw new Error(`The "${model}" summarization model isn't installed. Run \`vno setup --summary-model ${model}\` to download it.`);
  }

  const truncated = text.length > MAX_PROMPT_CHARS;
  const body = truncated ? text.slice(0, MAX_PROMPT_CHARS) : text;
  if (truncated) announce("Transcript is long - summarizing the first part only.", onOutput);

  const promptPath = path.join(os.tmpdir(), `vno-llama-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(promptPath, INSTRUCTION + body, "utf8");

  try {
    announce("Summarizing with llama.cpp...", onOutput);
    const raw = await runLlamaCpp(binary.path, {
      promptPath,
      modelPath,
      device,
      threads: threads || Math.max(1, os.cpus().length - 1),
      onOutput,
    });
    const summary = stripEcho(raw, INSTRUCTION + body).trim();
    if (!summary) {
      throw new Error(`llama.cpp produced no summary text - last output:\n${lastLines(raw, 8)}`);
    }
    return summary;
  } finally {
    await fs.remove(promptPath).catch(() => {});
  }
}

function announce(message: string, onOutput: OutputCallback | null): void {
  if (onOutput) onOutput(message);
  else console.log(chalk.dim(message));
}

// Caps how much of a child's output is kept for an error message / echo
// stripping - matches whisper.ts's MAX_KEPT_OUTPUT reasoning.
const MAX_KEPT_OUTPUT = 64 * 1024;

interface RunLlamaArgs {
  promptPath: string;
  modelPath: string;
  device: string;
  threads: number;
  onOutput: OutputCallback | null;
}

function runLlamaCpp(binaryPath: string, { promptPath, modelPath, device, threads, onOutput }: RunLlamaArgs): Promise<string> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m",
      modelPath,
      "-f",
      promptPath,
      "-c",
      String(CONTEXT_TOKENS),
      "-n",
      String(MAX_OUTPUT_TOKENS),
      "-t",
      String(threads),
      "--no-display-prompt",
      "--simple-io",
    ];
    // The backend a binary was built with is fixed at install time; the
    // layer-offload count is the one runtime lever - 0 forces the CPU even on
    // an accelerator-capable build, 999 offloads everything llama.cpp will
    // fit.
    args.push("-ngl", device === "cpu" ? "0" : "999");

    const child = spawn(binaryPath, args, { windowsHide: true });

    let combined = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      const text = d.toString();
      combined = (combined + text).slice(-MAX_KEPT_OUTPUT);
      if (onOutput) emitLines(text, onOutput);
    });
    child.stderr.on("data", (d: Buffer) => {
      const text = d.toString();
      stderr = (stderr + text).slice(-MAX_KEPT_OUTPUT);
      // llama.cpp logs backend/model-load info to stderr; kept for failure
      // messages but not streamed live, to avoid burying the eventual summary
      // under load-time banner noise for a run that only ever prints once.
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr ? lastLines(stderr) : `llama.cpp exited with code ${code}`));
        return;
      }
      resolve(combined);
    });
  });
}

/**
 * llama.cpp's CLI echoes the prompt it was given before the completion
 * unless `--no-display-prompt` fully suppresses it - which build-dependent
 * behavior means the raw prompt sometimes still appears verbatim at the
 * start of stdout. Stripped defensively so a summary sidecar never ends up
 * containing the instruction + transcript it was built from.
 */
function stripEcho(output: string, prompt: string): string {
  const trimmedOutput = output.trimStart();
  const trimmedPrompt = prompt.trim();
  if (trimmedOutput.startsWith(trimmedPrompt)) {
    return trimmedOutput.slice(trimmedPrompt.length);
  }
  return output;
}

function emitLines(chunk: string, onOutput: OutputCallback): void {
  for (const line of chunk.split(/\r?\n|\r/)) {
    const trimmed = line.trim();
    if (trimmed) onOutput(trimmed);
  }
}

function lastLines(text: string, count = 20): string {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  return lines.slice(-count).join("\n") || "no output";
}

/**
 * Acceleration state for llama.cpp, mirroring whisper.ts's `accelState`/
 * `resolveAccel`/`accelUnasked` exactly but reading `config.llamaAccel`
 * instead of `config.accel` - the two engines' installs are independent, so
 * a machine can have an accelerated whisper.cpp and a CPU-only llama.cpp (or
 * neither).
 */
type LlamaAccelConfigLike = { llamaAccel?: Partial<AccelState> | null } | null | undefined;

export function llamaAccelState(config: LlamaAccelConfigLike): AccelState {
  return { backend: null, name: null, use: null, resolvedAt: null, ...(config?.llamaAccel || {}) };
}

export function resolveLlamaAccel(config: LlamaAccelConfigLike): AccelBackend {
  const accel = llamaAccelState(config);
  return accel.backend && accel.backend !== "cpu" && accel.use !== false ? accel.backend : "cpu";
}

export function llamaAccelUnasked(config: LlamaAccelConfigLike): boolean {
  const accel = llamaAccelState(config);
  return Boolean(accel.backend) && accel.backend !== "cpu" && accel.use === null;
}

/**
 * Whether a llama.cpp failure is about the accelerator rather than the
 * prompt/model - deliberately narrow, mirroring whisper.ts's
 * `isDeviceError`.
 */
export function isDeviceError(message: string | null | undefined): boolean {
  return /ggml_cuda_init|ggml_metal_init|no CUDA-capable device|CUDA error|cudaMalloc|out of memory|ggml_backend_.*failed|CUDA_ERROR/i.test(
    message || ""
  );
}

export function lastLine(message: string | null | undefined): string {
  const lines = (message || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "no output";
}
