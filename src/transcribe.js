import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import ora from "ora";
import { loadConfig } from "./config.js";
import { findAudioFiles } from "./sync.js";
import { ensureWhisperInstalled, transcribeFile } from "./whisper.js";
import { getDurationSeconds, formatDuration, recordedDate, formatDate } from "./media.js";
import { prompt, CANCELLED } from "./prompt.js";

function transcriptPathFor(audioPath) {
  return audioPath.slice(0, -path.extname(audioPath).length) + ".txt";
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
async function describeFiles(files, target) {
  const rows = [];
  for (const file of files) {
    const date = await recordedDate(file);
    rows.push({
      file,
      label: path.relative(target, file),
      date,
      dateStr: formatDate(date),
    });
  }
  return rows;
}

/** Case-insensitive substring match over the label and formatted date. */
function applyFilter(rows, text) {
  const q = text.trim().toLowerCase();
  if (!q) return rows;
  return rows.filter((r) => r.label.toLowerCase().includes(q) || r.dateStr.toLowerCase().includes(q));
}

export async function runTranscribe({ model, file, filter } = {}) {
  const config = await loadConfig();

  if (!(await fs.pathExists(config.target))) {
    console.log(chalk.yellow(`Target folder does not exist yet: ${config.target}`));
    console.log(chalk.dim("Run the import command first to sync some voice notes."));
    return;
  }

  const allAudio = await findAudioFiles(config.target);

  let selected;
  if (file) {
    // Direct mode: transcribe exactly the file the user named, resolving it
    // against the target folder (by relative path or bare filename) or as an
    // absolute path. Re-transcribes even if a transcript already exists, since
    // asking for a specific file is an explicit request.
    const match = await resolveNamedFile(file, allAudio, config.target);
    if (!match) {
      console.log(chalk.red(`No audio file matching "${file}" was found in ${config.target}.`));
      return;
    }
    selected = [match];
  } else {
    const pending = [];
    for (const f of allAudio) {
      if (!(await fs.pathExists(transcriptPathFor(f)))) pending.push(f);
    }

    if (pending.length === 0) {
      console.log(chalk.green("Everything is already transcribed."));
      return;
    }

    // Recorded dates are cheap (filename/mtime); compute them up front so the
    // filter can also match on date without probing every file's duration.
    let rows = await describeFiles(pending, config.target);

    // Filter step: use --filter if given, else offer an interactive filter box.
    let filterText = filter;
    if (filterText === undefined) {
      const answer = await prompt([
        {
          type: "input",
          name: "filter",
          message: `Filter ${rows.length} file(s) by name or date (Enter for all, Esc to quit):`,
        },
      ]);
      if (answer === CANCELLED) {
        console.log(chalk.dim("Cancelled."));
        return;
      }
      filterText = answer.filter;
    }

    rows = applyFilter(rows, filterText || "");
    if (rows.length === 0) {
      console.log(chalk.yellow(`No files match "${(filterText || "").trim()}".`));
      return;
    }

    // Now that the list is narrowed, probe durations for just these files.
    const spinner = ora(`Reading duration of ${rows.length} file(s)...`).start();
    for (const row of rows) {
      row.durStr = formatDuration(await getDurationSeconds(row.file));
    }
    spinner.stop();

    const labelWidth = Math.min(50, Math.max(...rows.map((r) => r.label.length)));
    const choices = rows.map((r) => ({
      name: `${r.label.padEnd(labelWidth)}  ${chalk.dim(r.dateStr.padEnd(16))}  ${chalk.dim(r.durStr.padStart(7))}`,
      value: r.file,
      checked: true,
    }));

    console.log(chalk.bold(`${rows.length} file(s) to transcribe:`));

    const answer = await prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Select files to transcribe (Esc to quit)",
        choices,
        pageSize: 15,
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
        default: "turbo",
      },
    ]);
    if (answer === CANCELLED) {
      console.log(chalk.dim("Cancelled."));
      return;
    }
    chosenModel = answer.model;
  }

  let done = 0;
  for (const f of selected) {
    console.log(chalk.cyan(`\n[${++done}/${selected.length}] Transcribing ${path.basename(f)}...`));
    try {
      await transcribeFile(f, { model: chosenModel });
      console.log(chalk.green(`Saved -> ${transcriptPathFor(f)}`));
    } catch (err) {
      console.log(chalk.red(`Failed to transcribe ${path.basename(f)}: ${err.message}`));
    }
  }

  console.log(chalk.bold(`\nDone. Transcribed ${done}/${selected.length} file(s).`));
}
