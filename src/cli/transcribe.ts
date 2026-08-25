import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../lib/config.ts";
import { findMediaFiles } from "../lib/sync.ts";
import { resolveNamedFile, reportUnresolved } from "../lib/notes.ts";
import {
  transcribeFile,
  resolveAccel,
  accelState,
  isDeviceError,
  lastLine,
  resolveLanguagePlan,
} from "../lib/whisper.ts";
import { resolveModel } from "../lib/whispercpp.ts";
import { ensureDependencies } from "./setup.ts";
import { getDurationSeconds, formatDuration, recordedDate, formatDate } from "../lib/media.ts";
import { prompt, CANCELLED } from "./prompt.ts";
import { runVisualize } from "./visualize.ts";
import { createProgressBar, locationOf } from "./progress.ts";
import "./searchableCheckbox.ts";
import type { Config, CrossLanguage } from "../types.ts";

function transcriptPathFor(audioPath: string): string {
  return audioPath.slice(0, -path.extname(audioPath).length) + ".vtt";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface TranscribeManyOptions {
  model?: string;
  translate?: boolean;
  device?: string;
  language?: string;
  crossLanguage?: CrossLanguage | null;
  /** Move every progress line to stderr, so stdout stays clean for `-o -`. */
  toStderr?: boolean;
}

/**
 * Runs whisper over a list of audio files, logging progress. Shared by the
 * interactive `transcribe` command and the auto-translate step of `import`.
 * Returns the number that succeeded. With `translate: true` the transcripts
 * are English translations rather than verbatim transcriptions.
 */
export async function transcribeMany(
  files: string[],
  {
    model = "turbo",
    translate = false,
    device = "cpu",
    language = "auto",
    crossLanguage = null,
    toStderr = false,
  }: TranscribeManyOptions = {}
): Promise<number> {
  const gerund = translate ? "Translating" : "Transcribing";
  const verb = translate ? "translate" : "transcribe";
  // When the transcript itself is going to stdout (`-o -`), every byte of
  // progress chatter has to go to stderr instead or it corrupts the output a
  // pipe receives. This is the usual split - data on stdout, diagnostics on
  // stderr - which vno didn't previously honour anywhere.
  const log = toStderr ? (line: string) => void process.stderr.write(`${line}\n`) : console.log;
  // whisper.cpp's own stdout/stderr are written directly by lib/whisper.ts
  // unless it's given an onOutput sink, so redirecting our own logging isn't
  // enough - the binary's several KB of timings would still land on stdout.
  const onOutput = toStderr ? (line: string) => void process.stderr.write(chalk.dim(`${line}\n`)) : null;
  let current = device;
  let done = 0;
  for (const f of files) {
    log(chalk.cyan(`\n[${done + 1}/${files.length}] ${gerund} ${path.basename(f)}...`));
    try {
      await transcribeFile(f, { model, translate, device: current, language, crossLanguage, onOutput });
      log(chalk.green(`Saved -> ${transcriptPathFor(f)}`));
      done++;
      continue;
    } catch (err) {
      // An accelerator build can still fail at runtime - a driver update, or
      // simply not enough VRAM for this model. Finishing the run on the CPU
      // beats failing every remaining file. Nothing to "forget": unlike the
      // old torch probe, the backend is fixed by which binary was installed
      // and re-checking it costs nothing, so there's no cache to invalidate.
      if (current === "cpu" || !isDeviceError(errorMessage(err))) {
        log(chalk.red(`Failed to ${verb} ${path.basename(f)}: ${errorMessage(err)}`));
        continue;
      }
      log(chalk.yellow(`Accelerator run failed: ${lastLine(errorMessage(err))}`));
      log(chalk.yellow("Falling back to the CPU for the rest of this run."));
      current = "cpu";
    }

    try {
      await transcribeFile(f, { model, translate, device: "cpu", language, crossLanguage, onOutput });
      log(chalk.green(`Saved -> ${transcriptPathFor(f)}`));
      done++;
    } catch (err) {
      log(chalk.red(`Failed to ${verb} ${path.basename(f)}: ${errorMessage(err)}`));
    }
  }
  return done;
}

interface DirectOptions {
  file: string;
  output?: string;
  model?: string;
  translate: boolean;
  config: Config;
}

/**
 * One-shot path for `vno t <file> -o <out>`: no picker, no model prompt, no
 * requirement that the file live under `config.target`. Silently uses
 * `config.defaultModel` (or `-m`) and lets `ensureDependencies` handle the
 * "not set up yet" case exactly like every other command does.
 */
async function runTranscribeDirect({ file, output, model, translate, config }: DirectOptions): Promise<boolean> {
  // `-o -` means "write the transcript to stdout", so the whole run has to
  // keep stdout clean for it. Everything else - our progress lines and
  // whisper.cpp's several KB of timings - moves to stderr for the duration.
  const toStdout = output === "-";
  const say = toStdout ? (line: string) => void process.stderr.write(`${line}\n`) : console.log;

  const resolved = path.resolve(process.cwd(), file);
  if (!(await fs.pathExists(resolved))) {
    // Errors go to stderr regardless of mode: a caller redirecting stdout to a
    // file should still see why nothing happened.
    process.stderr.write(chalk.red(`File not found: ${resolved}\n`));
    return false;
  }

  if (!(await ensureDependencies(["ffmpeg", "whisper"], { reason: "transcribing" }))) return false;

  const chosenModel = model || config.defaultModel || "turbo";
  const device = resolveAccel(config);
  if (device !== "cpu") {
    const accel = accelState(config);
    say(chalk.dim(`\nUsing accelerated transcription${accel.name ? ` (${accel.name})` : ""}.`));
  }

  const done = await transcribeMany([resolved], {
    model: chosenModel,
    translate,
    device,
    toStderr: toStdout,
    ...resolveLanguagePlan(config),
  });
  if (done === 0) return false;

  const produced = transcriptPathFor(resolved);

  if (toStdout) {
    // whisper.cpp always writes beside the source, so this is a read-then-clean
    // rather than a redirect. Removing it matters: the file wasn't asked for,
    // and leaving it behind would quietly mark the recording as transcribed.
    const text = await fs.readFile(produced, "utf8");
    process.stdout.write(text);
    await fs.remove(produced).catch(() => {});
    return true;
  }

  if (output) {
    const dest = path.resolve(process.cwd(), output);
    await fs.ensureDir(path.dirname(dest));
    await fs.move(produced, dest, { overwrite: true });
    say(chalk.green(`Moved -> ${dest}`));
  }
  return true;
}

/** A file the picker could offer, before its display metadata is filled in. */
interface Candidate {
  file: string;
  hasTranscript: boolean;
}

/** A candidate plus everything the picker row shows. */
interface DescribedFile extends Candidate {
  label: string;
  date: Date | null;
  dateStr: string;
  /** Filled in by the duration pass, which runs after describeFiles. */
  durStr?: string;
}

/**
 * Builds display metadata (relative label + recorded date) for each file. Date
 * comes from the filename when the recorder encodes it there, else file mtime.
 * Duration is filled in later (only for files that survive filtering) since it
 * needs an ffprobe call per file.
 */
async function describeFiles(entries: Candidate[], target: string): Promise<DescribedFile[]> {
  const rows: DescribedFile[] = [];
  for (const entry of entries) {
    const date = await recordedDate(entry.file);
    rows.push({
      ...entry,
      label: path.relative(target, entry.file),
      date,
      dateStr: formatDate(date),
    });
  }
  // Newest first. Files whose date couldn't be determined sort to the bottom.
  rows.sort((a, b) => {
    const ta = a.date instanceof Date ? a.date.getTime() : -Infinity;
    const tb = b.date instanceof Date ? b.date.getTime() : -Infinity;
    return tb - ta;
  });
  return rows;
}

export interface RunTranscribeOptions {
  model?: string;
  /** A name, or `true` for bare `-f` (pick from every file). */
  file?: string | boolean;
  /** The positional `vno t <file>` form: one-shot, no picker. */
  directFile?: boolean;
  filter?: string;
  translate?: boolean;
  output?: string;
  open?: boolean;
}

/**
 * `open === false` (from `--no-open`) forces the reveal off; otherwise the
 * remembered `openWhenDone` setting decides.
 */
export async function runTranscribe({
  model,
  file,
  directFile = false,
  filter,
  translate = false,
  output,
  open,
}: RunTranscribeOptions = {}): Promise<boolean | void> {
  const config = await loadConfig();

  if (directFile) {
    return runTranscribeDirect({ file: String(file), output, model, translate, config });
  }

  if (!(await fs.pathExists(config.target))) {
    console.log(chalk.yellow(`Target folder does not exist yet: ${config.target}`));
    console.log(chalk.dim("Run the import command first to sync some voice notes."));
    return;
  }

  // Up front, not after the picker: the file list shows durations, which need
  // ffprobe, so finding out late would mean a list of "?" and a wasted choice.
  if (!(await ensureDependencies(["ffmpeg", "whisper"], { reason: "transcribing" }))) return;

  const findBar = createProgressBar(chalk.dim("Finding recordings"));
  let allAudio: string[];
  try {
    allAudio = await findMediaFiles(config.target, { onProgress: findBar.report });
  } finally {
    findBar.stop();
  }

  // `-f` with a name is direct mode; `-f` on its own (commander gives us `true`
  // for an option declared `[name]`) means "let me pick, and show me everything"
  // - the only way to reach an already-transcribed file from the picker.
  const named = typeof file === "string" ? file : null;
  const pickAll = file === true;

  let selected: string[];
  if (named) {
    // Direct mode: transcribe exactly the file the user named, resolving it
    // against the target folder (by relative path or bare filename) or as an
    // absolute path. Re-transcribes even if a transcript already exists, since
    // asking for a specific file is an explicit request.
    const match = await resolveNamedFile(named, allAudio, config.target);
    if (!match.file) {
      reportUnresolved(named, match, config.target);
      return;
    }
    selected = [match.file];
  } else {
    const candidates: Candidate[] = [];
    const checkBar = createProgressBar(chalk.dim("Checking transcripts"));
    try {
      for (const [done, f] of allAudio.entries()) {
        checkBar.report({ phase: "work", done, total: allAudio.length, ...locationOf(f, config.target) });
        const hasTranscript = await fs.pathExists(transcriptPathFor(f));
        if (pickAll || !hasTranscript) candidates.push({ file: f, hasTranscript });
      }
    } finally {
      checkBar.stop();
    }

    if (candidates.length === 0) {
      if (pickAll) {
        console.log(chalk.yellow(`No audio files found in ${config.target}.`));
      } else {
        console.log(chalk.green("Everything is already transcribed."));
        console.log(chalk.dim("Run `vno t -f` to pick from every file and re-transcribe one."));
      }
      return;
    }

    // Recorded dates are cheap (filename/mtime); duration needs an ffprobe call
    // per file. The picker filters live as you type, so we can't narrow first —
    // probe every candidate up front, behind a bar since that's the wait.
    const rows = await describeFiles(candidates, config.target);

    const bar = createProgressBar(chalk.dim("Reading durations"));
    try {
      for (const [done, row] of rows.entries()) {
        bar.report({ phase: "work", done, total: rows.length, ...locationOf(row.file, config.target) });
        row.durStr = formatDuration(await getDurationSeconds(row.file));
      }
      bar.report({ phase: "work", done: rows.length, total: rows.length, dir: "", name: "" });
    } finally {
      bar.stop();
    }

    const labelWidth = Math.min(50, Math.max(...rows.map((r) => r.label.length)));
    const choices = rows.map((r) => ({
      name:
        `${r.label.padEnd(labelWidth)}  ${chalk.dim(r.dateStr.padEnd(16))}  ${chalk.dim((r.durStr ?? "?").padStart(7))}` +
        (r.hasTranscript ? chalk.yellow("  • transcribed") : ""),
      value: r.file,
      // Pre-checking everything is right when the list is only untranscribed
      // files, but not here: a reflex Enter would overwrite every transcript
      // you have. In re-transcribe mode you pick explicitly.
      checked: !pickAll,
    }));

    if (pickAll) {
      console.log(chalk.bold(`${rows.length} file(s) in ${config.target}:`));
      console.log(
        chalk.dim("Nothing is pre-selected. Space to pick; rows marked • already have a transcript.")
      );
    } else {
      console.log(chalk.bold(`${rows.length} file(s) to transcribe:`));
    }

    const answer = await prompt([
      {
        type: "searchable-checkbox",
        name: "selected",
        message: pickAll ? "Select files to (re-)transcribe" : "Select files to transcribe",
        choices,
        pageSize: 15,
        loop: false,
        initialFilter: filter || "",
      },
    ] as never);
    if (answer === CANCELLED) {
      console.log(chalk.dim("Cancelled."));
      return;
    }
    selected = answer.selected;

    if (selected.length === 0) {
      console.log(chalk.dim("Nothing selected."));
      return;
    }

    // Whisper writes the .vtt straight over the old one, so any corrections
    // made in the transcript editor are gone. Worth one deliberate keystroke.
    const overwriting = rows.filter((r) => r.hasTranscript && selected.includes(r.file));
    if (overwriting.length > 0) {
      console.log();
      for (const r of overwriting) console.log(chalk.yellow(`  overwrites  ${r.label}`));
      const confirm = await prompt([
        {
          type: "list",
          name: "ok",
          message: `Replace ${overwriting.length} existing transcript(s)? Any edits you made will be lost.`,
          choices: [
            { name: "No, cancel", value: false },
            { name: "Yes, re-transcribe", value: true },
          ],
          default: false,
        },
      ]);
      if (confirm === CANCELLED || !confirm.ok) {
        console.log(chalk.dim("Cancelled - nothing re-transcribed."));
        return;
      }
    }
  }

  let chosenModel = model;
  if (!chosenModel) {
    // Marks each option with whether it's already downloaded, so picking one
    // that isn't doesn't silently kick off a gigabyte download mid-run.
    const modelNames = ["turbo", "tiny", "base", "small", "medium", "large"];
    const choices = await Promise.all(
      modelNames.map(async (m) => ({
        name: `${m}${(await resolveModel(m)) ? chalk.dim(" (downloaded)") : chalk.dim(" (will download)")}`,
        value: m,
      }))
    );
    const answer = await prompt([
      {
        type: "list",
        name: "model",
        message: "Whisper model to use (Esc to quit)",
        choices,
        default: config.defaultModel || "turbo",
        loop: false,
      },
    ]);
    if (answer === CANCELLED) {
      console.log(chalk.dim("Cancelled."));
      return;
    }
    chosenModel = answer.model;
  }

  const device = resolveAccel(config);
  if (device !== "cpu") {
    const accel = accelState(config);
    console.log(chalk.dim(`\nUsing accelerated transcription${accel.name ? ` (${accel.name})` : ""}.`));
    if (accel.use === null) console.log(chalk.dim("Turn it off any time with `vno setting`."));
  }

  const done = await transcribeMany(selected, {
    model: chosenModel,
    translate,
    device,
    ...resolveLanguagePlan(config),
  });

  const label = translate ? "Translated" : "Transcribed";
  console.log(chalk.bold(`\nDone. ${label} ${done}/${selected.length} file(s).`));

  if (done === 0) return;

  // Hand off to the viewer so the new transcripts can be read, edited and
  // played straight away. It serves until the browser tab is closed.
  if (open === false ? false : config.openWhenDone !== false) {
    console.log(chalk.dim("\nOpening the viewer..."));
    await runVisualize();
  }
}
