#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { runImport } from "../src/import.js";
import { runTranscribe } from "../src/transcribe.js";
import { runCleanup } from "../src/cleanup.js";
import { runVisualize } from "../src/visualize.js";
import { runSettings } from "../src/settings.js";
import { configFilePath } from "../src/config.js";

const program = new Command();

// Short, dashed aliases for the two commands people reach for most, so `vno
// --v` and `vno --t` work as muscle-memory shortcuts. Commander treats these
// as options otherwise, so we rewrite them to their command names before parse.
const SHORTCUTS = {
  "--v": "visualize",
  "-v": "visualize",
  "--t": "transcribe",
  "-t": "transcribe",
};
if (SHORTCUTS[process.argv[2]]) {
  process.argv[2] = SHORTCUTS[process.argv[2]];
}

program
  .name("vno")
  .description(
    "Detects removable volumes, imports voice notes to local storage, and transcribes them with whisper."
  )
  .version("0.2.0");

program
  .command("import", { isDefault: true })
  .description("Detect connected volumes and import voice notes (default command)")
  .action(async () => {
    await runImport();
  });

program
  .command("transcribe")
  .alias("t")
  .description("Transcribe imported voice notes using whisper (alias: t, --t)")
  .option("-m, --model <model>", "whisper model to use (turbo, tiny, base, small, medium, large)")
  .option(
    "-f, --file <name>",
    "transcribe a specific file (name, relative path, or absolute path) instead of picking from a list"
  )
  .option(
    "-s, --filter <text>",
    "pre-filter the picker list to files whose name or recorded date contains this text"
  )
  .option("--translate", "translate to English (whisper translate task) instead of verbatim transcription")
  .action(async (opts) => {
    await runTranscribe({
      model: opts.model,
      file: opts.file,
      filter: opts.filter,
      translate: Boolean(opts.translate),
    });
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
  .alias("v")
  .description("Generate a self-contained index.html player for the imported notes (alias: v, --v)")
  .option("-o, --open", "open the generated page in your default browser")
  .action(async (opts) => {
    await runVisualize({ open: Boolean(opts.open) });
  });

program
  .command("setting")
  .alias("settings")
  .description("Interactive wizard to toggle/reset direct switches (auto-translate, model, target, remembered volumes)")
  .action(async () => {
    await runSettings();
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
