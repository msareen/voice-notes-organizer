#!/usr/bin/env bun
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { Command } from "commander";
import chalk from "chalk";
import { runImport } from "../src/cli/import.ts";
import { runTranscribe } from "../src/cli/transcribe.ts";
import { runSummarize } from "../src/cli/summarize.ts";
import { runCleanup, runLedgerCleanup } from "../src/cli/cleanup.ts";
import { runVisualize, DEFAULT_PORT } from "../src/cli/visualize.ts";
import { runSettings } from "../src/cli/settings.ts";
import { runSetup, runStatus } from "../src/cli/setup.ts";
import { runExplore } from "../src/cli/explore.ts";
import { configFilePath } from "../src/lib/config.ts";

// Single source of truth for the version - a hardcoded copy here silently
// drifts from package.json the first time someone bumps only one of them.
const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  version: string;
};

const program = new Command();

// Short, dashed aliases for the two commands people reach for most, so `vno
// --v` and `vno --t` work as muscle-memory shortcuts. Commander treats these
// as options otherwise, so we rewrite them to their command names before parse.
// `-v` is deliberately excluded: it's the conventional "print version" flag
// (wired up below), so it stays out of this table - `vno v` (the alias on the
// visualize command itself) is the short form for launching the UI.
const SHORTCUTS: Record<string, string> = {
  "--v": "visualize",
  "--t": "transcribe",
  "-t": "transcribe",
};
if (SHORTCUTS[process.argv[2]]) {
  process.argv[2] = SHORTCUTS[process.argv[2]];
}

/**
 * Commander's generated help lists every flag but never shows what an actual
 * invocation looks like, which is the part people are missing when they reach
 * for `--help`. It matters most for `transcribe`, where one command covers two
 * quite different modes (pick from a list, or name a single file) that the
 * flag list alone doesn't distinguish.
 *
 * Pads before colouring, since chalk's escape codes would otherwise count
 * toward the column width and misalign everything.
 */
function examples(rows: [string, string][], { heading = "Examples" }: { heading?: string } = {}): string {
  const width = Math.max(...rows.map(([command]) => command.length)) + 2;
  const body = rows
    .map(([command, note]) => `  ${command.padEnd(width)}${chalk.dim(note)}`)
    .join("\n");
  return `\n${heading}:\n${body}\n`;
}

program
  .name("vno")
  .description(
    "Import, transcribe, translate and organize voice recordings from voice recorders and SD cards."
  )
  .option("-v, --version", "output the version number")
  .addHelpText(
    "after",
    examples([
      ["vno", "import from a connected recorder, then open the UI"],
      ["vno v", "just open the UI"],
      ["vno t", "pick recordings from a list and transcribe them"],
      ["vno t interview.mp3", "transcribe one file directly"],
      ["vno status", "is everything installed and ready?"],
      ["vno setup", "...and offer to install whatever is missing"],
      ["vno cleanup --dry-run", "list the very short recordings, delete nothing"],
    ]) + chalk.dim("\nRun `vno help <command>` for the detail on any one of these.\n")
  );

// Not `.version()`'s built-in handler: that prints and exits with no room for
// the hint below, and `-v` is the flag people are most likely to reach for
// right after wanting the visualizer, so it's worth pointing them at it.
program.on("option:version", () => {
  console.log(version);
  console.log(chalk.dim("Use `vno v` (also `viz` / `vis`) to open the browser UI."));
  process.exit(0);
});

program
  .command("import", { isDefault: true })
  .description("Detect connected volumes and import voice notes (default command)")
  .option("--no-open", "don't open the target folder(s) and index.html when the run finishes")
  .addHelpText(
    "after",
    examples([
      ["vno", "same as `vno import` - this is the default command"],
      ["vno import --no-open", "import, but don't open the UI afterwards"],
    ]) +
      chalk.dim(
        "\nThe first time a volume appears you're asked whether to import it and\n" +
          "whether to pin a subfolder; after that it runs silently. Files land flat,\n" +
          "one folder per device, and re-running never copies the same file twice.\n"
      )
  )
  .action(async (opts) => {
    await runImport({ open: opts.open });
  });

program
  .command("transcribe")
  .alias("t")
  .argument(
    "[file]",
    "transcribe this file directly (name, relative path, or absolute path), skipping the picker and model prompt"
  )
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
  .option(
    "-o, --output <path>",
    "write the transcript to this path instead of next to the source file, or \"-\" for stdout (only with a direct file argument)"
  )
  .option("--no-open", "don't open the target folder(s) and index.html when the run finishes")
  .addHelpText(
    "after",
    chalk.dim(
      "\nTwo modes:\n" +
        "  With no [file], this opens a searchable picker over everything not yet\n" +
        "  transcribed - type to filter, Space toggles, Ctrl+A selects all, Enter runs.\n" +
        "  Naming a [file] skips all of that and transcribes exactly that one, using\n" +
        "  your default model. That file doesn't have to live in your target folder,\n" +
        "  so it works on any audio lying around.\n"
    ) +
      examples([
        ["vno t", "open the picker"],
        ["vno t 250810_1328", "one imported recording, matched by name"],
        ["vno t ~/Desktop/interview.mp3", "...or any audio file, anywhere"],
        ["vno t interview.mp3 -o notes.vtt", "put the transcript somewhere specific"],
        ["vno t interview.mp3 -o -", "write it to stdout, for piping"],
        ["vno t interview.mp3 -m small", "use a different model for this run"],
        ["vno t --translate", "translate to English instead of verbatim"],
        ["vno t -s \"Feb 2023\"", "pre-filter the picker by name or date"],
        ["vno t -f", "pick from every file, including already-done ones"],
      ]) +
      chalk.dim(
        "\nTranscripts are .vtt files written next to the audio unless -o says otherwise.\n" +
          "A name can be a full filename, just the stem, or any unique fragment of one.\n" +
          "\nScripting a single file: it exits non-zero if the transcription fails, and\n" +
          "with `-o -` the transcript is the only thing on stdout (progress and\n" +
          "whisper.cpp's own output move to stderr), so it pipes cleanly:\n" +
          "  vno t interview.mp4 -o - 2>/dev/null | your-tool\n" +
          "Video files work too - ffmpeg pulls the audio track out of mp4/mkv/mov/webm.\n"
      )
  )
  .action(async (file, opts) => {
    const ok = await runTranscribe({
      model: opts.model,
      file: file || opts.file,
      directFile: Boolean(file),
      filter: opts.filter,
      translate: Boolean(opts.translate),
      output: opts.output,
      open: opts.open,
    });
    // Only the direct one-shot path reports success/failure, and it's the only
    // one a script drives - `vno t x.mp3 -o out.vtt && next-step` was silently
    // succeeding on a missing file before this. The interactive path returns
    // undefined and keeps exiting 0, since "some files failed" is already
    // visible in its own output.
    if (ok === false) process.exitCode = 1;
  });

program
  .command("summarize")
  .argument("<file>", "summarize this recording's transcript (name, relative path, or absolute path)")
  .description("Summarize a recording's transcript with llama.cpp (optional; run `vno setup --llama` first)")
  .option("-m, --model <name>", "summarization model to use (defaults to the one set in `vno setting`)")
  .addHelpText(
    "after",
    examples([
      ["vno setup --llama", "one-time: install llama.cpp and pick a model"],
      ["vno summarize 250810_1328", "summarize one imported recording, matched by name"],
      ["vno summarize interview.mp3 -m phi4-mini", "use a specific model for this run"],
    ]) +
      chalk.dim(
        "\nOne recording at a time - no picker, no batch mode. The recording needs a\n" +
          "transcript already (`vno t` first). The summary is written to a\n" +
          "<name>.summary.txt file next to the audio, same as .vtt is for transcripts.\n" +
          "This is the CLI counterpart to the deck's Summarize button in `vno v`.\n"
      )
  )
  .action(async (file, opts) => {
    const ok = await runSummarize({ file, model: opts.model });
    if (!ok) process.exitCode = 1;
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
  .addHelpText(
    "after",
    examples([
      ["vno cleanup --dry-run", "list what would go, delete nothing"],
      ["vno cleanup", "find recordings under 3s and confirm before deleting"],
      ["vno cleanup -t 5", "use a 5-second threshold instead"],
      ["vno cleanup -f 250810_1328", "delete named recordings, no duration scan"],
      ["vno cleanup --originals", "also offer the *.original.m4a repair backups"],
      ["vno cleanup ledger", "forget what was deleted, so it can import again"],
    ]) +
      chalk.dim(
        "\nEvery form confirms first, and the confirmation defaults to no. Deleting a\n" +
          "recording removes its .vtt transcript too. `ledger` touches no recordings at\n" +
          "all - it only clears vno's memory of what you deleted.\n"
      )
  )
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
  .aliases(["v", "viz", "vis"])
  .description(
    "Launch the browser UI: play, edit transcripts, import, transcribe, clean up and change settings (alias: v, viz, vis, --v)"
  )
  // No commander default here on purpose: it would make `opts.port` always
  // set, and "not passed" is exactly what has to fall through to config.port.
  .option(
    "-p, --port <number>",
    `port to listen on for this run only, overriding the configured one (default: ${DEFAULT_PORT}). If it's held by another vno v, opens a tab to it instead`
  )
  .option("--no-open", "start the server without opening a browser")
  .addHelpText(
    "after",
    examples([
      ["vno v", "open the UI (viz / vis / --v all work too)"],
      ["vno v --no-open", "start the server without opening a browser"],
      ["vno v -p 0", "pick any free port instead of the fixed one"],
    ]) +
      chalk.dim(
        `\nThe port is fixed (${DEFAULT_PORT} unless you've changed it) so bookmarks and an\n` +
          "installed app keep working. Change it for good in `vno setting` → Viewer port;\n" +
          "-p is just for one run. If another vno v already holds the port, this opens a\n" +
          "tab to that one rather than starting a second server. The command blocks until\n" +
          "you close the tab, press the page's Quit button, or hit Ctrl+C.\n"
      )
  )
  .action(async (opts) => {
    const parsed = opts.port === undefined ? null : parseInt(opts.port, 10);
    await runVisualize({
      open: opts.open,
      port: parsed === null || Number.isNaN(parsed) ? null : parsed,
    });
  });

// Invoked by Windows, not by a person: the target of the `vno://` registry
// key `vno setup` offers to register (lib/protocol.ts). A browser navigating
// to `vno://open` shows its native "Open vno?" dialog, and on approval the OS
// runs this with the full URI as `%1`. The URI itself carries no arguments
// worth reading yet - it's just "launch vno v" - so it's accepted and ignored
// rather than parsed.
//
// This process is the one the OS actually launches for the protocol, so it's
// the one stuck with whatever console window that invocation creates. Rather
// than running the server here, it immediately re-spawns a second, detached
// copy with `windowsHide: true` - which suppresses window creation for that
// *new* process outright, unlike trying to hide a console this process
// already owns - and exits. The server then runs fully in the background,
// the same way clicking a Teams/Zoom link doesn't leave a console window
// behind. `--no-open` is deliberate: the tab or PWA window that had the user
// click "Launch vno" (offline.html) is already polling and will reload
// itself the moment the server answers, so opening another one here would
// just pop a second, redundant window.
//
// `process.execPath` is the Bun binary, and the entry point is this .ts file,
// which Bun runs directly - there is no build output to point at.
program
  .command("open-protocol <uri>", { hidden: true })
  .description("Internal: launched by the vno:// URL handler")
  .action(() => {
    const vnoEntry = fileURLToPath(new URL("./vno.ts", import.meta.url));
    spawn(process.execPath, [vnoEntry, "visualize", "--no-open"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    }).unref();
  });

program
  .command("explore")
  .alias("open")
  .argument(
    "[file]",
    "reveal this recording (name, relative path, or absolute path) instead of just opening the target folder"
  )
  .description("Open the target folder in your file manager, or reveal one recording in it (alias: open)")
  .addHelpText(
    "after",
    examples([
      ["vno explore", "open the target folder"],
      ["vno open 250810_1328", "open the folder that recording lives in"],
    ]) +
      chalk.dim(
        "\nThe path is printed before the window opens, so you still have something to\n" +
          "copy if no file manager is available.\n"
      )
  )
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
  .option("--whisper", "pick which whisper.cpp models to install from a checklist (tiny, base, small, medium, large-v3, turbo)")
  .option("--list-models", "print the model inventory and exit; installs nothing")
  .option("--remove-model [name]", "delete installed models to reclaim disk space; bare, opens a picker")
  .option("--llama", "install llama.cpp for transcript summarization (optional; never installed otherwise)")
  .option("--summary-model <name>", "fetch this summarization model (implies --llama if it isn't installed yet)")
  .addHelpText(
    "after",
    examples([
      ["vno setup", "check, and offer to install anything missing"],
      ["vno setup --check", "report only - installs and downloads nothing"],
      ["vno setup --global", "put whisper.cpp under your home dir, not beside vno"],
      ["vno setup --model small", "fetch one model instead of the default set"],
      ["vno setup --whisper", "pick any number of whisper models to install from a checklist"],
      ["vno setup --list-models", "show which models are already on disk"],
      ["vno setup --remove-model", "pick installed models to delete and reclaim the space"],
      ["vno setup --llama", "install llama.cpp and pick a summarization model"],
      ["vno setup --llama --summary-model phi4-mini", "install llama.cpp with a specific model, no prompts"],
    ]) +
      chalk.dim(
        "\nNothing installs without you confirming it. This same check runs by itself\n" +
          "before transcribe, cleanup's duration scan and an auto-translating import, so\n" +
          "a missing tool surfaces as an offer rather than a failure part-way through.\n" +
          "Re-run it after adding a GPU or changing drivers to pick up a better backend.\n\n" +
          "llama.cpp (transcript summarization) is entirely optional and never installed\n" +
          "by plain `vno setup` - only `vno setup --llama` touches it.\n"
      )
  )
  .action(async (opts) => {
    await runSetup({
      check: Boolean(opts.check),
      mode: opts.global ? "global" : opts.local ? "local" : null,
      model: opts.model || null,
      whisper: Boolean(opts.whisper),
      listModelsOnly: Boolean(opts.listModels),
      llama: Boolean(opts.llama),
      summaryModel: opts.summaryModel || null,
      removeModel: opts.removeModel ?? null,
    });
  });

// Deliberately its own command rather than another alias on `setup`: an alias
// would inherit setup's offer-to-install behaviour, and a command called
// "status" that starts downloading gigabytes is a nasty surprise. This is
// exactly `vno setup --check` under a name people actually guess.
program
  .command("status")
  .description("Is vno ready to import and transcribe? Reports only, installs nothing")
  .option("--json", "machine-readable output for scripts and other tools")
  .addHelpText(
    "after",
    examples([
      ["vno status", "is everything ready? changes nothing"],
      ["vno status --json", "the same, as JSON"],
      ["vno setup", "...and offer to install whatever is missing"],
    ]) +
      chalk.dim(
        "\nExits 0 when vno is ready and 1 when it isn't, so other tools can gate on it:\n" +
          "  vno status >/dev/null && vno t recording.mp3\n\n" +
          "Required means ffmpeg plus whisper.cpp with at least one valid model - without\n" +
          "those, transcription can't run at all. GPU acceleration and the vno:// handler\n" +
          "are reported as notes, not failures: they change how pleasant vno is, not\n" +
          "whether it works, so a CPU-only machine still reports ready.\n\n" +
          "This covers the external tools. For your settings - target folder, model,\n" +
          "sources, theme - use `vno setting`, or `vno config` for the file's path.\n"
      )
  )
  .action(async (opts) => {
    const ready = await runStatus({ json: Boolean(opts.json) });
    // The exit code is the whole point of the command for a caller that isn't
    // a human reading the output, so it has to be set explicitly - commander
    // resolves the action promise and exits 0 regardless.
    process.exitCode = ready ? 0 : 1;
  });

program
  .command("config")
  .description("Print the path to the memory/config file")
  .action(() => {
    console.log(configFilePath());
  });

program.parseAsync(process.argv).catch((err: unknown) => {
  const detail = err instanceof Error ? err.stack || err.message : String(err);
  console.error(chalk.red(detail));
  process.exitCode = 1;
});
