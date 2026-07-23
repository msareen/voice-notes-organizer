#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { runImport } from "../src/import.js";
import { runTranscribe } from "../src/transcribe.js";
import { runCleanup } from "../src/cleanup.js";
import { runVisualize } from "../src/visualize.js";
import { configFilePath } from "../src/config.js";

const program = new Command();

program
  .name("vno")
  .description(
    "Detects removable volumes, imports voice notes to local storage, and transcribes them with whisper."
  )
  .version("0.1.0");

program
  .command("import", { isDefault: true })
  .description("Detect connected volumes and import voice notes (default command)")
  .action(async () => {
    await runImport();
  });

program
  .command("transcribe")
  .description("Transcribe imported voice notes using whisper")
  .option("-m, --model <model>", "whisper model to use (tiny, base, small, medium, large)")
  .option(
    "-f, --file <name>",
    "transcribe a specific file (name, relative path, or absolute path) instead of picking from a list"
  )
  .action(async (opts) => {
    await runTranscribe({ model: opts.model, file: opts.file });
  });

program
  .command("cleanup")
  .description("Delete very short recordings (likely accidental button presses) from the target folder")
  .option("-t, --threshold <seconds>", "recordings shorter than this (seconds) are removed", "3")
  .option("--dry-run", "list what would be deleted without deleting anything")
  .action(async (opts) => {
    await runCleanup({ threshold: parseFloat(opts.threshold), dryRun: Boolean(opts.dryRun) });
  });

program
  .command("visualize")
  .description("Generate a self-contained index.html player for the imported notes (with follow-along transcripts)")
  .option("-o, --open", "open the generated page in your default browser")
  .action(async (opts) => {
    await runVisualize({ open: Boolean(opts.open) });
  });

program
  .command("config")
  .description("Print the path to the memory/config file")
  .action(() => {
    console.log(configFilePath());
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red(err.stack || err.message || err));
  process.exitCode = 1;
});
