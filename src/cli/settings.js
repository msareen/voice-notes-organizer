import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig, saveConfig, configFilePath } from "../lib/config.js";
import { ledgerSummary, clearLedger } from "../lib/ledger.js";
import { checkDependencies } from "../lib/setup.js";
import { accelState } from "../lib/whisper.js";
import { resolveModel } from "../lib/whispercpp.js";
import { prompt, CANCELLED } from "./prompt.js";
import { runSetup } from "./setup.js";

const MODELS = ["turbo", "tiny", "base", "small", "medium", "large"];
// "auto" lets whisper.cpp detect per file; a pinned code fixes languages its
// detector confuses for one another (Hindi/Urdu is the classic case).
const LANGUAGES = [
  { name: "Auto-detect", value: "auto" },
  { name: "Hindi", value: "hi" },
  { name: "English", value: "en" },
  { name: "Custom (type a whisper.cpp language code)", value: "custom" },
];

const onOffLabel = (value) => (value ? chalk.green("on") : chalk.red("off"));

/**
 * Accelerator state as one bracketed phrase. The backend is fixed by
 * whichever whisper.cpp build `vno setup` installed, so an unbuilt machine
 * is reported as such rather than as "off".
 */
function gpuLabel(config) {
  const accel = accelState(config);
  if (accel.backend === null) return chalk.yellow("not installed");
  if (accel.backend === "cpu") return chalk.dim("no accelerator build available");
  return accel.use === false ? chalk.red("off") : chalk.green(`on — ${accel.name || accel.backend}`);
}

/** Human-readable state of the three-way auto-translate switch. */
function autoTranslateLabel(value) {
  if (value === true) return chalk.green("on");
  if (value === false) return chalk.red("off");
  return chalk.yellow("ask each time");
}

/**
 * Add/edit/remove manually configured source folders — e.g. wherever a
 * phone's Quick Share/Quick Send drops files. Mutates `config.sources` in
 * place and saves after every change, mirroring the rest of this wizard.
 */
async function manageSources(config) {
  while (true) {
    const sources = config.sources || [];
    const choices = sources.map((s, i) => ({
      name: `${s.path}  ${chalk.dim(`[pattern ${s.pattern || "*"}${s.recursive ? ", includes subfolders" : ""}${s.deleteAfterImport ? ", deletes after import" : ""}]`)}`,
      value: `edit:${i}`,
    }));

    const answer = await prompt([
      {
        type: "list",
        name: "action",
        message: "Source folders (Esc to go back)",
        choices: [
          ...choices,
          new inquirer.Separator(),
          { name: "Add a folder", value: "add" },
          { name: "Done", value: "done" },
        ],
      },
    ]);

    if (answer === CANCELLED || answer.action === "done") return;

    if (answer.action === "add") {
      const entry = await promptSourceEntry(null);
      if (entry) {
        config.sources = [...sources, entry];
        await saveConfig(config);
      }
      continue;
    }

    const [, idxStr] = answer.action.split(":");
    const idx = Number(idxStr);
    const existing = sources[idx];

    const editAnswer = await prompt([
      {
        type: "list",
        name: "action",
        message: existing.path,
        choices: [
          { name: "Edit", value: "edit" },
          { name: "Remove", value: "remove" },
          { name: "Back", value: "back" },
        ],
      },
    ]);
    if (editAnswer === CANCELLED || editAnswer.action === "back") continue;

    if (editAnswer.action === "remove") {
      config.sources = sources.filter((_, i) => i !== idx);
      await saveConfig(config);
      continue;
    }

    const entry = await promptSourceEntry(existing);
    if (entry) {
      config.sources = sources.map((s, i) => (i === idx ? entry : s));
      await saveConfig(config);
    }
  }
}

/** Prompts for one source folder's path/pattern/delete-after-import; returns null on cancel. */
async function promptSourceEntry(existing) {
  const pathRes = await prompt([
    {
      type: "input",
      name: "value",
      message: "Folder path (absolute)",
      default: existing ? existing.path : undefined,
    },
  ]);
  if (pathRes === CANCELLED || !pathRes.value.trim()) return null;
  const folder = path.resolve(pathRes.value.trim());

  const patternRes = await prompt([
    {
      type: "input",
      name: "value",
      message: 'Filename pattern ("*"/"?" wildcard, e.g. "VN*.m4a" — "*" = any audio file)',
      default: existing ? existing.pattern || "*" : "*",
    },
  ]);
  if (patternRes === CANCELLED) return null;

  const recursiveRes = await prompt([
    {
      type: "list",
      name: "value",
      message: "Also scan subfolders of this folder?",
      default: existing ? Boolean(existing.recursive) : false,
      choices: [
        { name: "No — only this folder (typical for a flat drop point)", value: false },
        { name: "Yes — include every subfolder too", value: true },
      ],
    },
  ]);
  if (recursiveRes === CANCELLED) return null;

  const deleteRes = await prompt([
    {
      type: "list",
      name: "value",
      message: "Delete files from this folder once they're safely imported?",
      default: existing ? Boolean(existing.deleteAfterImport) : false,
      choices: [
        { name: "No — keep them here (a real archive folder)", value: false },
        { name: "Yes — this is a disposable landing folder (e.g. Quick Share)", value: true },
      ],
    },
  ]);
  if (deleteRes === CANCELLED) return null;

  return {
    path: folder,
    pattern: patternRes.value.trim() || "*",
    recursive: recursiveRes.value,
    deleteAfterImport: deleteRes.value,
  };
}

/**
 * Interactive wizard for the handful of "direct switches" a user is most
 * likely to want to flip without hand-editing config.json: whether imports
 * auto-translate, the default whisper model, the target folder, and resetting
 * remembered volume choices. Loops until the user chooses Done (or Esc).
 */
export async function runSettings() {
  let config = await loadConfig();

  while (true) {
    const knownCount = Object.keys(config.knownMounts || {}).length;
    const ledger = await ledgerSummary(config.target);
    const deps = await checkDependencies(["ffmpeg", "whisper"]);
    const missingDeps = deps.filter((d) => !d.found).map((d) => d.label);

    const answer = await prompt([
      {
        type: "list",
        name: "action",
        message: "vno settings (Esc to exit)",
        pageSize: 15,
        choices: [
          { name: `Auto-translate imports  ${chalk.dim("[" )}${autoTranslateLabel(config.autoTranslate)}${chalk.dim("]")}`, value: "autoTranslate" },
          { name: `Default whisper model   ${chalk.dim(`[${config.defaultModel || "turbo"}]`)}`, value: "model" },
          { name: `Transcription language  ${chalk.dim(`[${config.transcribeLanguage || "auto"}]`)}`, value: "language" },
          { name: `GPU acceleration        ${chalk.dim("[")}${gpuLabel(config)}${chalk.dim("]")}`, value: "gpu" },
          { name: `Target (import) folder  ${chalk.dim(`[${config.target}]`)}`, value: "target" },
          { name: `Open folder + player when done  ${chalk.dim("[")}${onOffLabel(config.openWhenDone !== false)}${chalk.dim("]")}`, value: "openWhenDone" },
          { name: `Remember deleted recordings  ${chalk.dim("[")}${onOffLabel(config.rememberDeletions !== false)}${chalk.dim("]")}`, value: "rememberDeletions" },
          { name: `Source folders  ${chalk.dim(`[${(config.sources || []).length} configured]`)}`, value: "sources" },
          { name: `Forget remembered volume choices  ${chalk.dim(`[${knownCount} remembered]`)}`, value: "resetMounts" },
          { name: `Forget deleted recordings (clear the ledger)  ${chalk.dim(`[${ledger.forTarget} remembered]`)}`, value: "resetLedger" },
          {
            name:
              `Check ffmpeg + whisper (install what's missing)  ${chalk.dim("[")}` +
              (missingDeps.length === 0
                ? chalk.green("installed")
                : chalk.red(`missing ${missingDeps.join(", ")}`)) +
              chalk.dim("]"),
            value: "setup",
          },
          { name: chalk.dim(`Show config file path`), value: "path" },
          new inquirer.Separator(),
          { name: "Done", value: "done" },
        ],
      },
    ]);

    if (answer === CANCELLED || answer.action === "done") {
      console.log(chalk.dim("Settings saved."));
      return;
    }

    if (answer.action === "autoTranslate") {
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Auto-translate freshly imported notes to English?",
          default: config.autoTranslate,
          choices: [
            { name: "On — always translate imports", value: true },
            { name: "Off — never translate on import", value: false },
            { name: "Ask each time (reset — vno asks once next import)", value: null },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.autoTranslate = res.value;
        await saveConfig(config);
      }
    } else if (answer.action === "model") {
      // Marks each option with whether it's already downloaded, so picking one
      // that isn't doesn't silently kick off a gigabyte download mid-run.
      const modelChoices = await Promise.all(
        MODELS.map(async (m) => ({
          name: `${m}${(await resolveModel(m)) ? chalk.dim(" (downloaded)") : chalk.dim(" (will download)")}`,
          value: m,
        }))
      );
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Default whisper model",
          default: config.defaultModel || "turbo",
          choices: modelChoices,
          loop: false,
        },
      ]);
      if (res !== CANCELLED) {
        config.defaultModel = res.value;
        await saveConfig(config);
      }
    } else if (answer.action === "language") {
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Language whisper.cpp should expect (pin this if auto-detect confuses two languages you speak, e.g. Hindi heard as Urdu)",
          default: LANGUAGES.some((l) => l.value === config.transcribeLanguage) ? config.transcribeLanguage : "custom",
          choices: LANGUAGES,
          loop: false,
        },
      ]);
      if (res !== CANCELLED) {
        let value = res.value;
        if (value === "custom") {
          const custom = await prompt([
            {
              type: "input",
              name: "code",
              message: "whisper.cpp language code (e.g. hi, en, ur)",
              default: config.transcribeLanguage && config.transcribeLanguage !== "auto" ? config.transcribeLanguage : "",
            },
          ]);
          if (custom === CANCELLED || !custom.code.trim()) continue;
          value = custom.code.trim().toLowerCase();
        }
        config.transcribeLanguage = value;
        await saveConfig(config);
      }
    } else if (answer.action === "gpu") {
      const accel = accelState(config);
      if (accel.backend === null || accel.backend === "cpu") {
        console.log(
          chalk.dim(
            accel.backend === null
              ? "Not installed yet — use “Check ffmpeg + whisper” below, which installs whisper.cpp."
              : "No accelerator build is available for this machine, so transcription runs on the CPU."
          )
        );
        continue;
      }
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: `Use ${accel.name || accel.backend} for transcription?`,
          default: accel.use !== false,
          choices: [
            { name: "On — transcribe on the accelerator (much faster)", value: true },
            { name: "Off — transcribe on the CPU", value: false },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.accel = { ...accel, use: res.value };
        await saveConfig(config);
      }
    } else if (answer.action === "target") {
      const res = await prompt([
        {
          type: "input",
          name: "value",
          message: "Target folder for imported notes (absolute path)",
          default: config.target,
        },
      ]);
      if (res !== CANCELLED && res.value.trim()) {
        config.target = path.resolve(res.value.trim());
        await saveConfig(config);
        console.log(chalk.dim(`Target set to ${config.target}`));
      }
    } else if (answer.action === "openWhenDone") {
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "When an import/transcribe run finishes, open the folder(s) and index.html?",
          default: config.openWhenDone !== false,
          choices: [
            { name: "On — reveal the folder(s) and open the player", value: true },
            { name: "Off — finish quietly, open things yourself", value: false },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.openWhenDone = res.value;
        await saveConfig(config);
      }
    } else if (answer.action === "rememberDeletions") {
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Remember recordings deleted through vno, so importing again doesn't copy them back?",
          default: config.rememberDeletions !== false,
          choices: [
            { name: "On — deletes are logged, and import leaves them alone", value: true },
            { name: "Off — import copies whatever the device has", value: false },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.rememberDeletions = res.value;
        await saveConfig(config);
        if (res.value === false && ledger.exists) {
          console.log(chalk.dim("The existing ledger is kept but ignored. Remove it with `vno cleanup ledger`."));
        }
      }
    } else if (answer.action === "sources") {
      await manageSources(config);
    } else if (answer.action === "resetLedger") {
      if (!ledger.exists) {
        console.log(chalk.dim(`No deletion ledger yet (${ledger.path}).`));
        continue;
      }
      const res = await prompt([
        {
          type: "list",
          name: "confirm",
          message: `Forget ${ledger.total} remembered deletion(s)? Those recordings import again if the device still has them.`,
          default: false,
          choices: [
            { name: "No, keep them", value: false },
            { name: "Yes, delete the ledger", value: true },
          ],
        },
      ]);
      if (res !== CANCELLED && res.confirm) {
        await clearLedger();
        console.log(chalk.dim("Deletion ledger removed."));
      }
    } else if (answer.action === "resetMounts") {
      const res = await prompt([
        {
          type: "list",
          name: "confirm",
          message: "Forget all remembered volume import choices? (vno will ask again for each device)",
          default: false,
          choices: [
            { name: "No, keep them", value: false },
            { name: "Yes, forget them", value: true },
          ],
        },
      ]);
      if (res !== CANCELLED && res.confirm) {
        config.knownMounts = {};
        await saveConfig(config);
        console.log(chalk.dim("Forgot all remembered volume choices."));
      }
    } else if (answer.action === "setup") {
      console.log();
      await runSetup();
      // runSetup writes the accel state straight to disk, so the copy held
      // here is stale - and the next save from this loop would undo it.
      config = await loadConfig();
      console.log();
    } else if (answer.action === "path") {
      console.log(configFilePath());
    }
  }
}
