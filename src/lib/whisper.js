import { spawn } from "node:child_process";
import chalk from "chalk";
import path from "node:path";
import { which } from "./setup.js";

/**
 * Whether the whisper CLI is callable. Resolved by looking it up on PATH
 * rather than by running it: `whisper --help` boots Python and torch, which
 * costs seconds, and it's the same resolution `spawn` will do below anyway.
 *
 * Installing it (and ffmpeg) is `cli/setup.js`'s job - lib/ never prompts.
 */
export async function isWhisperInstalled() {
  return Boolean(await which("whisper"));
}

/**
 * Runs whisper on a single audio file, writing a timed transcript (.vtt) next
 * to the source file. VTT is plain, human-readable text plus the timing that
 * powers the follow-along highlight in `vno visualize`, so it's the only
 * transcript we keep — the rest of the tool keys off the `.vtt`.
 *
 * With `translate: true` whisper uses its translate task, turning audio in any
 * language into an English transcript instead of transcribing verbatim.
 *
 * `onOutput` receives whisper's output line by line; the viewer uses it to
 * stream progress into the browser. Without it, output goes to the terminal.
 */
export function transcribeFile(filePath, { model = "turbo", translate = false, onOutput = null } = {}) {
  return new Promise((resolve, reject) => {
    const outputDir = path.dirname(filePath);
    const args = [
      filePath,
      "--model",
      model,
      "--task",
      translate ? "translate" : "transcribe",
      "--output_format",
      "vtt",
      "--output_dir",
      outputDir,
      "--fp16",
      "False",
    ];
    const child = spawn("whisper", args, { windowsHide: true });

    let stderr = "";
    child.stdout.on("data", (d) => {
      const text = d.toString();
      if (onOutput) emitLines(text, onOutput);
      else process.stdout.write(chalk.dim(text));
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
      // whisper reports its progress bar on stderr, so it's worth surfacing
      // live even though it's also kept for the failure message.
      if (onOutput) emitLines(d.toString(), onOutput);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `whisper exited with code ${code}`));
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
