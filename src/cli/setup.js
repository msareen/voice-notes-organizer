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
import { probeGpu, gpuState } from "../lib/gpu.js";
import { loadConfig, saveConfig } from "../lib/config.js";
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

  const config = await loadConfig();
  reportGpu(config);

  if (check) {
    // Report-only: the probe is the slow part and it writes to config, so
    // --check reads back what setup last found rather than re-detecting.
    return;
  }

  const statuses = await checkDependencies(REQUIRED);
  if (statuses.every((s) => s.found)) {
    console.log(chalk.green("\nEverything vno needs is installed."));
    await checkGpu(config);
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
  if (ok) await checkGpu(config);
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

/** The cached probe as a status line, in the same shape as the binaries above. */
function reportGpu(config) {
  const gpu = gpuState(config);
  if (gpu.device === null) {
    console.log(`  ${chalk.dim("?")} ${"gpu".padEnd(8)} ${chalk.dim("not checked yet — run `vno setup`")}`);
    return;
  }
  if (gpu.device !== "cuda") {
    console.log(`  ${chalk.dim("-")} ${"gpu".padEnd(8)} ${chalk.dim("no CUDA GPU — transcribing on the CPU")}`);
    return;
  }
  const state = gpu.use === false ? chalk.dim("off by choice") : chalk.green("in use");
  console.log(`  ${chalk.green("✓")} ${"gpu".padEnd(8)} ${chalk.dim(gpu.name || "CUDA")} ${state}`);
}

/**
 * The one place the GPU probe runs. It boots Python and imports torch, which
 * costs seconds - far too slow for the startup check every command does - so
 * `vno setup` is where "what does this machine have?" gets asked, and the
 * answer is cached in config for transcribe and the viewer to read.
 *
 * Re-probing on every `vno setup` is deliberate: it's the way back after a
 * driver update, a torch reinstall, or a fallback that cleared the cache.
 */
async function checkGpu(config) {
  console.log(chalk.dim("\nChecking for GPU acceleration (this boots Python once)..."));
  const result = await probeGpu();
  const previous = gpuState(config);

  config.gpu = {
    ...previous,
    device: result.device,
    name: result.name,
    torch: result.torch,
    probedAt: new Date().toISOString(),
  };

  if (result.device !== "cuda") {
    console.log(chalk.dim(`  No CUDA GPU available — transcription runs on the CPU.`));
    if (result.error) console.log(chalk.dim(`  (${result.error})`));
    else console.log(chalk.dim("  torch reports no usable CUDA device, so whisper couldn't use one either."));
    await saveConfig(config);
    return;
  }

  console.log(chalk.green(`  Found ${result.name}${result.torch ? ` (torch ${result.torch})` : ""}.`));

  // Asked once and remembered, like auto-translate: `vno setting` flips it.
  if (previous.use !== null) {
    console.log(
      previous.use
        ? chalk.dim("  GPU acceleration is on. Change it with `vno setting`.")
        : chalk.dim("  GPU acceleration is off by choice. Turn it on with `vno setting`.")
    );
    await saveConfig(config);
    return;
  }

  if (!process.stdin.isTTY) {
    await saveConfig(config);
    return;
  }

  const answer = await prompt([
    {
      type: "list",
      name: "use",
      message: "Use the GPU for transcription? It's several times faster than the CPU.",
      choices: [
        { name: "Yes, use the GPU", value: true },
        { name: "No, stay on the CPU", value: false },
      ],
      default: true,
    },
  ]);
  if (answer !== CANCELLED) {
    config.gpu.use = answer.use;
    console.log(
      chalk.dim(
        answer.use
          ? "  Remembered: transcription uses the GPU. Change it with `vno setting`."
          : "  Remembered: transcription stays on the CPU. Change it with `vno setting`."
      )
    );
  }
  await saveConfig(config);
}
