import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig } from "./config.js";
import { findAudioFiles } from "./sync.js";
import { ensureWhisperInstalled, transcribeFile } from "./whisper.js";

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

export async function runTranscribe({ model, file } = {}) {
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

    console.log(chalk.bold(`${pending.length} file(s) need transcription:`));

    const answer = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Select files to transcribe",
        choices: pending.map((f) => ({
          name: path.relative(config.target, f),
          value: f,
          checked: true,
        })),
        pageSize: 15,
      },
    ]);
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
    const answer = await inquirer.prompt([
      {
        type: "list",
        name: "model",
        message: "Whisper model to use",
        choices: ["tiny", "base", "small", "medium", "large"],
        default: "base",
      },
    ]);
    chosenModel = answer.model;
  }

  let done = 0;
  for (const file of selected) {
    console.log(chalk.cyan(`\n[${++done}/${selected.length}] Transcribing ${path.basename(file)}...`));
    try {
      await transcribeFile(file, { model: chosenModel });
      console.log(chalk.green(`Saved -> ${transcriptPathFor(file)}`));
    } catch (err) {
      console.log(chalk.red(`Failed to transcribe ${path.basename(file)}: ${err.message}`));
    }
  }

  console.log(chalk.bold(`\nDone. Transcribed ${done}/${selected.length} file(s).`));
}
