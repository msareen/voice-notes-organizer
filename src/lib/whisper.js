import { spawn } from "node:child_process";
import chalk from "chalk";
import fs from "fs-extra";
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
 * `device` is "cuda" or "cpu" - what `lib/gpu.js:resolveDevice` made of the
 * cached probe. It defaults to "cpu" so a caller that doesn't care can't end up
 * on a GPU by accident.
 *
 * `onOutput` receives whisper's output line by line; the viewer uses it to
 * stream progress into the browser. Without it, output goes to the terminal.
 */
export function transcribeFile(
  filePath,
  { model = "turbo", translate = false, device = "cpu", onOutput = null } = {}
) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const outputDir = path.dirname(filePath);
    const cuda = device === "cuda";
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
      // Both pinned rather than left to whisper's defaults, which are "cuda if
      // torch sees one" and fp16 on. Half-precision is the point of running on
      // a GPU and a warning-and-fallback on a CPU, so the two travel together -
      // and being explicit means the device a run used is the one config named.
      "--device",
      cuda ? "cuda" : "cpu",
      "--fp16",
      cuda ? "True" : "False",
    ];
    const child = spawn("whisper", args, {
      windowsHide: true,
      // whisper prints each segment as it decodes, and Python encodes stdout
      // with the console's codepage - cp1252 on a Western Windows install,
      // which can't represent Devanagari, CJK, Cyrillic or an emoji. The
      // UnicodeEncodeError that raises is caught by whisper's own CLI loop,
      // which then *skips the file* and still exits 0. Forcing UTF-8 on the
      // pipe is the fix: we decode it as UTF-8 on the Node side anyway.
      env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
    });

    let stderr = "";
    // whisper catches per-file errors in its own CLI loop, prints "Skipping
    // <file> due to ..." and carries on to exit 0 - so a run that transcribed
    // nothing at all looks like a success. Watch for it rather than trusting
    // the exit code. The transcript itself isn't kept; it can be megabytes.
    let skipped = null;
    child.stdout.on("data", (d) => {
      const text = d.toString();
      for (const line of text.split(/\r?\n|\r/)) {
        if (/^Skipping .* due to /.test(line.trim())) skipped = line.trim();
      }
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
    child.on("close", async (code) => {
      if (code !== 0) {
        reject(new Error(stderr || `whisper exited with code ${code}`));
        return;
      }
      if (skipped) {
        reject(new Error(skipped));
        return;
      }
      // Belt and braces: exit 0 with no transcript on disk is still a failure,
      // and the caller is about to report "Saved" otherwise.
      const transcript = filePath.slice(0, -path.extname(filePath).length) + ".vtt";
      const stats = await fs.stat(transcript).catch(() => null);
      if (!stats || stats.mtimeMs < startedAt - 1000) {
        reject(new Error(`whisper wrote no transcript for ${path.basename(filePath)}`));
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
