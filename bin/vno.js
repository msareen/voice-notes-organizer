#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { runImport } from "../src/cli/import.js";
import { runTranscribe } from "../src/cli/transcribe.js";
import { runCleanup } from "../src/cli/cleanup.js";
import { runVisualize } from "../src/cli/visualize.js";
import { runSettings } from "../src/cli/settings.js";
import { configFilePath } from "../src/lib/config.js";

// Single source of truth for the version - a hardcoded copy here silently
// drifts from package.json the first time someone bumps only one of them.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

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
    "Import, transcribe, translate and organize voice recordings from voice recorders and SD cards."
  )
  .version(version);

program
  .command("import", { isDefault: true })
  .description("Detect connected volumes and import voice notes (default command)")
  .option("--no-open", "don't open the target folder(s) and index.html when the run finishes")
  .action(async (opts) => {
    await runImport({ open: opts.open });
  });

program
  .command("transcribe")
  .alias("t")
  .description("Transcribe imported voice notes using whisper (alias: t, --t)")
  .option("-m, --model <model>", "whisper model to use (turbo, tiny, base, small, medium, large)")
  .option(
    "-f, --file [name]",
    "transcribe a specific file (name, relative path, or absolute path) instead of picking from a list; pass -f on its own to pick from every file, including ones already transcribed"
  )
  .option(
    "-s, --filter <text>",
    "pre-filter the picker list to files whose name or recorded date contains this text"
  )
  .option("--translate", "translate to English (whisper translate task) instead of verbatim transcription")
  .option("--no-open", "don't open the target folder(s) and index.html when the run finishes")
  .action(async (opts) => {
    await runTranscribe({
      model: opts.model,
      file: opts.file,
      filter: opts.filter,
      translate: Boolean(opts.translate),
      open: opts.open,
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
  .description(
    "Launch the browser UI: play, edit transcripts, import, transcribe, clean up and change settings (alias: v, --v)"
  )
  .option("-p, --port <number>", "port to listen on (default: a free one picked automatically)", "0")
  .option("--no-open", "start the server without opening a browser")
  .action(async (opts) => {
    await runVisualize({ open: opts.open, port: parseInt(opts.port, 10) || 0 });
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
