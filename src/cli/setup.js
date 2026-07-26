import os from "node:os";
import chalk from "chalk";
import {
  DEPENDENCIES,
  buildInstallPlan,
  buildPipxPlan,
  checkDependencies,
  isExternallyManagedError,
  manualHelp,
  refreshPath,
  runPlan,
  which,
} from "../lib/setup.js";
import { prompt, CANCELLED } from "./prompt.js";

/** The two things vno can't transcribe without, in install order. */
const REQUIRED = ["ffmpeg", "whisper"];

/**
 * The startup guard, called by every command that shells out to ffmpeg or
 * whisper. Returns true when everything asked for is on PATH - silently, so a
 * healthy machine never notices it - and otherwise walks the user through
 * installing what's missing.
 *
 * `reason` is what the check is for ("transcribe"), used in the explanation.
 */
export async function ensureDependencies(names = REQUIRED, { reason = null } = {}) {
  let statuses = await checkDependencies(names);
  if (statuses.every((s) => s.found)) return true;

  // Something may have been installed since this shell started, in which case
  // PATH here is stale and everything is fine after a re-read.
  if (await refreshPath()) {
    statuses = await checkDependencies(names);
    if (statuses.every((s) => s.found)) return true;
  }

  const missing = statuses.filter((s) => !s.found);
  console.log();
  console.log(
    chalk.yellow(
      `${missing.map((m) => m.label).join(" and ")} ${missing.length > 1 ? "aren't" : "isn't"} on your PATH` +
        `${reason ? `, and ${reason} needs ${missing.length > 1 ? "them" : "it"}` : ""}.`
    )
  );
  for (const dep of missing) {
    console.log(chalk.dim(`  ${dep.label} - ${dep.usedFor}`));
  }

  // Install in the declared order: ffmpeg is the one whisper itself needs at
  // runtime, so a partial success still leaves the more useful half working.
  let allInstalled = true;
  for (const dep of missing) {
    if (!(await installDependency(dep.name))) allInstalled = false;
  }
  return allInstalled;
}

/**
 * Offers to install one dependency and runs it. Returns whether it ended up on
 * PATH - a declined offer, a failed install and an install that needs a new
 * shell all mean the caller can't use it right now.
 */
async function installDependency(name) {
  const label = DEPENDENCIES[name].label;
  let plan = await buildInstallPlan(name);

  // whisper installs through pip, so a machine with no Python needs that
  // first. Only worth offering once - if Python doesn't arrive, neither does
  // whisper, and there's nothing further to try.
  if (!plan && name === "whisper") {
    console.log(chalk.dim("\nwhisper installs through pip, and no Python was found."));
    if (!(await installDependency("python"))) {
      console.log(chalk.dim("\nOnce Python is there, whisper is one command away:"));
      printManual("whisper");
      return false;
    }
    plan = await buildInstallPlan("whisper");
  }

  if (!plan) {
    console.log(chalk.yellow(`\nvno doesn't know how to install ${label} on this machine automatically.`));
    printManual(name);
    return false;
  }

  console.log();
  console.log(chalk.bold(`Install ${label} with ${plan.via}?`));
  for (const step of plan.steps) console.log(chalk.dim(`  ${step.command} ${step.args.join(" ")}`));
  if (plan.note) console.log(chalk.dim(`  note: ${plan.note}`));

  if (!process.stdin.isTTY) {
    // A piped/CI run has nobody to answer the prompt; printing the commands is
    // more use than hanging on a question that can't be answered.
    console.log(chalk.dim("\nNot an interactive terminal - run the command above yourself."));
    return false;
  }

  const answer = await prompt([
    {
      type: "list",
      name: "choice",
      message: `Run this now to install ${label}?`,
      choices: [
        { name: "Yes, install it", value: "install" },
        { name: "No, I'll do it myself", value: "manual" },
        { name: "Skip for now", value: "skip" },
      ],
      default: "install",
    },
  ]);

  if (answer === CANCELLED || answer.choice === "skip") {
    console.log(chalk.dim(`Skipped - ${label} is still missing.`));
    return false;
  }
  if (answer.choice === "manual") {
    printManual(name);
    return false;
  }

  const result = await runInstall(plan, label);

  // A pip install can be refused outright by a system-managed Python. pipx
  // installs into its own environment, which those Pythons do allow.
  if (!result.ok && name === "whisper" && isExternallyManagedError(result.output)) {
    console.log(
      chalk.yellow("\nYour Python is externally managed, so it refuses plain pip installs into it.")
    );
    const pipx = await buildPipxPlan();
    if (pipx) {
      const retry = await prompt([
        {
          type: "list",
          name: "ok",
          message: "Install whisper with pipx instead?",
          choices: [
            { name: "Yes, use pipx", value: true },
            { name: "No", value: false },
          ],
          default: true,
        },
      ]);
      if (retry !== CANCELLED && retry.ok) {
        Object.assign(result, await runInstall(pipx, label));
      }
    } else {
      console.log(chalk.dim("Install pipx (e.g. `sudo apt-get install pipx`), then: pipx install openai-whisper"));
    }
  }

  if (!result.ok) {
    console.log(chalk.red(`\n${label} install failed.`));
    printManual(name);
    return false;
  }

  await refreshPath();
  const [status] = await checkDependencies([name]);
  if (!status.found) {
    console.log(
      chalk.yellow(
        `\n${label} installed, but it isn't on this shell's PATH yet. Open a new terminal and run vno again.`
      )
    );
    if (name === "whisper") {
      console.log(chalk.dim("If it's still missing there, add your Python scripts directory to PATH."));
    }
    return false;
  }

  console.log(chalk.green(`\n${label} is ready.`));
  return true;
}

/** Runs a plan, echoing the installer's own output as it goes. */
async function runInstall(plan, label) {
  console.log(chalk.dim(`\nInstalling ${label} with ${plan.via}...`));
  return runPlan(plan, {
    onStep: (step) => console.log(chalk.dim(`$ ${step.command} ${step.args.join(" ")}`)),
    onOutput: (text) => process.stdout.write(chalk.dim(text)),
  });
}

function printManual(name) {
  console.log(chalk.dim("Install it with:"));
  for (const line of manualHelp(name)) console.log(chalk.dim(`  ${line}`));
}

/**
 * `vno setup` - the same check the other commands run, but on purpose and with
 * the results printed either way, so "is my machine set up?" has an answer that
 * doesn't involve starting a transcription to find out.
 */
export async function runSetup({ check = false } = {}) {
  console.log(chalk.bold(`vno setup — ${os.platform()} ${os.arch()}\n`));

  // PATH here can be stale if something was installed after this shell opened.
  await refreshPath();
  await report();

  if (check) return;

  const statuses = await checkDependencies(REQUIRED);
  if (statuses.every((s) => s.found)) {
    console.log(chalk.green("\nEverything vno needs is installed."));
    return;
  }

  const ok = await ensureDependencies(REQUIRED);
  console.log();
  await report();
  console.log(
    ok
      ? chalk.green("\nSetup complete.")
      : chalk.yellow("\nSetup incomplete — vno will ask again next time it needs one of these.")
  );
}

/** Per-command status lines: exactly which binaries were found, and where. */
async function report() {
  for (const name of REQUIRED) {
    const meta = DEPENDENCIES[name];
    for (const command of meta.commands) {
      const found = await which(command);
      console.log(
        found
          ? `  ${chalk.green("✓")} ${command.padEnd(8)} ${chalk.dim(found)}`
          : `  ${chalk.red("✗")} ${command.padEnd(8)} ${chalk.dim("not found on PATH")}`
      );
    }
  }
}
