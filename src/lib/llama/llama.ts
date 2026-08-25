import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import { resolveBinary, resolveModel } from "./llamacpp.ts";
import type { AccelBackend, AccelState, Config } from "../../types.ts";

/** Receives llama.cpp's output line by line. */
export type OutputCallback = (line: string) => void;

/**
 * Whether llama.cpp is callable - PATH or `config.llamaCliPath`, never a
 * spawn, matching `isWhisperInstalled`'s contract. Summarization is entirely
 * optional, so every caller must check this (or catch the resulting error)
 * rather than assume it's there.
 */
export async function isLlamaInstalled(config: Pick<Config, "llamaCliPath"> | null | undefined): Promise<boolean> {
  return Boolean(await resolveBinary(config));
}

/** The instruction prefixed to every transcript, unless `SummarizeOptions.prompt` overrides it. Exported so Settings can show it as the override field's placeholder. */
export const DEFAULT_SUMMARY_PROMPT =
  "Summarize the following voice-note transcript in a few plain-prose sentences. " +
  "No preamble, no headings, no bullet points - just the summary itself.";

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
  /** Replaces DEFAULT_SUMMARY_PROMPT wholesale. Whitespace-only or unset falls back to the default. */
  prompt?: string | null;
  /** Manual override for the binary's path - see Config.llamaCliPath. */
  llamaCliPath?: string | null;
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
  { model = null, device = "cpu", threads = null, onOutput = null, prompt = null, llamaCliPath = null }: SummarizeOptions = {}
): Promise<string> {
  if (!model) {
    throw new Error('No summarization model is configured. Set one in Settings, or run `vno setup --llama`.');
  }

  const binary = await resolveBinary({ llamaCliPath });
  if (!binary) {
    throw new Error("llama.cpp isn't installed. Run `vno setup --llama` to install it.");
  }
  const modelPath = await resolveModel(model);
  if (!modelPath) {
    throw new Error(`The "${model}" summarization model isn't installed. Drop the .gguf file into your models folder (see \`vno setup --llama\`).`);
  }

  const truncated = text.length > MAX_PROMPT_CHARS;
  const body = truncated ? text.slice(0, MAX_PROMPT_CHARS) : text;
  if (truncated) announce("Transcript is long - summarizing the first part only.", onOutput);

  const instruction = (prompt && prompt.trim() ? prompt.trim() : DEFAULT_SUMMARY_PROMPT) + "\n\nTranscript:\n";
  const promptPath = path.join(os.tmpdir(), `vno-llama-${process.pid}-${Date.now()}.txt`);
  await fs.writeFile(promptPath, instruction + body, "utf8");

  try {
    announce("Summarizing with llama.cpp...", onOutput);
    const raw = await runLlamaCpp(binary, {
      promptPath,
      modelPath,
      device,
      threads: threads || Math.max(1, os.cpus().length - 1),
      onOutput,
    });
    const summary = stripFooter(stripEcho(raw, instruction + body)).trim();
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
      // A gguf carrying a chat template makes newer llama-cli builds default
      // to an interactive conversation loop instead of one-shot completion -
      // it answers once, then blocks reading a second turn from stdin, which
      // this spawn never provides. --single-turn exits after that one answer
      // instead of hanging forever waiting for a turn that never comes.
      "--single-turn",
      // A reasoning-capable model (a "thinking" variant) spends its whole -n
      // budget on chain-of-thought before ever reaching an answer, which is
      // the wrong shape for something written straight into a .summary.txt
      // sidecar - 0 tells a template that supports it to skip straight to
      // the answer. A no-op for a non-reasoning model/template.
      "--reasoning-budget",
      "0",
    ];
    // The backend a binary was built with is fixed at install time; the
    // layer-offload count is the one runtime lever - 0 forces the CPU even on
    // an accelerator-capable build, 999 offloads everything llama.cpp will
    // fit.
    args.push("-ngl", device === "cpu" ? "0" : "999");

    const child = spawn(binaryPath, args, { windowsHide: true });
    // A gguf with a chat template makes newer llama-cli builds auto-enter an
    // interactive conversation loop instead of one-shot completion, even fed
    // via -f: it answers once, then blocks reading the next turn from stdin.
    // We only ever want that one answer, and never send further turns, so
    // closing stdin immediately delivers EOF - which the REPL treats like
    // Ctrl+D and exits on, letting `close` fire instead of hanging forever.
    child.stdin.end();

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
      // llama.cpp logs backend selection and model-load progress to stderr,
      // same as whisper.cpp - worth surfacing live (not folded into `combined`,
      // so it never leaks into the summary text extracted from stdout) rather
      // than leaving the CLI silent for however long a multi-GB model takes to
      // load, which otherwise looks indistinguishable from a hang.
      if (onOutput) emitLines(text, onOutput);
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
 * A conversation-mode llama-cli build prints a startup banner (build info,
 * ASCII art, the REPL's command list) and then echoes the user's turn back
 * immediately before the model's actual answer, with no blank line or other
 * separator between the two. For a short prompt the echo is exact, so
 * finding our own instruction+transcript text anywhere in the output (not
 * just at the very start - the banner comes first) and slicing past it
 * strips banner and echo together in one step. A long transcript's on-screen
 * echo gets truncated with a literal "(truncated)" marker for terminal
 * display though (even though the model itself received the whole thing),
 * which breaks the exact match - falling back to slicing past that marker
 * instead.
 */
function stripEcho(output: string, prompt: string): string {
  const trimmedPrompt = prompt.trim();
  const idx = output.indexOf(trimmedPrompt);
  if (idx !== -1) return output.slice(idx + trimmedPrompt.length);
  const truncIdx = output.indexOf("(truncated)");
  if (truncIdx !== -1) return output.slice(truncIdx + "(truncated)".length);
  return output;
}

/**
 * `--single-turn` prints a `[ Prompt: N t/s | Generation: N t/s ]` timing
 * line and an "Exiting..." notice after the answer - cut everything from
 * the timing line onward so it never ends up in the saved summary.
 */
function stripFooter(output: string): string {
  const idx = output.indexOf("[ Prompt:");
  return idx === -1 ? output : output.slice(0, idx);
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
