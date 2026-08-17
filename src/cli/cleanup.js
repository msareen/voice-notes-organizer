import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig } from "../lib/config.js";
import { findAudioFiles } from "../lib/sync.js";
import { resolveNamedFile, reportUnresolved } from "../lib/notes.js";
import { getDurationSeconds } from "../lib/media.js";
import { recordDeletions, clearLedger, ledgerSummary } from "../lib/ledger.js";
import { listOriginalBackups, isOriginalBackup } from "../lib/special-case-handling.js";
import { prompt, CANCELLED } from "./prompt.js";
import { ensureDependencies } from "./setup.js";
import { createProgressBar, locationOf } from "./progress.js";

// Transcript sidecars written next to an audio file (whisper .vtt, the
// derived .txt, plus .srt for completeness) that should go with it on delete.
const TRANSCRIPT_EXTS = [".txt", ".vtt", ".srt"];

function transcriptPathsFor(audioPath) {
  const base = audioPath.slice(0, -path.extname(audioPath).length);
  return TRANSCRIPT_EXTS.map((ext) => base + ext);
}

/**
 * Two ways in: with `files`, delete exactly those recordings; without, scan
 * for recordings shorter than `threshold` (the accidental button presses) and
 * offer those. Both paths end at the same confirm-then-delete, so transcripts
 * go with the audio and the deletion ledger is written either way.
 *
 * `originals` adds the damaged pre-repair copies kept beside repaired Samsung
 * recordings (see lib/special-case-handling.js) to the same offer. They're
 * listed and deleted separately from the recordings because they aren't
 * recordings: they have no transcripts of their own, and they must never reach
 * the deletion ledger - the recording they were made from is still there under
 * its own name, so "remembering" them would suppress a future import of a file
 * that was never deleted.
 */
export async function runCleanup({ threshold = 3, dryRun = false, files = null, originals = false } = {}) {
  const config = await loadConfig();

  if (!(await fs.pathExists(config.target))) {
    console.log(chalk.yellow(`Target folder does not exist yet: ${config.target}`));
    return;
  }

  const allAudio = await findScanned(config.target);
  if (allAudio.length === 0) {
    console.log(chalk.dim("No audio files found."));
    return;
  }

  const backups = originals ? await listOriginalBackups(allAudio) : [];

  const named = Array.isArray(files) && files.length > 0;
  let doomed = named
    ? await resolveNamed(files, allAudio, config.target)
    : await findShortRecordings(allAudio, threshold, config.target);

  if (doomed === null) {
    // The finder already explained why (usually a missing ffprobe). Backups
    // don't need it, so there's still something worth offering.
    if (backups.length === 0) return;
    doomed = [];
  }
  if (doomed.length === 0 && backups.length === 0) {
    console.log(
      named
        ? chalk.yellow("Nothing matched - nothing to delete.")
        : chalk.green(`No recordings shorter than ${threshold}s found.`)
    );
    return;
  }

  if (doomed.length > 0) {
    console.log(
      chalk.bold(
        named
          ? `Deleting ${doomed.length} named recording(s):`
          : `Found ${doomed.length} recording(s) shorter than ${threshold}s:`
      )
    );
    for (const { file, duration } of doomed) {
      const label = path.relative(config.target, file);
      const suffix = duration === undefined || duration === null ? "" : chalk.dim(` (${duration.toFixed(1)}s)`);
      const sidecars = (await existingTranscripts(file)).map((t) => path.extname(t));
      console.log(`  - ${label}${suffix}${sidecars.length ? chalk.dim(` + ${sidecars.join(" ")}`) : ""}`);
    }
  }

  if (backups.length > 0) {
    console.log(chalk.bold(`\nFound ${backups.length} pre-repair original(s):`));
    for (const { backup, recording, size } of backups) {
      console.log(
        `  - ${path.relative(config.target, backup)}` +
          chalk.dim(` (${formatBytes(size)}, repaired as ${path.basename(recording)})`)
      );
    }
  }

  if (dryRun) {
    console.log(chalk.dim("\nDry run - nothing deleted."));
    return;
  }

  const total = doomed.length + backups.length;
  console.log();
  const { confirmed } = await inquirer.prompt([
    {
      type: "list",
      name: "confirmed",
      message: `Delete these ${total} file(s)${doomed.length ? " (and their transcripts, if any)" : ""}?`,
      choices: [
        { name: "No, cancel", value: false },
        { name: "Yes, delete them", value: true },
      ],
      // Default to No: a destructive action should never fire on a bare Enter.
      default: false,
    },
  ]);

  if (!confirmed) {
    console.log(chalk.dim("Cancelled - nothing deleted."));
    return;
  }

  if (doomed.length > 0) {
    const { removed, deleted } = await deleteRecordings(
      doomed.map((d) => d.file),
      config.target
    );

    console.log(
      chalk.green(
        named
          ? `Deleted ${removed}/${doomed.length} recording(s).`
          : `Deleted ${removed}/${doomed.length} short recording(s).`
      )
    );

    const remembered = await recordDeletions(config.target, deleted, {
      enabled: config.rememberDeletions !== false,
    });
    if (remembered > 0) {
      console.log(chalk.dim(`Remembered ${remembered} of them, so a re-import won't bring them back.`));
    }
  }

  if (backups.length > 0) {
    const removed = await deleteOriginalBackups(backups.map((b) => b.backup), config.target);
    console.log(chalk.green(`Deleted ${removed}/${backups.length} pre-repair original(s).`));
  }
}

/** Rough file size for the backup listing - these are the only sizes shown here. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "?";
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * Deletes pre-repair originals, and *only* those: every path is re-checked
 * against the naming rule first, so a bug elsewhere in the selection can't turn
 * this into a recording remover. No transcripts and no ledger entries - see
 * `runCleanup` for why.
 */
async function deleteOriginalBackups(backups, target) {
  let removed = 0;
  for (const file of backups) {
    if (!isOriginalBackup(path.basename(file))) continue;
    try {
      await fs.remove(file);
      removed++;
    } catch (err) {
      console.log(chalk.red(`Failed to delete ${path.relative(target, file)}: ${err.message}`));
    }
  }
  return removed;
}

/**
 * The file walk, with a bar over it: on a big or cloud-synced target this is
 * itself a noticeable wait before anything else can start.
 */
async function findScanned(target) {
  const bar = createProgressBar(chalk.dim("Finding recordings"));
  try {
    return await findAudioFiles(target, { onProgress: bar.report });
  } finally {
    bar.stop();
  }
}

/**
 * Maps the `-f` names onto real audio files, reporting the ones that miss.
 * Duplicates (the same recording named twice, or by two different spellings)
 * collapse to one entry so it isn't listed - or counted - twice.
 */
async function resolveNamed(names, allAudio, target) {
  const seen = new Set();
  const resolved = [];
  let missing = 0;

  for (const name of names) {
    const match = await resolveNamedFile(name, allAudio, target);
    if (!match.file) {
      reportUnresolved(name, match, target);
      missing++;
      continue;
    }
    const key = path.resolve(match.file);
    if (seen.has(key)) continue;
    seen.add(key);
    resolved.push({ file: match.file });
  }

  // A typo shouldn't quietly delete the files that did match: make the user
  // re-run with a corrected list, so what's deleted is always what was asked
  // for in full.
  if (missing > 0 && resolved.length > 0) {
    console.log(chalk.yellow(`\n${missing} of ${names.length} name(s) didn't match - nothing deleted.`));
    return null;
  }
  return resolved;
}

/** The short-recording scan. Returns null when ffprobe isn't available. */
async function findShortRecordings(allAudio, threshold, target) {
  // Without ffprobe every duration reads as unknown, so the scan would find
  // nothing and quietly look like "no short recordings" instead of a miss.
  if (!(await ensureDependencies(["ffmpeg"], { reason: "measuring recording length" }))) {
    console.log(chalk.dim("To delete specific recordings without it, name them: vno cleanup -f <file>..."));
    return null;
  }

  console.log(chalk.dim(`Checking duration of ${allAudio.length} file(s) in ${target}...`));

  // One ffprobe per recording, so a large library sits here for a while.
  const bar = createProgressBar(chalk.dim("Measuring"));
  const short = [];
  try {
    for (const [done, file] of allAudio.entries()) {
      bar.report({ phase: "work", done, total: allAudio.length, ...locationOf(file, target) });
      const duration = await getDurationSeconds(file);
      if (duration !== null && duration < threshold) short.push({ file, duration });
    }
    bar.report({ phase: "work", done: allAudio.length, total: allAudio.length });
  } finally {
    bar.stop();
  }
  return short;
}

/** Transcript sidecars that actually exist next to a recording. */
async function existingTranscripts(audioPath) {
  const found = [];
  for (const candidate of transcriptPathsFor(audioPath)) {
    if (await fs.pathExists(candidate)) found.push(candidate);
  }
  return found;
}

/**
 * Removes each recording and its transcripts, collecting the ledger entries as
 * it goes. Sizes are read *before* the delete - they're half the key the
 * ledger (and import's own skip test) matches on.
 */
async function deleteRecordings(files, target) {
  let removed = 0;
  const deleted = [];

  for (const file of files) {
    try {
      let size = null;
      try {
        size = (await fs.stat(file)).size;
      } catch {
        // unreadable - the entry still works, it just matches on name alone
      }
      await fs.remove(file);
      for (const transcript of await existingTranscripts(file)) {
        await fs.remove(transcript);
      }
      removed++;
      deleted.push({ rel: path.relative(target, file).split(path.sep).join("/"), size, via: "cleanup" });
    } catch (err) {
      console.log(chalk.red(`Failed to delete ${path.relative(target, file)}: ${err.message}`));
    }
  }

  return { removed, deleted };
}

/**
 * `vno cleanup ledger` - throws away the deletion ledger. Deliberately the
 * same act as deleting the file by hand: nothing is recovered, nothing about
 * the recordings changes, vno just stops remembering what was deleted, so the
 * next import copies those recordings back if the device still holds them.
 */
export async function runLedgerCleanup() {
  const config = await loadConfig();
  const summary = await ledgerSummary(config.target);

  if (!summary.exists) {
    console.log(chalk.dim(`No deletion ledger to remove (${summary.path}).`));
    return;
  }

  console.log(chalk.bold(`Deletion ledger: ${summary.path}`));
  console.log(
    chalk.dim(
      `${summary.total} remembered deletion(s)${
        summary.forTarget !== summary.total ? `, ${summary.forTarget} for the current target` : ""
      }.`
    )
  );
  console.log();

  const answer = await prompt([
    {
      type: "list",
      name: "confirmed",
      message: "Forget them all? Recordings you deleted will be re-imported if the device still has them.",
      choices: [
        { name: "Yes, delete the ledger", value: true },
        { name: "No, keep it", value: false },
      ],
      // Unlike deleting recordings, this loses only bookkeeping - nothing that
      // can't be rebuilt by deleting things again - so Yes is a safe default.
      default: true,
    },
  ]);

  if (answer === CANCELLED || !answer.confirmed) {
    console.log(chalk.dim("Cancelled - the ledger is untouched."));
    return;
  }

  await clearLedger();
  console.log(chalk.green("Deletion ledger removed. Nothing is remembered any more."));
}
