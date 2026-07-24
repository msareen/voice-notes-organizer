import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import chalk from "chalk";
import inquirer from "inquirer";
import path from "node:path";

const execFileAsync = promisify(execFile);

export async function isWhisperInstalled() {
  try {
    await execFileAsync("whisper", ["--help"], { windowsHide: true });
    return true;
  } catch (err) {
    // whisper is present but `--help` exited non-zero: on some Python 3.12 /
    // argparse combos whisper's CLI throws a traceback on --help even though
    // real transcription works. Only "command not found" (ENOENT) means it
    // isn't installed; any other failure means it ran, so treat it as present.
    return err?.code !== "ENOENT";
  }
}

/**
 * Offers to install openai-whisper via pip. Whisper also requires ffmpeg on
 * PATH, which we can't install for the user portably, so we just warn about it.
 */
export async function ensureWhisperInstalled() {
  if (await isWhisperInstalled()) return true;

  console.log(chalk.yellow("whisper CLI was not found on your PATH."));
  const { shouldInstall } = await inquirer.prompt([
    {
      type: "confirm",
      name: "shouldInstall",
      message: 'Install it now via "pip install -U openai-whisper"?',
      default: true,
    },
  ]);

  if (!shouldInstall) {
    console.log(chalk.dim('You can install it later with: pip install -U openai-whisper'));
    return false;
  }

  console.log(chalk.dim("This also requires ffmpeg to be installed and on your PATH."));
  const installed = await runCommand("pip", ["install", "-U", "openai-whisper"]);
  if (!installed) {
    console.log(chalk.red('Install failed. Try running "pip install -U openai-whisper" manually.'));
    return false;
  }

  if (!(await isWhisperInstalled())) {
    console.log(
      chalk.red(
        "whisper still isn't on your PATH after install. You may need to restart your shell, " +
          "or ensure your Python scripts directory is on PATH."
      )
    );
    return false;
  }

  console.log(chalk.green("whisper installed successfully."));
  return true;
}

/**
 * Runs whisper on a single audio file, writing a timed transcript (.vtt) next
 * to the source file. VTT is plain, human-readable text plus the timing that
 * powers the follow-along highlight in `vno visualize`, so it's the only
 * transcript we keep — the rest of the tool keys off the `.vtt`.
 *
 * With `translate: true` whisper uses its translate task, turning audio in any
 * language into an English transcript instead of transcribing verbatim.
 */
export function transcribeFile(filePath, { model = "turbo", translate = false } = {}) {
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
    child.stdout.on("data", (d) => process.stdout.write(chalk.dim(d.toString())));
    child.stderr.on("data", (d) => {
      stderr += d.toString();
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

function runCommand(cmd, args) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}
