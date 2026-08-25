import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../lib/config.ts";
import { readTranscript, writeSummary } from "../lib/notes.ts";
import { summarizeText, isLlamaInstalled, resolveLlamaAccel } from "../lib/llama.ts";
import { listModels as listLlamaModels } from "../lib/llamacpp.ts";

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summaryPathFor(audioPath: string): string {
  return audioPath.slice(0, -path.extname(audioPath).length) + ".summary.txt";
}

export interface RunSummarizeOptions {
  file: string;
  model?: string;
}

/**
 * `vno summarize <file>` - a one-shot path mirroring `vno t <file>`: no
 * picker, no batch, resolved against the current directory rather than
 * requiring the file live under `config.target`. Summarization is entirely
 * optional, so this checks for llama.cpp itself rather than going through
 * `ensureDependencies` (which only knows how to offer ffmpeg/whisper.cpp) -
 * a missing engine here just points at `vno setup --llama`.
 */
export async function runSummarize({ file, model }: RunSummarizeOptions): Promise<boolean> {
  const config = await loadConfig();

  const resolved = path.resolve(process.cwd(), file);
  if (!(await fs.pathExists(resolved))) {
    console.log(chalk.red(`File not found: ${resolved}`));
    return false;
  }

  if (!(await isLlamaInstalled())) {
    console.log(chalk.yellow("llama.cpp isn't installed. Run `vno setup --llama` to add it."));
    return false;
  }

  const transcript = await readTranscript(resolved);
  if (!transcript.hasTranscript) {
    console.log(chalk.yellow(`No transcript for ${path.basename(resolved)} yet. Run \`vno t ${file}\` first.`));
    return false;
  }

  const chosenModel = model || config.summaryModel;
  if (!chosenModel) {
    console.log(chalk.yellow("No summarization model configured. Pass -m <name>, or set one with `vno setting`."));
    const available = (await listLlamaModels()).filter((m) => m.valid);
    if (available.length > 0) {
      console.log(chalk.dim(`Available: ${available.map((m) => m.filename).join(", ")}`));
    }
    return false;
  }

  const device = resolveLlamaAccel(config);
  console.log(chalk.dim(`Summarizing ${path.basename(resolved)}...`));
  try {
    const summary = await summarizeText(transcript.text, { model: chosenModel, device, onOutput: (line) => console.log(chalk.dim(line)) });
    await writeSummary(resolved, summary);
    console.log(chalk.green(`\n${summary}`));
    console.log(chalk.dim(`\nSaved -> ${summaryPathFor(resolved)}`));
    return true;
  } catch (err) {
    console.log(chalk.red(`Failed to summarize ${path.basename(resolved)}: ${errorMessage(err)}`));
    return false;
  }
}
