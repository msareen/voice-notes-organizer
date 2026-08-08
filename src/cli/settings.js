import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig, saveConfig, configFilePath } from "../lib/config.js";
import { ledgerSummary, clearLedger } from "../lib/ledger.js";
import { checkDependencies } from "../lib/setup.js";
import { gpuState } from "../lib/gpu.js";
import { prompt, CANCELLED } from "./prompt.js";
import { runSetup } from "./setup.js";

const MODELS = ["turbo", "tiny", "base", "small", "medium", "large"];

const onOffLabel = (value) => (value ? chalk.green("on") : chalk.red("off"));

/**
 * GPU state as one bracketed phrase. The probe is `vno setup`'s job (it costs
 * seconds), so an unprobed machine is reported as such rather than as "off".
 */
function gpuLabel(config) {
  const gpu = gpuState(config);
  if (gpu.device === null) return chalk.yellow("not checked");
  if (gpu.device !== "cuda") return chalk.dim("no GPU on this machine");
  return gpu.use === false ? chalk.red("off") : chalk.green(`on — ${gpu.name || "CUDA"}`);
}

/** Human-readable state of the three-way auto-translate switch. */
function autoTranslateLabel(value) {
  if (value === true) return chalk.green("on");
  if (value === false) return chalk.red("off");
  return chalk.yellow("ask each time");
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
          { name: `GPU acceleration        ${chalk.dim("[")}${gpuLabel(config)}${chalk.dim("]")}`, value: "gpu" },
          { name: `Target (import) folder  ${chalk.dim(`[${config.target}]`)}`, value: "target" },
          { name: `Open folder + player when done  ${chalk.dim("[")}${onOffLabel(config.openWhenDone !== false)}${chalk.dim("]")}`, value: "openWhenDone" },
          { name: `Remember deleted recordings  ${chalk.dim("[")}${onOffLabel(config.rememberDeletions !== false)}${chalk.dim("]")}`, value: "rememberDeletions" },
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
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: "Default whisper model",
          default: config.defaultModel || "turbo",
          choices: MODELS,
          loop: false,
        },
      ]);
      if (res !== CANCELLED) {
        config.defaultModel = res.value;
        await saveConfig(config);
      }
    } else if (answer.action === "gpu") {
      const gpu = gpuState(config);
      if (gpu.device !== "cuda") {
        console.log(
          chalk.dim(
            gpu.device === null
              ? "Not checked yet — use “Check ffmpeg + whisper” below, which also probes for a GPU."
              : "No CUDA GPU was found on this machine, so transcription runs on the CPU."
          )
        );
        continue;
      }
      const res = await prompt([
        {
          type: "list",
          name: "value",
          message: `Use ${gpu.name || "the GPU"} for transcription?`,
          default: gpu.use !== false,
          choices: [
            { name: "On — transcribe on the GPU (much faster)", value: true },
            { name: "Off — transcribe on the CPU", value: false },
          ],
        },
      ]);
      if (res !== CANCELLED) {
        config.gpu = { ...gpu, use: res.value };
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
      // runSetup writes the GPU probe straight to disk, so the copy held here
      // is stale - and the next save from this loop would undo it.
      config = await loadConfig();
      console.log();
    } else if (answer.action === "path") {
      console.log(configFilePath());
    }
  }
}
