import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "../lib/config.js";
import { findAudioFiles } from "../lib/sync.js";
import { ensureWhisperInstalled, transcribeFile } from "../lib/whisper.js";
import { getDurationSeconds, formatDuration, recordedDate, formatDate } from "../lib/media.js";
import { prompt, CANCELLED } from "./prompt.js";
import { runVisualize } from "./visualize.js";
import "./searchableCheckbox.js";

function transcriptPathFor(audioPath) {
  return audioPath.slice(0, -path.extname(audioPath).length) + ".vtt";
}

/**
 * Runs whisper over a list of audio files, logging progress. Shared by the
 * interactive `transcribe` command and the auto-translate step of `import`.
 * Returns the number that succeeded. With `translate: true` the transcripts
 * are English translations rather than verbatim transcriptions.
 */
export async function transcribeMany(files, { model = "turbo", translate = false } = {}) {
  const gerund = translate ? "Translating" : "Transcribing";
  const verb = translate ? "translate" : "transcribe";
  let done = 0;
  for (const f of files) {
    console.log(chalk.cyan(`\n[${done + 1}/${files.length}] ${gerund} ${path.basename(f)}...`));
    try {
      await transcribeFile(f, { model, translate });
      console.log(chalk.green(`Saved -> ${transcriptPathFor(f)}`));
      done++;
    } catch (err) {
      console.log(chalk.red(`Failed to ${verb} ${path.basename(f)}: ${err.message}`));
    }
  }
  return done;
}

/**
 * Resolves a user-provided --file value to one of the discovered audio files.
 * Accepts an absolute path, a path relative to the target folder, or a bare
 * filename matched (case-insensitively) against the known audio files.
 */
async function resolveNamedFile(name, allAudio, target) {
  const candidates = [];
  if (path.isAbsolute(name)) candidates.push(name);
  candidates.push(path.resolve(target, name));

  for (const candidate of candidates) {
    if (await fs.pathExists(candidate)) {
      const resolved = path.resolve(candidate);
      const inList = allAudio.find((f) => path.resolve(f) === resolved);
      if (inList) return inList;
      // Exists but wasn't discovered as audio (e.g. unsupported extension).
      return resolved;
    }
  }

  // Fall back to matching against just the filename, case-insensitively:
  // exact basename first, then the name with the extension dropped (so
  // "250810_1328" finds "250810_1328.mp3"), then a unique substring match.
  const wanted = path.basename(name).toLowerCase();
  const wantedStem = wanted.slice(0, wanted.length - path.extname(wanted).length) || wanted;
  const baseOf = (f) => path.basename(f).toLowerCase();
  const stemOf = (f) => {
    const b = baseOf(f);
    return b.slice(0, b.length - path.extname(b).length);
  };

  let matches = allAudio.filter((f) => baseOf(f) === wanted);
  if (matches.length === 0) matches = allAudio.filter((f) => stemOf(f) === wantedStem);
  if (matches.length === 0) matches = allAudio.filter((f) => baseOf(f).includes(wantedStem));

  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log(
      chalk.yellow(`"${name}" matches ${matches.length} files; be more specific:`)
    );
    for (const f of matches) console.log(`  - ${path.relative(target, f)}`);
    return null;
  }
  return null;
}

/**
 * Builds display metadata (relative label + recorded date) for each file. Date
 * comes from the filename when the recorder encodes it there, else file mtime.
 * Duration is filled in later (only for files that survive filtering) since it
 * needs an ffprobe call per file.
 */
async function describeFiles(entries, target) {
  const rows = [];
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

/**
 * `open === false` (from `--no-open`) forces the reveal off; otherwise the
 * remembered `openWhenDone` setting decides.
 */
export async function runTranscribe({ model, file, filter, translate = false, open } = {}) {
  const config = await loadConfig();

  if (!(await fs.pathExists(config.target))) {
    console.log(chalk.yellow(`Target folder does not exist yet: ${config.target}`));
    console.log(chalk.dim("Run the import command first to sync some voice notes."));
    return;
  }

  const allAudio = await findAudioFiles(config.target);

  // `-f` with a name is direct mode; `-f` on its own (commander gives us `true`
  // for an option declared `[name]`) means "let me pick, and show me everything"
  // - the only way to reach an already-transcribed file from the picker.
  const named = typeof file === "string" ? file : null;
  const pickAll = file === true;

  let selected;
  if (named) {
    // Direct mode: transcribe exactly the file the user named, resolving it
    // against the target folder (by relative path or bare filename) or as an
    // absolute path. Re-transcribes even if a transcript already exists, since
    // asking for a specific file is an explicit request.
    const match = await resolveNamedFile(named, allAudio, config.target);
    if (!match) {
      console.log(chalk.red(`No audio file matching "${named}" was found in ${config.target}.`));
      return;
    }
    selected = [match];
  } else {
    const candidates = [];
    for (const f of allAudio) {
      const hasTranscript = await fs.pathExists(transcriptPathFor(f));
      if (pickAll || !hasTranscript) candidates.push({ file: f, hasTranscript });
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
    // probe every candidate up front behind a spinner.
    const rows = await describeFiles(candidates, config.target);

    const spinner = ora(`Reading duration of ${rows.length} file(s)...`).start();
    for (const row of rows) {
      row.durStr = formatDuration(await getDurationSeconds(row.file));
    }
    spinner.stop();

    const labelWidth = Math.min(50, Math.max(...rows.map((r) => r.label.length)));
    const choices = rows.map((r) => ({
      name:
        `${r.label.padEnd(labelWidth)}  ${chalk.dim(r.dateStr.padEnd(16))}  ${chalk.dim(r.durStr.padStart(7))}` +
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
    ]);
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

  const whisperReady = await ensureWhisperInstalled();
  if (!whisperReady) return;

  let chosenModel = model;
  if (!chosenModel) {
    const answer = await prompt([
      {
        type: "list",
        name: "model",
        message: "Whisper model to use (Esc to quit)",
        choices: ["turbo", "tiny", "base", "small", "medium", "large"],
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

  const done = await transcribeMany(selected, { model: chosenModel, translate });

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
