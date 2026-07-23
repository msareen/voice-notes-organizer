import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig } from "./config.js";
import { findAudioFiles } from "./sync.js";

const execFileAsync = promisify(execFile);

/**
 * Reads duration in seconds via ffprobe (bundled with ffmpeg, which whisper
 * already requires on PATH). Returns null if it can't be determined.
 */
async function getDurationSeconds(filePath) {
  try {
    const { stdout } = await execFileAsync(
      "ffprobe",
      ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", filePath],
      { windowsHide: true }
    );
    const value = parseFloat(stdout.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

// Transcript sidecars written next to an audio file (whisper .vtt, the
// derived .txt, plus .srt for completeness) that should go with it on delete.
const TRANSCRIPT_EXTS = [".txt", ".vtt", ".srt"];

function transcriptPathsFor(audioPath) {
  const base = audioPath.slice(0, -path.extname(audioPath).length);
  return TRANSCRIPT_EXTS.map((ext) => base + ext);
}

export async function runCleanup({ threshold = 3, dryRun = false } = {}) {
  const config = await loadConfig();

  if (!(await fs.pathExists(config.target))) {
    console.log(chalk.yellow(`Target folder does not exist yet: ${config.target}`));
    return;
  }

  try {
    await execFileAsync("ffprobe", ["-version"], { windowsHide: true });
  } catch {
    console.log(
      chalk.red(
        "ffprobe (part of ffmpeg) was not found on your PATH. It's needed to measure audio duration - install ffmpeg and try again."
      )
    );
    return;
  }

  const files = await findAudioFiles(config.target);
  if (files.length === 0) {
    console.log(chalk.dim("No audio files found."));
    return;
  }

  console.log(chalk.dim(`Checking duration of ${files.length} file(s)...`));

  const short = [];
  for (const file of files) {
    const duration = await getDurationSeconds(file);
    if (duration !== null && duration < threshold) {
      short.push({ file, duration });
    }
  }

  if (short.length === 0) {
    console.log(chalk.green(`No recordings shorter than ${threshold}s found.`));
    return;
  }

  console.log(chalk.bold(`Found ${short.length} recording(s) shorter than ${threshold}s:`));
  for (const { file, duration } of short) {
    console.log(`  - ${path.relative(config.target, file)} ${chalk.dim(`(${duration.toFixed(1)}s)`)}`);
  }

  if (dryRun) {
    console.log(chalk.dim("\nDry run - nothing deleted."));
    return;
  }

  console.log();
  const { confirmed } = await inquirer.prompt([
    {
      type: "list",
      name: "confirmed",
      message: `Delete these ${short.length} file(s) (and their transcripts, if any)?`,
      choices: [
        { name: "No, cancel", value: false },
        { name: "Yes, delete them", value: true },
      ],
      // Default to No: a destructive action should never fire on a bare Enter.
      default: false,
    },
  ]);

  if (!confirmed) {
    console.log(chalk.dim("Cancelled - nothing deleted."));
    return;
  }

  let removed = 0;
  for (const { file } of short) {
    try {
      await fs.remove(file);
      for (const transcript of transcriptPathsFor(file)) {
        if (await fs.pathExists(transcript)) {
          await fs.remove(transcript);
        }
      }
      removed++;
    } catch (err) {
      console.log(chalk.red(`Failed to delete ${path.relative(config.target, file)}: ${err.message}`));
    }
  }

  console.log(chalk.green(`Deleted ${removed}/${short.length} short recording(s).`));
}
