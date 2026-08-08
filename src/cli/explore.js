import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "../lib/config.js";
import { findAudioFiles } from "../lib/sync.js";
import { resolveNamedFile, reportUnresolved } from "../lib/notes.js";
import { openPath, revealInFolder } from "../lib/open.js";
import { createProgressBar } from "./progress.js";

/**
 * Opens the stored recordings in the OS file manager: the target folder by
 * default, or the folder holding a named recording with that file selected.
 *
 * The path is always printed before the launch, because `openPath` is
 * best-effort - on a headless or unusual desktop nothing may come up, and the
 * printed path is then the useful half of the command.
 */
export async function runExplore({ file = null } = {}) {
  const config = await loadConfig();

  // A first run may never have imported anything; opening a folder that isn't
  // there yet fails silently in Explorer, so create it rather than explain it.
  await fs.ensureDir(config.target);

  if (!file) {
    console.log(chalk.dim(config.target));
    if (!openPath(config.target)) {
      console.log(chalk.yellow("Couldn't hand the folder to your file manager - open the path above by hand."));
    }
    return config.target;
  }

  // Naming a recording only needs the file list, and only when a name was
  // given - the bare command shouldn't pay for a scan it doesn't use.
  const bar = createProgressBar(chalk.dim("Finding recordings"));
  let allAudio;
  try {
    allAudio = await findAudioFiles(config.target, { onProgress: bar.report });
  } finally {
    bar.stop();
  }

  const match = await resolveNamedFile(file, allAudio, config.target);
  if (!match.file) {
    reportUnresolved(file, match, config.target);
    process.exitCode = 1;
    return null;
  }

  const full = path.resolve(match.file);
  console.log(chalk.dim(full));
  if (!revealInFolder(full)) {
    console.log(chalk.yellow("Couldn't hand the file to your file manager - open the path above by hand."));
  }
  return full;
}
