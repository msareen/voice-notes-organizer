#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { Command } from "commander";
import chalk from "chalk";
import { runImport } from "../src/cli/import.js";
import { runTranscribe } from "../src/cli/transcribe.js";
import { runCleanup, runLedgerCleanup } from "../src/cli/cleanup.js";
import { runVisualize, DEFAULT_PORT } from "../src/cli/visualize.js";
import { runSettings } from "../src/cli/settings.js";
import { runSetup } from "../src/cli/setup.js";
import { runExplore } from "../src/cli/explore.js";
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
  // -v/--v collides with the conventional "print version" flag, so anyone
  // reaching for that habit gets pointed at the real thing instead of just
  // silently landing in the browser UI.
  if (process.argv[2] === "-v" || process.argv[2] === "--v") {
    console.log(chalk.dim("(-v launches the browser UI here - run `vno --version` to see the installed version.)"));
  }
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
  .argument(
    "[what]",
    'pass "ledger" to delete the deletion ledger instead of any recordings; omit it to clean up short recordings'
  )
  .description("Delete very short recordings (likely accidental button presses) from the target folder")
  .option(
    "-f, --file <names...>",
    "delete these specific recordings and their transcripts (name, relative path, or absolute path) instead of scanning for short ones"
  )
  .option("-t, --threshold <seconds>", "recordings shorter than this (seconds) are removed", "3")
  .option(
    "--originals",
    "also offer the damaged pre-repair originals (*.original.m4a) kept beside repaired Samsung recordings"
  )
  .option("--dry-run", "list what would be deleted without deleting anything")
  .action(async (what, opts) => {
    if (what === "ledger") {
      await runLedgerCleanup();
      return;
    }
    if (what) {
      console.error(chalk.red(`Unknown cleanup target "${what}". Did you mean \`vno cleanup ledger\`?`));
      process.exitCode = 1;
      return;
    }
    await runCleanup({
      threshold: parseFloat(opts.threshold),
      dryRun: Boolean(opts.dryRun),
      files: opts.file || null,
      originals: Boolean(opts.originals),
    });
  });

program
  .command("visualize")
  .alias("v")
  .description(
    "Launch the browser UI: play, edit transcripts, import, transcribe, clean up and change settings (alias: v, --v)"
  )
  .option(
    "-p, --port <number>",
    `port to listen on; falls back to the next port up if it's busy (default: ${DEFAULT_PORT})`,
    String(DEFAULT_PORT)
  )
  .option("--no-open", "start the server without opening a browser")
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    await runVisualize({ open: opts.open, port: Number.isNaN(port) ? DEFAULT_PORT : port });
  });

program
  .command("explore")
  .alias("open")
  .argument(
    "[file]",
    "reveal this recording (name, relative path, or absolute path) instead of just opening the target folder"
  )
  .description("Open the target folder in your file manager, or reveal one recording in it (alias: open)")
  .action(async (file) => {
    await runExplore({ file: file || null });
  });

program
  .command("setting")
  .alias("settings")
  .description(
    "Interactive wizard to toggle/reset direct switches (auto-translate, model, target, remembered volumes, deletion ledger)"
  )
  .action(async () => {
    await runSettings();
  });

program
  .command("setup")
  .alias("doctor")
  .description(
    "Check that ffmpeg and whisper.cpp are installed and offer to install what's missing (alias: doctor)"
  )
  .option("--check", "only report what's installed; never offer to install anything")
  .option("--local", "install whisper.cpp beside this vno install, without asking")
  .option("--global", "install whisper.cpp under the user's home directory, without asking")
  .option("--model <name>", "fetch just this model instead of the defaults")
  .option("--list-models", "print the model inventory and exit; installs nothing")
  .action(async (opts) => {
    await runSetup({
      check: Boolean(opts.check),
      mode: opts.global ? "global" : opts.local ? "local" : null,
      model: opts.model || null,
      listModelsOnly: Boolean(opts.listModels),
    });
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
