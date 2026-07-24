import path from "node:path";
import chalk from "chalk";
import inquirer from "inquirer";
import { loadConfig, saveConfig, configFilePath } from "./config.js";
import { prompt, CANCELLED } from "./prompt.js";

const MODELS = ["turbo", "tiny", "base", "small", "medium", "large"];

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
  const config = await loadConfig();

  while (true) {
    const knownCount = Object.keys(config.knownMounts || {}).length;

    const answer = await prompt([
      {
        type: "list",
        name: "action",
        message: "vno settings (Esc to exit)",
        pageSize: 15,
        choices: [
          { name: `Auto-translate imports  ${chalk.dim("[" )}${autoTranslateLabel(config.autoTranslate)}${chalk.dim("]")}`, value: "autoTranslate" },
          { name: `Default whisper model   ${chalk.dim(`[${config.defaultModel || "turbo"}]`)}`, value: "model" },
          { name: `Target (import) folder  ${chalk.dim(`[${config.target}]`)}`, value: "target" },
          { name: `Forget remembered volume choices  ${chalk.dim(`[${knownCount} remembered]`)}`, value: "resetMounts" },
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
    } else if (answer.action === "path") {
      console.log(configFilePath());
    }
  }
}
