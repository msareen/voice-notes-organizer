import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../lib/config.js";
import { detectVolumes } from "../lib/volumes.js";
import { syncVolume } from "../lib/sync.js";
import { runVisualize } from "./visualize.js";
import { prompt, promptStrict, CANCELLED, PromptCancelled } from "./prompt.js";
import { ensureWhisperInstalled } from "../lib/whisper.js";
import { transcribeMany } from "./transcribe.js";

/**
 * `open === false` (from `--no-open`) stops the viewer from launching at the
 * end; otherwise the remembered `openWhenDone` setting decides.
 */
export async function runImport({ open } = {}) {
  const config = await loadConfig();
  const volumes = await detectVolumes();

  for (const sourcePath of config.sources || []) {
    if (await fs.pathExists(sourcePath)) {
      // Manually configured in config.json - trusted by definition, so it
      // always syncs without the new-volume prompt.
      volumes.push({
        name: path.basename(sourcePath) || "source",
        mountPath: sourcePath,
        id: `source:${sourcePath.toLowerCase()}`,
        isManualSource: true,
      });
    } else {
      console.log(chalk.yellow(`Configured source folder does not exist: ${sourcePath}`));
    }
  }

  if (volumes.length === 0) {
    console.log(chalk.dim("No external/removable volumes detected."));
    return config;
  }

  assignDestNames(volumes);

  console.log(chalk.bold(`Found ${volumes.length} volume(s):`));
  for (const v of volumes) {
    const size = formatSize(v.sizeBytes);
    console.log(`  - ${v.name} ${chalk.dim(`(${v.mountPath}${size ? ", " + size : ""})`)}`);
  }
  console.log();

  let changed = false;
  let imported = [];

  try {
    const result = await importVolumes(volumes, config);
    changed = result.changed;
    imported = result.imported;
  } catch (err) {
    if (err instanceof PromptCancelled) {
      console.log(chalk.dim("\nImport cancelled."));
    } else {
      throw err;
    }
  }

  // Freshly imported notes can be auto-translated to English as they land.
  if (imported.length > 0 && (await maybeAutoTranslate(imported, config))) {
    changed = true;
  }

  if (changed) await saveConfig(config);

  // Hand off to the viewer so the freshly imported notes are immediately
  // browsable. It serves until the browser tab is closed, so this is the last
  // thing the import does. Skipped when the run brought nothing in.
  const shouldOpen = open === false ? false : config.openWhenDone !== false;
  if (imported.length > 0 && shouldOpen) {
    console.log(chalk.dim("\nOpening the viewer..."));
    await runVisualize();
  }

  return config;
}

/**
 * Runs whisper's translate task over the notes imported this session, so audio
 * in any language lands as an English transcript. Honors the remembered
 * `autoTranslate` setting; if it hasn't been decided yet, asks once and
 * remembers the answer. Returns whether config changed (a new remembered
 * choice), so the caller can persist it.
 */
async function maybeAutoTranslate(imported, config) {
  let translate = config.autoTranslate;
  let changed = false;

  if (translate === null || translate === undefined) {
    const answer = await prompt([
      {
        type: "list",
        name: "choice",
        message: `Auto-translate the ${imported.length} newly imported note(s) to English with whisper?`,
        choices: [
          { name: "Yes — translate imports as they come in", value: true },
          { name: "No — just import, I'll transcribe later", value: false },
        ],
        default: true,
      },
    ]);
    if (answer === CANCELLED) {
      // Leave the setting undecided so it's asked again next time.
      return false;
    }
    translate = answer.choice;
    config.autoTranslate = translate;
    changed = true;
    console.log(
      chalk.dim(
        translate
          ? "Remembered: imports will auto-translate. Change this any time with `vno setting`."
          : "Remembered: imports won't auto-translate. Change this any time with `vno setting`."
      )
    );
  }

  if (!translate) return changed;

  if (!(await ensureWhisperInstalled())) {
    console.log(chalk.yellow("Skipping auto-translate — whisper isn't available."));
    return changed;
  }

  const model = config.defaultModel || "turbo";
  console.log(chalk.bold(`\nAuto-translating ${imported.length} imported note(s) with the "${model}" model...`));
  const done = await transcribeMany(imported, { model, translate: true });
  console.log(chalk.bold(`\nDone. Translated ${done}/${imported.length} imported note(s).`));

  return changed;
}

/**
 * Walks the detected volumes, prompting where needed and syncing the ones the
 * user (or a remembered choice) opts into. Returns whether config changed, so
 * the caller can persist it. Any Esc during a prompt throws PromptCancelled,
 * which the caller turns into a clean "Import cancelled" while still saving
 * whatever synced before the cancel.
 *
 * Returns { changed, imported } where `imported` is the flat list of newly
 * copied destination paths across all volumes, so the caller can offer to
 * translate exactly the notes that just landed.
 */
async function importVolumes(volumes, config) {
  let changed = false;
  const imported = [];

  for (const volume of volumes) {
    const known = config.knownMounts[volume.id];

    if (volume.isManualSource) {
      console.log(chalk.dim(`Syncing configured source "${volume.name}".`));
    } else if (known && known.autoImport === false) {
      console.log(chalk.dim(`Skipping "${volume.name}" (remembered: do not import).`));
      continue;
    }

    let proceed = volume.isManualSource || Boolean(known && known.autoImport);
    let subdir = known && known.sourceSubdir;

    if (!volume.isManualSource && !known) {
      const answer = await promptStrict([
        {
          type: "list",
          name: "importNow",
          message: `New volume "${volume.name}" detected at ${volume.mountPath}${
            volume.sizeBytes ? ` (${formatSize(volume.sizeBytes)})` : ""
          }. Import voice notes to local storage?`,
          choices: [
            { name: "No, skip this volume", value: false },
            { name: "Yes, import now", value: true },
          ],
          // Default to No: hitting Enter without reading should never kick
          // off a copy from an unfamiliar/large volume.
          default: false,
        },
      ]);
      proceed = answer.importNow;

      if (proceed) {
        subdir = await promptForSubdir(volume);
      }

      const rememberAnswer = await promptStrict([
        {
          type: "list",
          name: "remember",
          message: "Remember this choice for next time?",
          choices: [
            { name: "Yes, don't ask again for this volume", value: true },
            { name: "No, ask me again next time", value: false },
          ],
          default: true,
        },
      ]);

      if (rememberAnswer.remember) {
        config.knownMounts[volume.id] = {
          name: volume.name,
          autoImport: proceed,
          sourceSubdir: subdir || null,
          lastSynced: null,
        };
        changed = true;
      }
    } else if (!volume.isManualSource) {
      // known && autoImport === true, but let's re-confirm nothing broke it
      console.log(chalk.dim(`Auto-importing remembered volume "${volume.name}".`));
    }

    if (!proceed) continue;

    const effectiveVolume = subdir
      ? { ...volume, mountPath: path.join(volume.mountPath, subdir) }
      : volume;

    const result = await syncVolume(effectiveVolume, config.target);
    imported.push(...result.copiedFiles);
    if (!volume.isManualSource) {
      config.knownMounts[volume.id] = {
        ...(config.knownMounts[volume.id] || { name: volume.name, autoImport: true, sourceSubdir: subdir || null }),
        lastSynced: new Date().toISOString(),
        lastResult: { copied: result.copied, skipped: result.skipped, total: result.total },
      };
      changed = true;
    }
  }

  return { changed, imported };
}

/**
 * Some devices (e.g. many voice recorders) bury audio several folders deep
 * (PRIVATE\SONY\VOICE\FOLDER01\...), which makes the mirrored local path
 * awkward. Let the user pin a subfolder of the volume as the effective sync
 * root instead of always mirroring from the volume's top level.
 */
async function promptForSubdir(volume) {
  const { scope } = await promptStrict([
    {
      type: "list",
      name: "scope",
      message: "Sync from the whole volume, or a specific subfolder within it?",
      choices: [
        { name: "Whole volume", value: "whole" },
        { name: "Specific subfolder", value: "subfolder" },
      ],
      default: "whole",
    },
  ]);

  if (scope === "whole") return null;

  return browseForSubdir(volume);
}

/**
 * Arrow-key folder browser rooted at volume.mountPath, so the user doesn't
 * have to type out a path by hand. Returns the chosen path relative to
 * volume.mountPath, or null for "whole volume".
 */
async function browseForSubdir(volume) {
  let current = volume.mountPath;

  while (true) {
    let entries = [];
    try {
      entries = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // unreadable directory - fall through with no subfolders listed
    }

    const rel = path.relative(volume.mountPath, current);
    const choices = [
      { name: `Use this folder${rel ? ` (${rel})` : " (volume root)"}`, value: { action: "use" } },
    ];
    if (current !== volume.mountPath) {
      choices.push({ name: "..  (go up)", value: { action: "up" } });
    }
    for (const name of entries) {
      choices.push({ name: `${name}/`, value: { action: "down", name } });
    }
    choices.push({ name: "Type a path manually instead", value: { action: "manual" } });
    choices.push({ name: "Cancel - sync whole volume", value: { action: "cancel" } });

    const { choice } = await promptStrict([
      {
        type: "list",
        name: "choice",
        message: `Browsing ${current}`,
        choices,
        pageSize: 15,
      },
    ]);

    if (choice.action === "use") {
      return rel || null;
    }
    if (choice.action === "cancel") {
      return null;
    }
    if (choice.action === "up") {
      current = path.dirname(current);
      continue;
    }
    if (choice.action === "down") {
      current = path.join(current, choice.name);
      continue;
    }
    if (choice.action === "manual") {
      while (true) {
        const { subdir } = await promptStrict([
          {
            type: "input",
            name: "subdir",
            message: `Subfolder path relative to ${volume.mountPath} (e.g. PRIVATE/SONY/VOICE):`,
          },
        ]);
        const trimmed = subdir.trim();
        if (!trimmed) return null;
        const candidate = path.join(volume.mountPath, trimmed);
        if (await fs.pathExists(candidate)) return trimmed;
        console.log(chalk.yellow(`"${candidate}" doesn't exist - try again, or leave blank to use the whole volume.`));
      }
    }
  }
}

/**
 * Two different volumes/sources can share a folder name (e.g. two drives
 * both labeled "Recordings"), which would otherwise make their files land
 * in the same destination folder and mix together. Give later duplicates a
 * disambiguated `destName` derived from their mount path.
 */
function assignDestNames(volumes) {
  const seen = new Map();
  for (const volume of volumes) {
    const key = volume.name.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count > 0) {
      const parent = path.basename(path.dirname(volume.mountPath.replace(/[\\/]+$/, "")));
      volume.destName = parent ? `${volume.name} (${parent})` : `${volume.name} (${count + 1})`;
    }
  }
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
