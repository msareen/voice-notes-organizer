import os from "node:os";
import path from "node:path";
import chalk from "chalk";
import fs from "fs-extra";
import {
  DEPENDENCIES,
  buildInstallPlan,
  checkDependency,
  checkDependencies,
  manualHelp,
  refreshPath,
  runPlan,
  which,
} from "../lib/setup.js";
import {
  installWhisperCpp,
  registerExternalBinary,
  resolveBinary,
  resolveInstallRoot,
  readManifest,
  resolveModel,
  downloadModel,
  listModels,
  findStalePythonCache,
  DEFAULT_MODELS,
} from "../lib/whispercpp.js";
import { accelState } from "../lib/whisper.js";
import { loadConfig, saveConfig } from "../lib/config.js";
import { prompt, CANCELLED } from "./prompt.js";

/** The two things vno can't transcribe without, in install order. */
const REQUIRED = ["ffmpeg", "whisper"];

/**
 * The startup guard, called by every command that shells out to ffmpeg or
 * whisper.cpp. Returns true when everything asked for is on PATH/vendored -
 * silently, so a healthy machine never notices it - and otherwise walks the
 * user through installing what's missing.
 *
 * `reason` is what the check is for ("transcribe"), used in the explanation.
 * `mode` picks where a fresh whisper.cpp install lands - see
 * `lib/whispercpp.js:resolveInstallRoot`. Left `null` (the default), the user
 * is asked - local, global, or "I already have it" - rather than silently
 * assuming local; only `vno setup --local`/`--global` forces one without asking.
 */
export async function ensureDependencies(names = REQUIRED, { reason = null, mode = null } = {}) {
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

  // Install in the declared order: ffmpeg is the one whisper.cpp itself needs
  // at runtime, so a partial success still leaves the more useful half working.
  let allInstalled = true;
  for (const dep of missing) {
    if (!(await installDependency(dep.name, { mode }))) allInstalled = false;
  }
  return allInstalled;
}

/**
 * Offers to install one dependency and runs it. Returns whether it ended up
 * usable - a declined offer, a failed install and an install that needs a new
 * shell all mean the caller can't use it right now.
 */
async function installDependency(name, { mode = null } = {}) {
  if (name === "whisper") return installWhisper(mode);

  const label = DEPENDENCIES[name].label;
  const plan = await buildInstallPlan(name);

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
    return false;
  }

  console.log(chalk.green(`\n${label} is ready.`));
  return true;
}

/**
 * whisper.cpp's install isn't a package-manager one-liner - it's a per-
 * platform binary/source acquisition (see `lib/whispercpp.js`), and unlike
 * ffmpeg there's a real choice of *where* it goes, so it gets its own flow
 * rather than going through `buildInstallPlan`/`runPlan`.
 *
 * `mode` is `null` unless the caller forced one (`vno setup --local`/
 * `--global`) - left unset, the user picks: install locally, install
 * globally, or point at a whisper.cpp they already have.
 */
async function installWhisper(mode) {
  if (!process.stdin.isTTY) {
    console.log(chalk.dim("\nwhisper.cpp isn't installed, and there's no terminal to ask how."));
    printManual("whisper");
    return false;
  }

  const choice = mode || (await promptWhisperChoice());
  if (choice === "skip") {
    console.log(chalk.dim("Skipped - whisper.cpp is still missing."));
    return false;
  }
  if (choice === "existing") {
    return registerExistingWhisper(mode || "local");
  }

  const resolvedMode = choice; // "local" | "global"
  const root = resolveInstallRoot(resolvedMode);
  console.log();
  console.log(chalk.bold(`Installing whisper.cpp (${resolvedMode}, into ${root})`));
  console.log(chalk.dim(`  ${platformInstallDescription()}`));
  console.log(chalk.dim("\nInstalling whisper.cpp..."));
  try {
    const manifest = await installWhisperCpp({
      mode: resolvedMode,
      onLog: (line) => console.log(chalk.dim(`  ${line}`)),
      onStep: (step) => console.log(chalk.dim(`$ ${step.command} ${step.args.join(" ")}`)),
      onProgress: progressPrinter(),
    });
    console.log(
      chalk.green(`\nwhisper.cpp is ready: ${manifest.binary.path} (${manifest.accel.backend}).`)
    );
    return true;
  } catch (err) {
    console.log(chalk.red(`\nwhisper.cpp install failed: ${err.message}`));
    printManual("whisper");
    return false;
  }
}

/** Asks where whisper.cpp should come from - install fresh, or point at one already on the machine. */
async function promptWhisperChoice() {
  const answer = await prompt([
    {
      type: "list",
      name: "choice",
      message: "whisper.cpp isn't installed. What would you like to do?",
      choices: [
        { name: `Install it locally, beside this vno install (${resolveInstallRoot("local")})`, value: "local" },
        { name: `Install it globally (${resolveInstallRoot("global")})`, value: "global" },
        { name: "I already have it installed — let me give the path", value: "existing" },
        { name: "Skip for now", value: "skip" },
      ],
      default: "local",
    },
  ]);
  return answer === CANCELLED ? "skip" : answer.choice;
}

/** Points vno at a whisper.cpp binary the user already has, instead of installing one. */
async function registerExistingWhisper(mode) {
  const answer = await prompt([
    {
      type: "input",
      name: "path",
      message: "Path to your whisper.cpp binary (or the folder containing it)",
    },
  ]);
  if (answer === CANCELLED || !answer.path?.trim()) {
    console.log(chalk.dim("Skipped - whisper.cpp is still missing."));
    return false;
  }

  const accelAnswer = await prompt([
    {
      type: "list",
      name: "backend",
      message: "Does this build have GPU acceleration (CUDA/Metal/Vulkan)?",
      choices: [
        { name: "Yes, or I'm not sure — try it, fall back to the CPU automatically if it fails", value: "unknown" },
        { name: "No, this is a CPU-only build", value: "cpu" },
      ],
      default: "unknown",
    },
  ]);
  const backend = accelAnswer === CANCELLED ? "unknown" : accelAnswer.backend;

  try {
    const manifest = await registerExternalBinary(answer.path.trim(), { mode, backend });
    console.log(chalk.green(`\nUsing your existing whisper.cpp: ${manifest.binary.path}.`));
    return true;
  } catch (err) {
    console.log(chalk.red(`\nCouldn't use that: ${err.message}`));
    return false;
  }
}

function platformInstallDescription() {
  const platform = os.platform();
  if (platform === "darwin") return "Installs via Homebrew (brew install whisper-cpp), Metal-accelerated on Apple silicon.";
  if (platform === "win32")
    return "Downloads a prebuilt release zip - CUDA-matched to this machine's driver if it has an NVIDIA GPU, BLAS-accelerated CPU otherwise.";
  return "Downloads a prebuilt CPU binary, or builds from source with CUDA support if this machine has an NVIDIA GPU (needs cmake, git and a C++ compiler).";
}

/** A `%` progress line for a download, updated in place. */
function progressPrinter() {
  let lastPct = -1;
  return ({ received, total }) => {
    if (!total) return;
    const pct = Math.min(100, Math.floor((received / total) * 100));
    if (pct === lastPct) return;
    lastPct = pct;
    process.stdout.write(`\r  ${String(pct).padStart(3)}%  (${(received / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB)`);
    if (pct === 100) process.stdout.write("\n");
  };
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
 * `vno setup` - the same check the other commands run, but on purpose and
 * with the results printed either way, so "is my machine set up?" has an
 * answer that doesn't involve starting a transcription to find out.
 *
 * `mode` forces a local (beside this install of vno) or global
 * (`~/.whisper-cpp` / `%LOCALAPPDATA%\whisper-cpp`) whisper.cpp install
 * without asking (`vno setup --local`/`--global`). Left `null` (the
 * default), and whisper.cpp isn't installed yet, the user is asked - local,
 * global, or "I already have it, here's the path".
 * `model`, given alone, fetches just that one model instead of the defaults.
 * `listModelsOnly` prints the model inventory without touching setup at all -
 * the first thing anyone debugging a model-not-found error will want.
 */
export async function runSetup({ check = false, mode = null, model = null, listModelsOnly = false } = {}) {
  console.log(chalk.bold(`vno setup — ${os.platform()} ${os.arch()}\n`));

  if (listModelsOnly) {
    await printModelInventory();
    return;
  }

  // PATH here can be stale if something was installed after this shell opened.
  await refreshPath();
  await report();

  const config = await loadConfig();
  reportAccel(config);

  if (check) {
    // Report-only: never installs or downloads anything.
    return;
  }

  const statuses = await checkDependencies(REQUIRED);
  let ok = statuses.every((s) => s.found);
  if (!ok) {
    ok = await ensureDependencies(REQUIRED, { mode });
    console.log();
    await report();
  }

  console.log(
    ok
      ? chalk.green("\nSetup complete.")
      : chalk.yellow("\nSetup incomplete — vno will ask again next time it needs one of these.")
  );

  if (!ok) return;

  // `mode` here is only what a flag forced, if anything - when the user was
  // asked interactively (local / global / "I already have it"), the actual
  // destination is whichever root the binary (or its install.json entry)
  // ended up in, which might not match. Ask the binary itself rather than
  // trust the flag.
  const binary = await resolveBinary({});
  const activeMode = binary?.root ? modeForRoot(binary.root) : mode || "local";

  await checkAccel(config, activeMode);
  await ensureModels(activeMode, model);
  await reportStalePythonCache();
}

/** Which of the two known install roots a resolved path belongs to. */
function modeForRoot(root) {
  return root === resolveInstallRoot("global") ? "global" : "local";
}

/** Per-command status lines: exactly which binaries were found, and where. */
async function report() {
  for (const name of REQUIRED) {
    if (name === "whisper") {
      const status = await checkDependency("whisper");
      console.log(
        status.found
          ? `  ${chalk.green("✓")} ${"whisper.cpp".padEnd(12)} ${chalk.dim(status.path)}`
          : `  ${chalk.red("✗")} ${"whisper.cpp".padEnd(12)} ${chalk.dim("not installed on PATH")}`
      );
      continue;
    }
    const meta = DEPENDENCIES[name];
    for (const command of meta.commands) {
      const found = await which(command);
      console.log(
        found
          ? `  ${chalk.green("✓")} ${command.padEnd(12)} ${chalk.dim(found)}`
          : `  ${chalk.red("✗")} ${command.padEnd(12)} ${chalk.dim("not found on PATH")}`
      );
    }
  }
}

/** The installed accelerator backend as a status line, in the same shape as the binaries above. */
function reportAccel(config) {
  const accel = accelState(config);
  if (accel.backend === null) {
    console.log(`  ${chalk.dim("?")} ${"accel".padEnd(12)} ${chalk.dim("not installed yet — run `vno setup`")}`);
    return;
  }
  if (accel.backend === "cpu") {
    console.log(`  ${chalk.dim("-")} ${"accel".padEnd(12)} ${chalk.dim("CPU only — no accelerator build available")}`);
    return;
  }
  const state = accel.use === false ? chalk.dim("off by choice") : chalk.green("in use");
  console.log(`  ${chalk.green("✓")} ${"accel".padEnd(12)} ${chalk.dim(accel.name || accel.backend)} ${state}`);
}

/**
 * Reads the accelerator backend whisper.cpp was installed with, straight out
 * of install.json, and caches it in config for `resolveAccel` to read at
 * transcription time. Unlike the old torch probe this costs nothing - the
 * backend can't change without a fresh `vno setup` - so it always runs here,
 * not behind a separate slow-path gate.
 */
async function checkAccel(config, mode) {
  const manifest = await readManifest(resolveInstallRoot(mode));
  if (!manifest?.accel) return;

  const previous = accelState(config);
  config.accel = {
    ...previous,
    backend: manifest.accel.backend,
    name: manifest.accel.name,
    resolvedAt: new Date().toISOString(),
  };

  if (manifest.accel.backend === "cpu") {
    console.log(chalk.dim("\nNo accelerator build available for this machine — transcription runs on the CPU."));
    await saveConfig(config);
    return;
  }

  console.log(chalk.green(`\nFound ${manifest.accel.name || manifest.accel.backend} acceleration (${manifest.accel.backend}).`));

  // Asked once and remembered, like auto-translate: `vno setting` flips it.
  if (previous.use !== null) {
    console.log(
      previous.use
        ? chalk.dim("Acceleration is on. Change it with `vno setting`.")
        : chalk.dim("Acceleration is off by choice. Turn it on with `vno setting`.")
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
      message: "Use the accelerator for transcription? It's several times faster than the CPU.",
      choices: [
        { name: "Yes, use it", value: true },
        { name: "No, stay on the CPU", value: false },
      ],
      default: true,
    },
  ]);
  if (answer !== CANCELLED) {
    config.accel.use = answer.use;
    console.log(
      chalk.dim(
        answer.use
          ? "Remembered: transcription uses the accelerator. Change it with `vno setting`."
          : "Remembered: transcription stays on the CPU. Change it with `vno setting`."
      )
    );
  }
  await saveConfig(config);
}

/**
 * Ensures the default model set (or just `only`, if given) is present,
 * downloading whatever `resolveModel` can't already find. Prints a before
 * inventory first, since a machine with everything already should see that
 * immediately rather than after a silent no-op.
 */
async function ensureModels(mode, only) {
  const wanted = only ? [only] : DEFAULT_MODELS;
  const before = await listModels();

  console.log();
  console.log(chalk.bold("Models:"));
  if (before.length === 0) {
    console.log(chalk.dim("  none found yet"));
  } else {
    for (const entry of before) {
      console.log(chalk.dim(`  ${entry.stem.padEnd(20)} ${(entry.size / 1e6).toFixed(0)} MB  ${entry.path}`));
    }
  }

  for (const name of wanted) {
    const existing = await resolveModel(name);
    if (existing) continue;

    console.log(chalk.dim(`\nDownloading "${name}"...`));
    try {
      await downloadModel(name, {
        mode,
        onLog: (line) => console.log(chalk.dim(`  ${line}`)),
        onProgress: progressPrinter(),
      });
      console.log(chalk.green(`  ${name} ready.`));
    } catch (err) {
      console.log(chalk.red(`  Couldn't download "${name}": ${err.message}`));
    }
  }
}

/** `vno setup --list-models` - the inventory alone, no install/download work. */
async function printModelInventory() {
  const entries = await listModels();
  if (entries.length === 0) {
    console.log(chalk.dim("No models found. Run `vno setup` to download the defaults, or `vno setup --model <name>` for one specifically."));
    return;
  }
  for (const entry of entries) {
    const size = entry.size ? `${(entry.size / 1e6).toFixed(0)} MB` : "?";
    console.log(
      entry.valid
        ? `  ${chalk.green("✓")} ${entry.stem.padEnd(24)} ${chalk.dim(`${size}  ${entry.path}`)}`
        : `  ${chalk.red("✗")} ${entry.stem.padEnd(24)} ${chalk.dim(`invalid (${entry.reason}) — ${entry.path}`)}`
    );
  }
}

/**
 * Reports (never deletes without asking) leftover PyTorch checkpoints from
 * the old Python whisper install - large-v3.pt alone is ~3GB, and a machine
 * that ran it for a while can be holding several times that.
 */
async function reportStalePythonCache() {
  const stale = await findStalePythonCache();
  if (stale.files.length === 0) return;

  console.log();
  console.log(chalk.yellow(`Found ${stale.files.length} leftover Python-whisper model file(s) in ${stale.dir}:`));
  for (const file of stale.files) {
    console.log(chalk.dim(`  ${path.basename(file.path)} — ${(file.size / 1e9).toFixed(2)} GB`));
  }
  console.log(chalk.dim(`  Total: ${(stale.totalBytes / 1e9).toFixed(2)} GB. whisper.cpp can't use these (different format).`));

  if (!process.stdin.isTTY) return;

  const answer = await prompt([
    {
      type: "list",
      name: "ok",
      message: "Delete these now to reclaim the space?",
      choices: [
        { name: "No, leave them", value: false },
        { name: "Yes, delete them", value: true },
      ],
      default: false,
    },
  ]);
  if (answer !== CANCELLED && answer.ok) {
    for (const file of stale.files) await fs.remove(file.path).catch(() => {});
    console.log(chalk.green("  Deleted."));
  }
}
