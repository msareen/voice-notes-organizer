import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig, saveConfig, configFilePath } from "../lib/config.ts";
import { THEMES, themeOf } from "../lib/shared/themes.ts";
import { ledgerSummary, clearLedger } from "../lib/notes/ledger.ts";
import { checkDependencies } from "../lib/setup.ts";
import { accelState, crossLanguageState } from "../lib/whisper/whisper.ts";
import { decodeState, decodeArgs, neutralKnobs } from "../lib/whisper/decodeProfile.ts";
import { WHISPER_LANGUAGES, languageLabel } from "../lib/shared/languages.ts";
import { resolveModel, resolveVadModel } from "../lib/whisper/whispercpp.ts";
import { listModels as listLlamaModels } from "../lib/llama/llamacpp.ts";
import { prompt, CANCELLED } from "./prompt.ts";
import { runSetup } from "./setup.ts";
import { DEFAULT_PORT } from "./visualize.ts";
import type { Config, ManualDecode, Source } from "../types.ts";

/** The `ManualDecode` fields that take a number, for the shared prompt row below. */
type NumericKnob = {
  [K in keyof ManualDecode]: ManualDecode[K] extends number | null ? K : never;
}[keyof ManualDecode];

const MODELS = ["turbo", "tiny", "base", "small", "medium", "large"];
// "auto" lets whisper.cpp detect per file; a pinned code fixes languages its
// detector confuses for one another (Hindi/Urdu is the classic case).
// The pin menu stays short on purpose - these are the two the confusable
// case is about, and the full hundred lives one keystroke away under
// "Custom". The cross-language menus below use the whole list, since a
// detection result can be any of them.
const LANGUAGES = [
  { name: "Auto-detect", value: "auto" },
  { name: "Hindi", value: "hi" },
  { name: "English", value: "en" },
  { name: "Custom (type a whisper.cpp language code)", value: "custom" },
];

const LANGUAGE_CHOICES = WHISPER_LANGUAGES.map((l) => ({ name: `${l.label}  ${chalk.dim(l.code)}`, value: l.code }));

/** One-line summary of the cross-language block for the menu. */
function crossLanguageLabel(config: Config): string {
  const { model, map } = crossLanguageState(config);
  if (!model) return chalk.red("off");
  const pairs = Object.entries(map);
  if (pairs.length === 0) return `${model}, no rewrites yet`;
  return `${model}: ${pairs.map(([from, to]) => `${from}->${to}`).join(", ")}`;
}

const onOffLabel = (value: boolean) => (value ? chalk.green("on") : chalk.red("off"));

/** One-line summary of the decode block for the main menu. */
function decodeLabel(config: Config): string {
  const { mode, manual } = decodeState(config);
  if (mode !== "manual") return mode === "adaptive" ? chalk.green("adaptive") : chalk.dim("auto");
  const count = decodeArgs(manual, "/vad").length;
  return count === 0 ? chalk.yellow("manual, nothing set") : chalk.yellow("manual");
}

/**
 * How hard vno works for a clean transcript. The mode is the master switch,
 * and the flags below it only exist in "manual" - the other two modes decide
 * for themselves (see lib/whisper/decodeProfile.ts), so showing knobs there
 * would promise a control that isn't wired to anything.
 *
 * Mirrors manageCrossLanguage: a sub-loop that redraws after every change and
 * saves as it goes.
 */
async function manageDecode(config: Config): Promise<void> {
  // Every numeric flag, so the rows below are one table rather than ten
  // near-identical prompt blocks. `hint` is what whisper.cpp does if we say
  // nothing - shown as the default so the user can see what they're moving
  // away from without us storing it (see ManualDecode on why).
  const NUMBERS: { key: NumericKnob; label: string; hint: string; blurb: string }[] = [
    { key: "entropyThold", label: "Entropy threshold", hint: "2.40", blurb: "lower retries a garbled window sooner" },
    { key: "logprobThold", label: "Log-prob threshold", hint: "-1.00", blurb: "higher retries a low-confidence window sooner" },
    { key: "noSpeechThold", label: "No-speech threshold", hint: "0.60", blurb: "lower drops more near-silence" },
    { key: "beamSize", label: "Beam size", hint: "whisper.cpp's", blurb: "wider search, slower" },
    { key: "bestOf", label: "Best-of", hint: "whisper.cpp's", blurb: "more candidates per window, slower" },
    { key: "temperatureInc", label: "Temperature step", hint: "0.20", blurb: "0 disables the fallback ladder entirely" },
    { key: "vadThreshold", label: "Speech-detection threshold", hint: "0.50", blurb: "higher is stricter about what counts as speech" },
  ];

  while (true) {
    const { mode, manual } = decodeState(config);
    const num = (key: NumericKnob) => (manual[key] == null ? chalk.dim("default") : String(manual[key]));
    const tri = (value: boolean | null, on: string, off: string) =>
      value === null ? chalk.dim("default") : value ? on : off;

    const vadModel = await resolveVadModel();
    if (mode === "manual" && manual.vad && !vadModel) {
      console.log(
        chalk.yellow("\nSpeech detection is on, but its model isn't installed - run `vno setup`.\nRuns fall back to no VAD until then.")
      );
    }

    const answer = await prompt([
      {
        type: "list",
        name: "action",
        message: "Transcription quality (Esc to go back)",
        pageSize: 18,
        choices: [
          { name: `Mode  ${chalk.dim("[")}${decodeLabel(config)}${chalk.dim("]")}`, value: "mode" },
          ...(mode === "manual"
            ? [
                new inquirer.Separator(),
                {
                  name: `Carry context between windows  ${chalk.dim("[")}${tri(manual.carryContext, chalk.green("on"), chalk.red("off"))}${chalk.dim("]")}`,
                  value: "carryContext",
                },
                {
                  name: `Speech detection (VAD)  ${chalk.dim("[")}${onOffLabel(manual.vad)}${chalk.dim("]")}`,
                  value: "vad",
                },
                {
                  name: `Flash attention  ${chalk.dim("[")}${tri(manual.flashAttn, chalk.green("on"), chalk.red("off"))}${chalk.dim("]")}`,
                  value: "flashAttn",
                },
                {
                  name: `Suppress non-speech tokens  ${chalk.dim("[")}${onOffLabel(manual.suppressNst)}${chalk.dim("]")}`,
                  value: "suppressNst",
                },
                new inquirer.Separator(),
                ...NUMBERS.map((n) => ({
                  name: `${n.label}  ${chalk.dim("[")}${num(n.key)}${chalk.dim("]")}`,
                  value: `num:${n.key}`,
                })),
                new inquirer.Separator(),
                { name: chalk.dim("Reset every flag to whisper.cpp's defaults"), value: "reset" },
              ]
            : []),
          new inquirer.Separator(),
          { name: "Done", value: "done" },
        ],
      },
    ]);

    if (answer === CANCELLED || answer.action === "done") return;

    if (answer.action === "mode") {
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "How hard should vno work for a clean transcript?",
          default: mode,
          choices: [
            {
              name: `Adaptive  ${chalk.dim("- one normal pass, then retry on safer settings only if it looks hallucinated")}`,
              value: "adaptive",
            },
            { name: `Auto  ${chalk.dim("- one pass on whisper.cpp's defaults, never retried")}`, value: "auto" },
            { name: `Manual  ${chalk.dim("- one pass on the flags you set below")}`, value: "manual" },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.decode = { ...decodeState(config), mode: res.value };
        await saveConfig(config);
        if (res.value === "adaptive") {
          console.log(
            chalk.dim("A clean recording costs exactly what \"auto\" costs - only a file that\nactually trips a loop detector pays for a retry.")
          );
        }
      }
      continue;
    }

    if (answer.action === "reset") {
      config.decode = { ...decodeState(config), manual: neutralKnobs() };
      await saveConfig(config);
      console.log(chalk.dim("Every flag is back to whisper.cpp's own default."));
      continue;
    }

    if (answer.action === "carryContext" || answer.action === "flashAttn") {
      const key = answer.action as "carryContext" | "flashAttn";
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message:
            key === "carryContext"
              ? "Let each 30s window see what the previous one transcribed?"
              : "Use flash attention?",
          default: manual[key],
          choices: [
            { name: `Leave it to whisper.cpp  ${chalk.dim("(default)")}`, value: null },
            {
              name:
                key === "carryContext"
                  ? `On  ${chalk.dim("- better continuity across windows")}`
                  : `On  ${chalk.dim("- faster")}`,
              value: true,
            },
            {
              name:
                key === "carryContext"
                  ? `Off  ${chalk.dim("- a repetition loop can't spread past one window; the anti-loop lever")}`
                  : `Off  ${chalk.dim("- slower, but rules out the Metal/CUDA kernel as the cause of bad output")}`,
              value: false,
            },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.decode = { ...decodeState(config), manual: { ...manual, [key]: res.value } };
        await saveConfig(config);
      }
      continue;
    }

    if (answer.action === "vad" || answer.action === "suppressNst") {
      const key = answer.action as "vad" | "suppressNst";
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message:
            key === "vad"
              ? "Filter silence out before whisper.cpp sees it?"
              : "Suppress non-speech tokens?",
          default: manual[key],
          choices: [
            {
              name:
                key === "vad"
                  ? `On  ${chalk.dim("- silence is where phantom text comes from")}`
                  : `On  ${chalk.dim("- fewer [music]/[noise] style inventions")}`,
              value: true,
            },
            { name: `Off  ${chalk.dim("(default)")}`, value: false },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.decode = { ...decodeState(config), manual: { ...manual, [key]: res.value } };
        await saveConfig(config);
      }
      continue;
    }

    if (typeof answer.action === "string" && answer.action.startsWith("num:")) {
      const key = answer.action.slice(4) as NumericKnob;
      const meta = NUMBERS.find((n) => n.key === key)!;
      const res = await prompt([
        {
          type: "input",
          name: "value",
          message: `${meta.label} - ${meta.blurb}. Blank leaves ${meta.hint === "whisper.cpp's" ? "whisper.cpp's default" : `it at ${meta.hint}`}`,
          default: manual[key] == null ? "" : String(manual[key]),
          validate: (input: string) => {
            const raw = input.trim();
            if (!raw) return true;
            return Number.isFinite(Number(raw)) ? true : "Enter a number, or leave it blank for the default.";
          },
        },
      ]);
      if (res !== CANCELLED) {
        const raw = String(res.value).trim();
        config.decode = {
          ...decodeState(config),
          manual: { ...manual, [key]: raw === "" ? null : Number(raw) },
        };
        await saveConfig(config);
      }
    }
  }
}

/**
 * Accelerator state as one bracketed phrase. The backend is fixed by
 * whichever whisper.cpp build `vno setup` installed, so an unbuilt machine
 * is reported as such rather than as "off".
 */
function gpuLabel(config: Config): string {
  const accel = accelState(config);
  if (accel.backend === null) return chalk.yellow("not installed");
  if (accel.backend === "cpu") return chalk.dim("no accelerator build available");
  return accel.use === false ? chalk.red("off") : chalk.green(`on — ${accel.name || accel.backend}`);
}

/** Human-readable state of the three-way auto-translate switch. */
function autoTranslateLabel(value: boolean | null): string {
  if (value === true) return chalk.green("on");
  if (value === false) return chalk.red("off");
  return chalk.yellow("ask each time");
}

/**
 * The cross-language block: pick the model that runs the detection pass, and
 * keep a list of "when it says X, transcribe as Y" rewrites.
 *
 * Mirrors manageSources below - a sub-loop that redraws after every change
 * and saves as it goes. The model is the master switch: with it off there is
 * no detection pass at all, and the rewrites sit there unused.
 */
async function manageCrossLanguage(config: Config): Promise<void> {
  while (true) {
    const { model, map } = crossLanguageState(config);
    const pairs = Object.entries(map);
    const pinned = (config.transcribeLanguage || "auto") !== "auto";

    const rows = pairs.map(([from, to]) => ({
      name: `${languageLabel(from)} ${chalk.dim("->")} ${languageLabel(to)}  ${chalk.dim(`[${from} -> ${to}]`)}`,
      value: `remove:${from}`,
    }));

    if (model && pinned) {
      console.log(
        chalk.yellow(
          `
Transcription language is pinned to "${config.transcribeLanguage}", so detection never runs. Set it to Auto to use these.`
        )
      );
    }

    const answer = await prompt([
      {
        type: "list",
        name: "action",
        message: "Cross-language detection (Esc to go back)",
        pageSize: 15,
        choices: [
          { name: `Detect model  ${chalk.dim(`[${model || "off"}]`)}`, value: "model" },
          ...(rows.length ? [new inquirer.Separator(), ...rows] : []),
          new inquirer.Separator(),
          { name: "Add a mapping", value: "add" },
          { name: "Done", value: "done" },
        ],
      },
    ]);

    if (answer === CANCELLED || answer.action === "done") return;

    if (answer.action === "model") {
      const choices: { name: string; value: string }[] = [{ name: "Off - no detection pass", value: "off" }];
      for (const m of MODELS) {
        const have = await resolveModel(m);
        choices.push({ name: `${m}${have ? chalk.dim(" (downloaded)") : chalk.dim(" (will download)")}`, value: m });
      }
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Model to detect the language with (small is a good balance; it's installed by default)",
          default: model || "off",
          choices,
          loop: false,
        },
      ]);
      if (res === CANCELLED) continue;
      const chosen = res.value === "off" ? null : res.value;
      config.crossLanguage = { ...crossLanguageState(config), model: chosen };
      // Turning detection on while a language is pinned would do nothing, and
      // silently doing nothing is worse than moving the pin the user has
      // clearly just decided against. The browser dialog flips it the same way.
      if (chosen && pinned) {
        config.transcribeLanguage = "auto";
        console.log(chalk.dim('Transcription language set back to "auto" so detection can run.'));
      }
      await saveConfig(config);
      continue;
    }

    if (answer.action === "add") {
      const from = await prompt([
        {
          type: "list",
          name: "value",
          message: "When whisper.cpp detects...",
          pageSize: 15,
          choices: LANGUAGE_CHOICES,
          loop: false,
        },
      ]);
      if (from === CANCELLED) continue;
      const to = await prompt([
        {
          type: "list",
          name: "value",
          message: `...transcribe "${languageLabel(from.value)}" as`,
          pageSize: 15,
          choices: LANGUAGE_CHOICES.filter((c) => c.value !== from.value),
          loop: false,
        },
      ]);
      if (to === CANCELLED) continue;
      config.crossLanguage = {
        ...crossLanguageState(config),
        map: { ...map, [from.value]: to.value },
      };
      await saveConfig(config);
      continue;
    }

    const [, code] = String(answer.action).split(":");
    const res = await prompt([
      {
        type: "list",
        name: "confirm",
        message: `Remove ${languageLabel(code)} -> ${languageLabel(map[code])}?`,
        default: false,
        choices: [
          { name: "No, keep it", value: false },
          { name: "Yes, remove it", value: true },
        ],
      },
    ]);
    if (res === CANCELLED || !res.confirm) continue;
    const next = { ...map };
    delete next[code];
    config.crossLanguage = { ...crossLanguageState(config), map: next };
    await saveConfig(config);
  }
}

/**
 * Add/edit/remove manually configured source folders — e.g. wherever a
 * phone's Quick Share/Quick Send drops files. Mutates `config.sources` in
 * place and saves after every change, mirroring the rest of this wizard.
 */
async function manageSources(config: Config): Promise<void> {
  while (true) {
    const sources = config.sources || [];
    const choices = sources.map((s, i) => ({
      name: `${s.path}  ${chalk.dim(`[pattern ${s.pattern || "*"}${s.recursive ? ", includes subfolders" : ""}${s.deleteAfterImport ? ", deletes after import" : ""}${s.mapTo ? `, maps to "${s.mapTo}"` : ""}]`)}`,
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
      const entry = await promptSourceEntry(null, config);
      if (entry) {
        config.sources = [...sources, entry];
        await saveConfig(config);
      }
      continue;
    }

    const [, idxStr] = String(answer.action).split(":");
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

    const entry = await promptSourceEntry(existing, config);
    if (entry) {
      config.sources = sources.map((s, i) => (i === idx ? entry : s));
      await saveConfig(config);
    }
  }
}

/** One row of the mapping-folder browser: what picking it should do. */
type BrowseAction =
  | { action: "use" }
  | { action: "up" }
  | { action: "down"; name: string }
  | { action: "manual" }
  | { action: "cancel" };

/**
 * Arrow-key folder browser rooted at `config.target`, for picking a source's
 * mapping folder. Unlike `browseForSubdir` in cli/import.ts (which browses a
 * source to *scan from*, so a typed path must already exist), a mapping
 * folder is a *destination* - it's created with `fs.ensureDir` at copy time,
 * so typing a path that doesn't exist yet is fine here. Returns the chosen
 * path relative to `config.target`, or null for "no mapping - default
 * behavior".
 *
 * Uses `prompt` rather than `promptStrict`: every other menu in this wizard
 * treats Esc as "back out of this step", and a throw here would unwind the
 * whole settings loop instead.
 */
async function browseMapToFolder(config: Config): Promise<string | null> {
  let current = config.target;

  while (true) {
    let entries: string[] = [];
    try {
      entries = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // doesn't exist yet or unreadable - fall through with no subfolders listed
    }

    const rel = path.relative(config.target, current);
    const choices: { name: string; value: BrowseAction }[] = [
      { name: `Use this folder${rel ? ` (${rel})` : " (target root - i.e. no mapping)"}`, value: { action: "use" } },
    ];
    if (current !== config.target) {
      choices.push({ name: "..  (go up)", value: { action: "up" } });
    }
    for (const name of entries) {
      choices.push({ name: `${name}/`, value: { action: "down", name } });
    }
    choices.push({ name: "Type a path manually instead (doesn't need to exist yet)", value: { action: "manual" } });
    choices.push({ name: "Cancel - no mapping (default folder naming)", value: { action: "cancel" } });

    const answer = await prompt([
      {
        type: "list",
        name: "choice",
        message: `Browsing ${current}`,
        choices,
        pageSize: 15,
      },
    ]);
    if (answer === CANCELLED) return null;
    const choice = answer.choice as BrowseAction;

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
      const typed = await prompt([
        {
          type: "input",
          name: "subdir",
          message: `Folder path relative to ${config.target} (e.g. Work/Meetings):`,
        },
      ]);
      if (typed === CANCELLED) return null;
      const trimmed = String(typed.subdir).trim();
      return trimmed || null;
    }
  }
}

/** Prompts for one source folder's path/pattern/delete-after-import/mapping-folder; returns null on cancel. */
async function promptSourceEntry(existing: Source | null, config: Config): Promise<Source | null> {
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

  const mapToRes = await prompt([
    {
      type: "list",
      name: "value",
      message: "Route this source's files into a specific folder inside your target folder?",
      default: existing && existing.mapTo ? "browse" : "default",
      choices: [
        { name: `No — use the default folder (named after "${path.basename(folder)}")`, value: "default" },
        { name: "Yes — pick a folder inside target", value: "browse" },
      ],
    },
  ]);
  if (mapToRes === CANCELLED) return null;
  let mapTo = existing ? existing.mapTo || null : null;
  if (mapToRes.value === "browse") {
    mapTo = await browseMapToFolder(config);
  } else if (mapToRes.value === "default") {
    mapTo = null;
  }

  return {
    path: folder,
    pattern: patternRes.value.trim() || "*",
    recursive: recursiveRes.value,
    deleteAfterImport: deleteRes.value,
    mapTo,
  };
}

/**
 * Interactive wizard for the handful of "direct switches" a user is most
 * likely to want to flip without hand-editing config.json: whether imports
 * auto-translate, the default whisper model, the target folder, and resetting
 * remembered volume choices. Loops until the user chooses Done (or Esc).
 */
export async function runSettings(): Promise<void> {
  let config = await loadConfig();

  while (true) {
    const knownCount = Object.keys(config.knownMounts || {}).length;
    const ledger = await ledgerSummary(config.target);
    const deps = await checkDependencies(["ffmpeg", "whisper"]);
    const missingDeps = deps.filter((d) => !d.found).map((d) => d.label);
    // Entirely optional, so this only ever adds a menu entry, never a
    // blocker - a machine that never ran `vno setup --llama` sees nothing
    // about it here beyond the "Check ffmpeg + whisper" entry's own scope,
    // which deliberately doesn't cover llama.cpp (see cli/setup.ts:REQUIRED).
    const llamaModels = (await listLlamaModels()).filter((m) => m.valid);

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
          { name: `Cross-language detection  ${chalk.dim("[")}${crossLanguageLabel(config)}${chalk.dim("]")}`, value: "crossLanguage" },
          { name: `Transcription quality   ${chalk.dim("[")}${decodeLabel(config)}${chalk.dim("]")}`, value: "decode" },
          { name: `GPU acceleration        ${chalk.dim("[")}${gpuLabel(config)}${chalk.dim("]")}`, value: "gpu" },
          ...(llamaModels.length > 0
            ? [{ name: `Summarization model     ${chalk.dim(`[${config.summaryModel || "none"}]`)}`, value: "summaryModel" }]
            : []),
          { name: `Target (import) folder  ${chalk.dim(`[${config.target}]`)}`, value: "target" },
          { name: `Open folder + player when done  ${chalk.dim("[")}${onOffLabel(config.openWhenDone !== false)}${chalk.dim("]")}`, value: "openWhenDone" },
          { name: `Viewer theme            ${chalk.dim(`[${themeOf(config)}]`)}`, value: "theme" },
          { name: `Viewer port             ${chalk.dim(`[${config.port ?? DEFAULT_PORT}]`)}`, value: "port" },
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
    } else if (answer.action === "summaryModel") {
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Default summarization model (used by the deck's Summarize button and `vno summarize`)",
          default: config.summaryModel || llamaModels[0]?.filename,
          choices: llamaModels.map((m) => ({ name: m.filename, value: m.filename })),
          loop: false,
        },
      ]);
      if (res !== CANCELLED) {
        config.summaryModel = res.value;
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
    } else if (answer.action === "port") {
      const res = await prompt([
        {
          type: "input",
          name: "value",
          message: `Port for the browser viewer (${DEFAULT_PORT} is the default; 0 picks a free one each run)`,
          default: String(config.port ?? DEFAULT_PORT),
          // Ports above 1023 only: the low range needs elevation on macOS and
          // Linux, and vno has no business asking for that to show a player.
          validate: (input: string) => {
            const n = Number(input.trim());
            if (!Number.isInteger(n) || n < 0 || n > 65535) return "Enter a port between 0 and 65535.";
            if (n > 0 && n < 1024) return "Ports below 1024 need elevated privileges — pick a higher one.";
            return true;
          },
        },
      ]);
      if (res !== CANCELLED) {
        config.port = Number(String(res.value).trim());
        await saveConfig(config);
        console.log(chalk.dim(`Viewer port set to ${config.port}. Restart \`vno v\` for it to take effect.`));
        if (process.platform === "win32") {
          console.log(
            chalk.dim("If a port keeps reporting as in use with nothing listening, check Windows'\nreserved ranges: netsh interface ipv4 show excludedportrange protocol=tcp")
          );
        }
      }
    } else if (answer.action === "theme") {
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Colour theme for the browser viewer",
          default: themeOf(config),
          choices: THEMES.map((t) => ({ name: `${t.label}  ${chalk.dim(t.blurb)}`, value: t.id })),
          loop: false,
        },
      ]);
      if (res !== CANCELLED) {
        config.theme = res.value;
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
    } else if (answer.action === "crossLanguage") {
      await manageCrossLanguage(config);
    } else if (answer.action === "decode") {
      await manageDecode(config);
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
