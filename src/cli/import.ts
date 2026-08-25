import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { loadConfig, saveConfig } from "../lib/config.ts";
import { detectVolumes } from "../lib/import/volumes.ts";
import { syncVolume } from "../lib/import/sync.ts";
import { resolveAccel, accelState, resolveLanguagePlan } from "../lib/whisper/whisper.ts";
import { runVisualize } from "./visualize.ts";
import { prompt, promptStrict, CANCELLED, PromptCancelled } from "./prompt.ts";
import { ensureDependencies } from "./setup.ts";
import { transcribeMany } from "./transcribe.ts";
import { createProgressBar } from "./progress.ts";
import type { Config, SyncResult, SyncSource } from "../types.ts";

/**
 * A volume as the import flow carries it: a detected removable volume, or a
 * configured `sources` entry dressed as one. `isManualSource` is what tells
 * the two apart - a configured source is trusted by definition and never gets
 * the new-volume prompt.
 */
interface ImportVolume extends SyncSource {
  isManualSource?: boolean;
}

/**
 * `open === false` (from `--no-open`) stops the viewer from launching at the
 * end; otherwise the remembered `openWhenDone` setting decides.
 */
export async function runImport({ open }: { open?: boolean } = {}): Promise<Config> {
  const config = await loadConfig();
  const volumes: ImportVolume[] = await detectVolumes();

  for (const source of config.sources || []) {
    if (await fs.pathExists(source.path)) {
      // Manually configured in config.json/`vno setting`/the UI - trusted by
      // definition, so it always syncs without the new-volume prompt.
      volumes.push({
        name: path.basename(source.path) || "source",
        mountPath: source.path,
        id: `source:${source.path.toLowerCase()}`,
        isManualSource: true,
        pattern: source.pattern,
        deleteAfterImport: source.deleteAfterImport,
        recursive: source.recursive,
        mapTo: source.mapTo,
      });
    } else {
      console.log(chalk.yellow(`Configured source folder does not exist: ${source.path}`));
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
  let imported: string[] = [];

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
async function maybeAutoTranslate(imported: string[], config: Config): Promise<boolean> {
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

  // Only once the answer is "yes, translate": a plain import needs neither
  // whisper nor ffmpeg, so it shouldn't be held up by an install offer.
  if (!(await ensureDependencies(["ffmpeg", "whisper"], { reason: "auto-translating imports" }))) {
    console.log(chalk.yellow("Skipping auto-translate — whisper isn't available."));
    return changed;
  }

  const model = config.defaultModel || "turbo";
  const device = resolveAccel(config);
  console.log(chalk.bold(`\nAuto-translating ${imported.length} imported note(s) with the "${model}" model...`));
  if (device !== "cpu") {
    const accel = accelState(config);
    console.log(chalk.dim(`Using accelerated transcription${accel.name ? ` (${accel.name})` : ""}.`));
  }
  const done = await transcribeMany(imported, {
    model,
    translate: true,
    device,
    ...resolveLanguagePlan(config),
  });
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
async function importVolumes(
  volumes: ImportVolume[],
  config: Config
): Promise<{ changed: boolean; imported: string[] }> {
  let changed = false;
  const imported: string[] = [];

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

    const effectiveVolume: ImportVolume = subdir
      ? { ...volume, mountPath: path.join(volume.mountPath, subdir) }
      : volume;

    const result = await syncCopy(effectiveVolume, config);
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
 * Copies one volume, drawing the progress bar and printing the summary that
 * `syncVolume` itself no longer does - it reports events so the browser can
 * render the same copy as job log lines instead.
 */
async function syncCopy(volume: ImportVolume, config: Config): Promise<SyncResult> {
  const bar = createProgressBar(chalk.dim(`Copying from "${volume.name}"`));
  let result: SyncResult;
  try {
    result = await syncVolume(volume, config.target, {
      rememberDeletions: config.rememberDeletions !== false,
      onProgress: bar.report,
    });
  } finally {
    bar.stop();
  }

  console.log(
    `Synced "${volume.name}": ${chalk.green(result.copied + " copied")}, ${chalk.dim(
      result.skipped + " already up to date"
    )}${result.suppressed > 0 ? `, ${chalk.dim(result.suppressed + " previously deleted")}` : ""}${
      result.deleted > 0 ? `, ${chalk.dim(result.deleted + " removed from source")}` : ""
    } -> ${result.destRoot}`
  );

  if (result.suppressed > 0) {
    console.log(
      chalk.dim(
        `${result.suppressed} recording(s) you deleted through vno were left alone. Run \`vno cleanup ledger\` to forget them and import them again.`
      )
    );
  }

  return result;
}

/**
 * Some devices (e.g. many voice recorders) bury audio several folders deep
 * (PRIVATE\SONY\VOICE\FOLDER01\...), which makes the mirrored local path
 * awkward. Let the user pin a subfolder of the volume as the effective sync
 * root instead of always mirroring from the volume's top level.
 */
async function promptForSubdir(volume: ImportVolume): Promise<string | null> {
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

/** One row of the folder browser: what picking it should do. */
type BrowseAction =
  | { action: "use" }
  | { action: "up" }
  | { action: "down"; name: string }
  | { action: "manual" }
  | { action: "cancel" };

/**
 * Arrow-key folder browser rooted at volume.mountPath, so the user doesn't
 * have to type out a path by hand. Returns the chosen path relative to
 * volume.mountPath, or null for "whole volume".
 */
async function browseForSubdir(volume: ImportVolume): Promise<string | null> {
  let current = volume.mountPath;

  while (true) {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // unreadable directory - fall through with no subfolders listed
    }

    const rel = path.relative(volume.mountPath, current);
    const choices: { name: string; value: BrowseAction }[] = [
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

    const { choice } = (await promptStrict([
      {
        type: "list",
        name: "choice",
        message: `Browsing ${current}`,
        choices,
        pageSize: 15,
      },
    ])) as { choice: BrowseAction };

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
        const trimmed = String(subdir).trim();
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
 * disambiguated `destName` derived from their mount path. Sources with an
 * explicit `mapTo` are skipped - that's a deliberate destination, not a
 * name collision to resolve.
 */
function assignDestNames(volumes: ImportVolume[]): void {
  const seen = new Map<string, number>();
  for (const volume of volumes) {
    if (volume.mapTo) continue; // explicit destination - never override it
    const key = volume.name.toLowerCase();
    const count = seen.get(key) || 0;
    seen.set(key, count + 1);
    if (count > 0) {
      const parent = path.basename(path.dirname(volume.mountPath.replace(/[\\/]+$/, "")));
      volume.destName = parent ? `${volume.name} (${parent})` : `${volume.name} (${count + 1})`;
    }
  }
}

function formatSize(bytes: number | null | undefined): string {
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
