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
} from "../lib/setup.ts";
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
  isManagedModel,
  removeModel,
  DEFAULT_MODELS,
} from "../lib/whisper/whispercpp.ts";
import {
  installMacBinary as installLlamaMacBinary,
  installWindowsBinary as installLlamaWindowsBinary,
  manualInstallHint as llamaManualInstallHint,
  platformInstallDescription as platformLlamaInstallDescription,
  resolveBinary as resolveLlamaBinary,
  isLlamaInstalled,
  resolveInstallRoot as resolveLlamaInstallRoot,
  installPaths as llamaInstallPaths,
  bothInstallRoots as bothLlamaInstallRoots,
  resolveModel as resolveLlamaModel,
  downloadModel as downloadLlamaModel,
  llamaModelCatalog,
  listModels as listLlamaModels,
  isManagedModel as isManagedLlamaModel,
  removeModel as removeLlamaModel,
} from "../lib/llama/llamacpp.ts";
import { accelState } from "../lib/whisper/whisper.ts";
import { llamaAccelState } from "../lib/llama/llama.ts";
import { loadConfig, saveConfig } from "../lib/config.ts";
import { protocolStatus, registerProtocol } from "../lib/protocol.ts";
import { prompt, CANCELLED, Separator } from "./prompt.ts";
import type { DependencyName, InstallPlan, PlanResult } from "../lib/setup.ts";
import type { AccelRecord, InstallMode } from "../lib/whisper/whispercpp.ts";
import type { ProtocolStatus } from "../lib/protocol.ts";
import type { AccelBackend, Config } from "../types.ts";
import type { DownloadProgress } from "../lib/whisper/whispercpp.ts";
import type { ChecksumMismatch } from "../lib/engineInstall.ts";
import type { LlamaModelSource } from "../lib/llama/llamacpp.ts";

/** The two things vno can't transcribe without, in install order. */
const REQUIRED: DependencyName[] = ["ffmpeg", "whisper"];

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export interface EnsureOptions {
  reason?: string | null;
  /** Forced by `vno setup --local`/`--global`; null means ask. */
  mode?: InstallMode | null;
}

/**
 * The startup guard, called by every command that shells out to ffmpeg or
 * whisper.cpp. Returns true when everything asked for is on PATH/vendored -
 * silently, so a healthy machine never notices it - and otherwise walks the
 * user through installing what's missing.
 *
 * `reason` is what the check is for ("transcribe"), used in the explanation.
 * `mode` picks where a fresh whisper.cpp install lands - see
 * `lib/whisper/whispercpp.ts:resolveInstallRoot`. Left `null` (the default), the user
 * is asked - local, global, or "I already have it" - rather than silently
 * assuming local; only `vno setup --local`/`--global` forces one without asking.
 */
export async function ensureDependencies(
  names: DependencyName[] = REQUIRED,
  { reason = null, mode = null }: EnsureOptions = {}
): Promise<boolean> {
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
async function installDependency(
  name: DependencyName,
  { mode = null }: { mode?: InstallMode | null } = {}
): Promise<boolean> {
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

/** What the "where should whisper.cpp come from?" prompt can answer. */
type WhisperChoice = InstallMode | "existing" | "skip";

/**
 * whisper.cpp's install isn't a package-manager one-liner - it's a per-
 * platform binary/source acquisition (see `lib/whisper/whispercpp.ts`), and unlike
 * ffmpeg there's a real choice of *where* it goes, so it gets its own flow
 * rather than going through `buildInstallPlan`/`runPlan`.
 *
 * `mode` is `null` unless the caller forced one (`vno setup --local`/
 * `--global`) - left unset, the user picks: install locally, install
 * globally, or point at a whisper.cpp they already have.
 */
async function installWhisper(mode: InstallMode | null): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(chalk.dim("\nwhisper.cpp isn't installed, and there's no terminal to ask how."));
    printManual("whisper");
    return false;
  }

  const choice: WhisperChoice = mode || (await promptWhisperChoice());
  if (choice === "skip") {
    console.log(chalk.dim("Skipped - whisper.cpp is still missing."));
    return false;
  }
  if (choice === "existing") {
    return registerExistingWhisper(mode || "local");
  }

  const resolvedMode: InstallMode = choice; // "local" | "global"
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
      chalk.green(`\nwhisper.cpp is ready: ${manifest.binary?.path} (${manifest.accel?.backend}).`)
    );
    return true;
  } catch (err) {
    console.log(chalk.red(`\nwhisper.cpp install failed: ${errorMessage(err)}`));
    printManual("whisper");
    return false;
  }
}

/** Asks where whisper.cpp should come from - install fresh, or point at one already on the machine. */
async function promptWhisperChoice(): Promise<WhisperChoice> {
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
  return answer === CANCELLED ? "skip" : (answer.choice as WhisperChoice);
}

/** Points vno at a whisper.cpp binary the user already has, instead of installing one. */
async function registerExistingWhisper(mode: InstallMode): Promise<boolean> {
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
  const backend: AccelRecord["backend"] =
    accelAnswer === CANCELLED ? "unknown" : (accelAnswer.backend as AccelBackend);

  try {
    const manifest = await registerExternalBinary(answer.path.trim(), { mode, backend });
    console.log(chalk.green(`\nUsing your existing whisper.cpp: ${manifest.binary?.path}.`));
    return true;
  } catch (err) {
    console.log(chalk.red(`\nCouldn't use that: ${errorMessage(err)}`));
    return false;
  }
}

/**
 * llama.cpp's install, entirely optional and only ever run when explicitly
 * asked for (`vno setup --llama`) - never part of `ensureDependencies`'s
 * REQUIRED list. Unlike whisper.cpp, there's no vno-managed install
 * location to choose: the OS package manager (`brew`/`winget`) installs it
 * system-wide, so this just confirms, runs that one command, and falls back
 * to asking for a path if the binary still isn't on PATH afterward (winget in
 * particular often only updates PATH for a new shell).
 */
async function installLlama(): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(chalk.dim("\nllama.cpp isn't installed, and there's no terminal to ask how."));
    printManual("llama");
    return false;
  }

  const platform = os.platform();
  if (platform !== "darwin" && platform !== "win32") {
    console.log(chalk.dim(`\n${llamaManualInstallHint()}`));
    return await promptLlamaPath();
  }

  console.log();
  console.log(chalk.bold("Install llama.cpp?"));
  console.log(chalk.dim(`  ${platformLlamaInstallDescription()}`));

  const answer = await prompt([
    {
      type: "list",
      name: "choice",
      message: "Run this now?",
      choices: [
        { name: "Yes, install it", value: "install" },
        { name: "No, I already have it — let me give the path", value: "existing" },
        { name: "Skip for now", value: "skip" },
      ],
      default: "install",
    },
  ]);
  if (answer === CANCELLED || answer.choice === "skip") {
    console.log(chalk.dim("Skipped - llama.cpp is still missing. Summarization stays unavailable."));
    return false;
  }
  if (answer.choice === "existing") {
    return promptLlamaPath();
  }

  console.log(chalk.dim("\nInstalling llama.cpp..."));
  try {
    const resolved = platform === "darwin" ? await installLlamaMacBinary() : await installLlamaWindowsBinary();
    if (!resolved) {
      console.log(
        chalk.yellow(
          "\nInstalled, but it isn't on this shell's PATH yet. Open a new terminal and run `vno setup --llama` again, " +
            "or give vno the path now."
        )
      );
      return await promptLlamaPath();
    }
    console.log(chalk.green(`\nllama.cpp is ready: ${resolved}.`));
    await setLlamaAccel(platform === "darwin" ? "metal" : "ask");
    await runLlamaModelStep();
    return true;
  } catch (err) {
    console.log(chalk.red(`\nllama.cpp install failed: ${errorMessage(err)}`));
    printManual("llama");
    return false;
  }
}

/** Saves a manually-given llama.cpp binary path into config, replacing PATH lookup. */
async function promptLlamaPath(): Promise<boolean> {
  const answer = await prompt([
    { type: "input", name: "path", message: "Path to your llama.cpp binary (llama-cli)" },
  ]);
  if (answer === CANCELLED || !answer.path?.trim()) {
    console.log(chalk.dim("Skipped - llama.cpp is still missing."));
    return false;
  }
  const given = answer.path.trim();
  if (!(await fs.pathExists(given))) {
    console.log(chalk.red(`\n${given} doesn't exist.`));
    return false;
  }

  const config = await loadConfig();
  config.llamaCliPath = given;
  await saveConfig(config);
  console.log(chalk.green(`\nUsing ${given} for summarization.`));
  await setLlamaAccel("ask");
  await runLlamaModelStep();
  return true;
}

/**
 * Sets `config.llamaAccel.backend` right after an install - `"metal"` is a
 * safe assumption for Homebrew's formula on Apple silicon (same as before),
 * but a winget/manually-given binary's GPU support isn't knowable without
 * asking, so `"ask"` reuses the same yes/no/unsure question the old
 * "register an existing binary" flow used.
 */
async function setLlamaAccel(mode: "metal" | "ask"): Promise<void> {
  const config = await loadConfig();
  if (mode === "metal") {
    config.llamaAccel = { ...llamaAccelState(config), backend: "metal", name: "Apple Metal", resolvedAt: new Date().toISOString() };
    await saveConfig(config);
    return;
  }
  if (!process.stdin.isTTY) return;
  const answer = await prompt([
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
  if (answer === CANCELLED) return;
  config.llamaAccel = {
    ...llamaAccelState(config),
    backend: answer.backend as AccelBackend,
    name: null,
    resolvedAt: new Date().toISOString(),
  };
  await saveConfig(config);
}

/**
 * Lets the user pick a summarization model right after installing the
 * binary - one of a curated set of small "edge" instruct models vno can
 * download itself, a `.gguf` they already have, or skip entirely. Always
 * offered, even when models are already installed - summarization isn't
 * limited to one model, and picking an already-installed one is a harmless
 * no-op (`downloadModel` resolves it and returns without re-fetching).
 * Reachable again any time via `vno setup --llama` even once the binary is
 * already installed, so skipping here isn't a dead end.
 */
async function runLlamaModelStep(): Promise<void> {
  const existing = (await listLlamaModels()).filter((m) => m.valid);
  if (existing.length > 0) {
    console.log(chalk.dim(`\nFound ${existing.length} model(s) already: ${existing.map((m) => m.filename).join(", ")}`));
  }

  if (!process.stdin.isTTY) {
    if (existing.length === 0) console.log(chalk.dim("\nNo terminal to ask which summarization model to use - skipping."));
    console.log(chalk.dim("Set the default in Settings or `vno setup --summary-model <filename>`."));
    return;
  }

  const catalog = llamaModelCatalog();
  const installedFilenames = new Set(existing.map((m) => m.filename.toLowerCase()));
  const pickAnswer = await prompt([
    {
      type: "list",
      name: "alias",
      message:
        existing.length > 0
          ? "Download another summarization model, or keep what you have:"
          : "Pick a summarization model to download - all small enough to run on CPU, faster with GPU acceleration:",
      choices: [
        ...groupedModelChoices(catalog, installedFilenames),
        new Separator(),
        {
          name: existing.length > 0 ? "Skip — keep what I have" : "Skip — I'll drop my own .gguf file(s) in myself",
          value: "skip",
        },
      ],
      default: existing.length > 0 ? "skip" : catalog[0]?.alias,
    },
  ]);
  const alias = pickAnswer === CANCELLED ? "skip" : (pickAnswer.alias as string);

  if (alias === "skip") {
    if (existing.length === 0) {
      const root = resolveLlamaInstallRoot("local");
      const { modelsDir } = llamaInstallPaths(root);
      await fs.ensureDir(modelsDir);
      console.log(chalk.green(`\nModels folder: ${modelsDir}`));
      console.log(
        chalk.dim(
          "Drop a .gguf file in there (or set VNO_LLAMA_MODEL_PATH), then run " +
            "`vno setup --summary-model <filename>` or pick it in Settings."
        )
      );
    } else {
      console.log(chalk.dim("Set the default in Settings or `vno setup --summary-model <filename>`."));
    }
    return;
  }

  const modeAnswer = await prompt([
    {
      type: "list",
      name: "mode",
      message: "Where should it be installed?",
      choices: [
        { name: `Locally, beside this vno install (${resolveLlamaInstallRoot("local")})`, value: "local" },
        { name: `Globally (${resolveLlamaInstallRoot("global")})`, value: "global" },
      ],
      default: "local",
    },
  ]);
  const mode: InstallMode = modeAnswer === CANCELLED ? "local" : (modeAnswer.mode as InstallMode);
  const root = resolveLlamaInstallRoot(mode);
  const { modelsDir } = llamaInstallPaths(root);
  await fs.ensureDir(modelsDir);

  const entry = catalog.find((m) => m.alias === alias)!;
  console.log(chalk.dim(`\nDownloading "${entry.label}" (${entry.group}) into ${modelsDir}...`));
  try {
    const dest = await downloadLlamaModel(alias, {
      mode,
      onLog: (line) => console.log(chalk.dim(`  ${line}`)),
      onProgress: progressPrinter(),
      onChecksumMismatch: confirmChecksumMismatch,
    });
    console.log(chalk.green(`  ${entry.label} ready: ${dest}`));
    console.log(chalk.dim("Set the default in Settings or `vno setup --summary-model <filename>`."));
  } catch (err) {
    console.log(chalk.red(`\nCouldn't download "${entry.label}": ${errorMessage(err)}`));
    console.log(chalk.dim(`Drop a .gguf file into ${modelsDir} yourself instead, then run this again.`));
  }
}

/**
 * `vno setup --summary-model <name>` - downloads it if `name` names one of
 * the curated catalog entries (alias or filename), otherwise just confirms a
 * manually-placed file is there.
 */
async function ensureLlamaModel(name: string): Promise<void> {
  const existing = await resolveLlamaModel(name);
  if (existing) {
    console.log(chalk.green(`\n"${name}" is available: ${existing}`));
    return;
  }

  const entry = llamaModelCatalog().find(
    (m) => m.alias === name || m.filename.toLowerCase() === name.toLowerCase()
  );
  if (entry) {
    console.log(chalk.dim(`\nDownloading "${entry.label}" (${entry.group})...`));
    try {
      const dest = await downloadLlamaModel(entry.alias, {
        onLog: (line) => console.log(chalk.dim(`  ${line}`)),
        onProgress: progressPrinter(),
        onChecksumMismatch: confirmChecksumMismatch,
      });
      console.log(chalk.green(`  ${entry.label} ready: ${dest}`));
    } catch (err) {
      console.log(chalk.red(`\nCouldn't download "${entry.label}": ${errorMessage(err)}`));
    }
    return;
  }

  console.log(chalk.red(`\n"${name}" isn't in your models folder, and isn't one of vno's curated models. Drop it into one of:`));
  for (const root of bothLlamaInstallRoots()) {
    console.log(chalk.dim(`  ${llamaInstallPaths(root).modelsDir}`));
  }
  console.log(chalk.dim("(or point VNO_LLAMA_MODEL_PATH at it), then run this again."));
}

function platformInstallDescription(): string {
  const platform = os.platform();
  if (platform === "darwin") return "Installs via Homebrew (brew install whisper-cpp), Metal-accelerated on Apple silicon.";
  if (platform === "win32")
    return "Downloads a prebuilt release zip - CUDA-matched to this machine's driver if it has an NVIDIA GPU, BLAS-accelerated CPU otherwise.";
  return "Downloads a prebuilt CPU binary, or builds from source with CUDA support if this machine has an NVIDIA GPU (needs cmake, git and a C++ compiler).";
}

/**
 * Renders the curated catalog as inquirer choices with a `Separator` heading
 * before each distinct `group` (the catalog is already grouped in tier
 * order, so this just watches for the value changing rather than sorting).
 */
function groupedModelChoices(
  catalog: LlamaModelSource[],
  installedFilenames: Set<string>
): (InstanceType<typeof Separator> | { name: string; value: string })[] {
  const choices: (InstanceType<typeof Separator> | { name: string; value: string })[] = [];
  let lastGroup: string | null = null;
  for (const m of catalog) {
    if (m.group !== lastGroup) {
      // A blank line ahead of every heading but the first, so the tiers read
      // as separate blocks rather than one dense list - Separator(" ") (not
      // "") renders truly blank instead of falling back to inquirer's
      // default dashed line.
      if (lastGroup !== null) choices.push(new Separator(" "));
      choices.push(new Separator(chalk.bold(`── ${m.group} ──`)));
      lastGroup = m.group;
    }
    choices.push({
      name:
        `${m.label} — ~${(m.approxBytes / 1e6).toFixed(0)} MB` +
        (installedFilenames.has(m.filename.toLowerCase()) ? chalk.dim("  (installed)") : ""),
      value: m.alias,
    });
  }
  return choices;
}

/**
 * Asked by `downloadModel` (whisper.cpp or llama.cpp) only when a *known*
 * checksum doesn't match what was downloaded - a model with no checksum on
 * file never reaches this. Defaults to keeping the file when there's no
 * terminal to ask: a mismatch is as likely to be a stale entry in vno's own
 * catalog as real corruption, and vno never deletes a multi-gigabyte download
 * without the user saying so.
 */
async function confirmChecksumMismatch({ filename, expected, actual }: ChecksumMismatch): Promise<boolean> {
  console.log(chalk.yellow(`\nChecksum mismatch for ${filename}:`));
  console.log(chalk.dim(`  expected ${expected}`));
  console.log(chalk.dim(`  got      ${actual}`));
  if (!process.stdin.isTTY) {
    console.log(chalk.dim("No terminal to confirm - keeping the file. Verify it yourself before trusting it."));
    return false;
  }
  const answer = await prompt([
    {
      type: "list",
      name: "ok",
      message: "Delete it and try again, or keep it anyway?",
      choices: [
        { name: "Keep it — this could just be a stale checksum on vno's end", value: false },
        { name: "Delete it and retry", value: true },
      ],
      default: false,
    },
  ]);
  return answer === CANCELLED ? false : Boolean(answer.ok);
}

/** A `%` progress line for a download, updated in place. */
function progressPrinter(): (progress: DownloadProgress) => void {
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
async function runInstall(plan: InstallPlan, label: string): Promise<PlanResult> {
  console.log(chalk.dim(`\nInstalling ${label} with ${plan.via}...`));
  return runPlan(plan, {
    onStep: (step) => console.log(chalk.dim(`$ ${step.command} ${step.args.join(" ")}`)),
    onOutput: (text) => process.stdout.write(chalk.dim(text)),
  });
}

function printManual(name: DependencyName): void {
  console.log(chalk.dim("Install it with:"));
  for (const line of manualHelp(name)) console.log(chalk.dim(`  ${line}`));
}

/** What `vno status` reports, and what `--json` prints verbatim. */
export interface VnoStatus {
  ready: boolean;
  blockers: string[];
  warnings: string[];
  required: {
    ffmpeg: boolean;
    whisper: boolean;
    models: string[];
  };
  optional: {
    accel: { backend: AccelBackend | null; name: string | null; enabled: boolean };
    protocol: { registered: boolean; upToDate: boolean } | null;
    /** Never affects `ready` - summarization is entirely optional. */
    summarization: { installed: boolean; models: string[] };
  };
}

/**
 * The machine-readable half of `vno status`: gathers everything without
 * printing, so both the human report and `--json` come from one source of
 * truth rather than drifting apart.
 *
 * The required/optional split is the point of the whole command. ffmpeg and a
 * whisper binary with at least one valid model are the difference between
 * "can transcribe" and "can't"; the `vno://` handler and GPU acceleration
 * change how pleasant it is, not whether it works. Reporting them at the same
 * severity would train people to ignore the output — the CPU-only laptop that
 * transcribes fine shouldn't look broken.
 */
export async function collectStatus(): Promise<VnoStatus> {
  await refreshPath();
  const config = await loadConfig();

  const deps = await checkDependencies(REQUIRED);
  const models = await listModels();
  const usable = models.filter((m) => m.valid);
  const accel = accelState(config);
  const protocol = os.platform() === "win32" ? await protocolStatus() : null;
  const llamaInstalled = await isLlamaInstalled(config);
  const llamaModels = llamaInstalled ? (await listLlamaModels()).filter((m) => m.valid).map((m) => m.filename) : [];

  const blockers: string[] = [];
  for (const dep of deps) {
    if (!dep.found) {
      blockers.push(dep.name === "whisper" ? "whisper.cpp is not installed" : `${dep.name} is not on PATH`);
    }
  }
  // A whisper binary with nothing to run is as blocking as no binary at all,
  // and it's the failure people actually hit - the binary installs quickly,
  // the multi-gigabyte model is what gets interrupted.
  if (!usable.length) {
    blockers.push(
      models.length
        ? "no valid whisper model — the ones on disk failed validation"
        : "no whisper model downloaded"
    );
  }

  const warnings: string[] = [];
  if (accel.backend === "cpu") warnings.push("no GPU acceleration — transcription runs on the CPU");
  else if (accel.backend && accel.use === false) warnings.push("GPU acceleration is available but turned off");
  if (protocol && !protocol.registered) warnings.push("vno:// is not registered — a browser can't launch vno directly");
  else if (protocol && !protocol.upToDate) warnings.push("vno:// points at a different vno install");

  return {
    ready: blockers.length === 0,
    blockers,
    warnings,
    required: {
      ffmpeg: deps.find((d) => d.name === "ffmpeg")?.found ?? false,
      whisper: deps.find((d) => d.name === "whisper")?.found ?? false,
      models: usable.map((m) => m.stem),
    },
    optional: {
      // `enabled` means "an accelerator is actually going to be used", so a
      // missing install (backend null) is false, not merely "not disabled".
      accel: {
        backend: accel.backend,
        name: accel.name ?? null,
        enabled: Boolean(accel.backend) && accel.backend !== "cpu" && accel.use !== false,
      },
      protocol: protocol ? { registered: protocol.registered, upToDate: protocol.upToDate } : null,
      summarization: { installed: llamaInstalled, models: llamaModels },
    },
  };
}

/**
 * `vno status` — is vno ready to work? Exits 0 when it is and 1 when it
 * isn't, so a script or another tool can gate on it without parsing text:
 *
 *   vno status --json | jq -e .ready   # or just: vno status >/dev/null
 */
export async function runStatus({ json = false }: { json?: boolean } = {}): Promise<boolean> {
  const status = await collectStatus();

  if (json) {
    console.log(JSON.stringify(status, null, 2));
    return status.ready;
  }

  // Grouped by engine, in the order a machine actually needs them: the
  // shared media tools, then everything whisper.cpp (binary, its models, the
  // accelerator that speeds them up), then everything llama.cpp (binary,
  // its models), then the unrelated vno:// browser-launch handler last.
  console.log(chalk.bold(`vno status — ${os.platform()} ${os.arch()}\n`));
  await report();
  await reportWhisperModels();
  const statusConfig = await loadConfig();
  reportAccel(statusConfig);
  await reportSummarization(statusConfig);
  const protocol = os.platform() === "win32" ? await protocolStatus() : null;
  if (protocol) reportProtocol(protocol);

  console.log("");
  if (status.ready) {
    console.log(`  ${chalk.green.bold("Ready.")} ${chalk.dim("vno can import and transcribe.")}`);
    for (const warning of status.warnings) console.log(`  ${chalk.dim("·")} ${chalk.dim(warning)}`);
  } else {
    console.log(`  ${chalk.red.bold("Not ready.")} ${chalk.dim("Run `vno setup` to fix:")}`);
    for (const blocker of status.blockers) console.log(`  ${chalk.red("·")} ${blocker}`);
  }
  console.log("");
  return status.ready;
}

export interface SetupOptions {
  check?: boolean;
  mode?: InstallMode | null;
  model?: string | null;
  listModelsOnly?: boolean;
  /**
   * `vno setup --remove-model [name]` - delete installed models to reclaim
   * space. `true` (the bare flag) opens a picker; a string targets one model.
   * Like `listModelsOnly`, it returns before any install/download work.
   */
  removeModel?: string | true | null;
  /** `vno setup --llama` - offer/install llama.cpp, then the model wizard. Never implied by plain `vno setup`. */
  llama?: boolean;
  /** `vno setup --summary-model <name>` - fetch one summarization model non-interactively, skipping the wizard. */
  summaryModel?: string | null;
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
export async function runSetup({
  check = false,
  mode = null,
  model = null,
  listModelsOnly = false,
  llama = false,
  summaryModel = null,
  removeModel: removeModelTarget = null,
}: SetupOptions = {}): Promise<void> {
  console.log(chalk.bold(`vno setup — ${os.platform()} ${os.arch()}\n`));

  if (listModelsOnly) {
    await printModelInventory();
    return;
  }

  // Ahead of the install path on purpose: a run that's here to free space
  // must never start downloading anything on its way out.
  if (removeModelTarget) {
    await runRemoveModels(removeModelTarget);
    return;
  }

  // PATH here can be stale if something was installed after this shell opened.
  await refreshPath();
  // Same engine-grouped order as `vno status`: whisper.cpp (report) and its
  // accelerator, then llama.cpp, then the unrelated vno:// handler last.
  await report();

  const config = await loadConfig();
  reportAccel(config);
  await reportSummarization(config);

  // Windows only for now - see lib/protocol.ts for why macOS/Linux aren't here yet.
  const protocol = os.platform() === "win32" ? await protocolStatus() : null;
  if (protocol) reportProtocol(protocol);

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

  if (ok) {
    // `mode` here is only what a flag forced, if anything - when the user was
    // asked interactively (local / global / "I already have it"), the actual
    // destination is whichever root the binary (or its vno-install.json entry)
    // ended up in, which might not match. Ask the binary itself rather than
    // trust the flag.
    const binary = await resolveBinary({});
    const activeMode = binary?.root ? modeForRoot(binary.root) : mode || "local";

    await checkAccel(config, activeMode);
    await ensureModels(activeMode, model);
    await reportStalePythonCache();
    if (protocol) await ensureProtocolHandler(protocol);
  }

  // Entirely independent of the ffmpeg/whisper flow above: llama.cpp is
  // optional, so nothing about it gates on `ok`. `--llama`/`--summary-model`
  // drive it directly; plain `vno setup` asks instead of silently skipping,
  // so the feature is actually discoverable rather than a hint someone has
  // to already know to act on.
  if (llama || summaryModel) {
    await runLlamaSetup({ llama, summaryModel });
  } else {
    await offerLlamaSetup();
  }
}

/**
 * Plain `vno setup` (no `--llama`/`--summary-model`) asks once, right here,
 * whether to set up summarization - rather than only ever hinting at it via
 * `reportSummarization()`'s status line, which someone could read past for
 * months without registering it as an offer. Skipped entirely once llama.cpp
 * is already installed (nothing new to ask), and in any non-interactive run.
 */
async function offerLlamaSetup(): Promise<void> {
  if (await isLlamaInstalled(await loadConfig())) return;
  if (!process.stdin.isTTY) return;

  const answer = await prompt([
    {
      type: "list",
      name: "choice",
      message: "Set up llama.cpp for optional transcript summarization?",
      choices: [
        { name: "Yes, set it up now", value: true },
        { name: "Not now", value: false },
      ],
      default: false,
    },
  ]);
  if (answer === CANCELLED || !answer.choice) return;

  await runLlamaSetup({ llama: true, summaryModel: null });
}

/**
 * Everything `vno setup` does for the optional summarization engine.
 * Silent (beyond the status line already printed) unless `--llama` or
 * `--summary-model` was actually passed - see the module doc comment on
 * `installLlama` for why this never joins `REQUIRED`.
 */
async function runLlamaSetup({
  llama,
  summaryModel,
}: {
  llama: boolean;
  summaryModel: string | null;
}): Promise<void> {
  if (!llama && !summaryModel) return;

  const installed = await isLlamaInstalled(await loadConfig());
  if (!installed) {
    if (!llama) {
      console.log(
        chalk.yellow(`\nllama.cpp isn't installed. Run \`vno setup --llama --summary-model ${summaryModel}\` to add it and this model together.`)
      );
      return;
    }
    const ok = await installLlama();
    if (!ok) return;
    // installLlama already ran the models-folder step on success; an
    // explicit --summary-model on top of that confirms that specific one
    // non-interactively rather than trusting the step alone.
    if (summaryModel) await ensureLlamaModel(summaryModel);
    return;
  }

  // Binary already installed: `--llama` re-run means "show me the models
  // folder again", while `--summary-model` alone is the quiet, scriptable
  // path - see SetupOptions's doc comments.
  if (llama) await runLlamaModelStep();
  if (summaryModel) await ensureLlamaModel(summaryModel);
}

/** Which of the two known install roots a resolved path belongs to. */
function modeForRoot(root: string): InstallMode {
  return root === resolveInstallRoot("global") ? "global" : "local";
}

// Every status line (report/reportAccel/reportSummarization/reportProtocol,
// plus the "whisper models" line in runStatus/runSetup below) pads its label
// to this width, so the value columns land on the same character position
// regardless of which lines a given machine ends up printing - the longest
// label, "whisper models", is 14 characters.
const STATUS_LABEL_WIDTH = 14;

/**
 * Prints a status line's label alone, then each model indented below it with
 * its full path - a bare model name doesn't say which of the local/global
 * install roots (or a `*_MODEL_PATH` override) vno is actually reading from.
 */
function printModelList(mark: string, label: string, entries: { name: string; path: string }[]): void {
  console.log(`  ${mark} ${label.padEnd(STATUS_LABEL_WIDTH)}`);
  for (const e of entries) {
    console.log(`      ${chalk.dim(e.name.padEnd(28))} ${chalk.dim(e.path)}`);
  }
}

/** Per-command status lines: exactly which binaries were found, and where. */
async function report(): Promise<void> {
  for (const name of REQUIRED) {
    if (name === "whisper") {
      const status = await checkDependency("whisper");
      console.log(
        status.found
          ? `  ${chalk.green("✓")} ${"whisper.cpp".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim(status.path)}`
          : `  ${chalk.red("✗")} ${"whisper.cpp".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("not installed on PATH")}`
      );
      continue;
    }
    const meta = DEPENDENCIES[name];
    for (const command of meta.commands) {
      const found = await which(command);
      console.log(
        found
          ? `  ${chalk.green("✓")} ${command.padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim(found)}`
          : `  ${chalk.red("✗")} ${command.padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("not found on PATH")}`
      );
    }
  }
}

/**
 * Status line(s) for the whisper.cpp models - same shape as
 * reportSummarization's llama models block, right after `report()`'s
 * "whisper.cpp" binary line so the whole whisper.cpp group reads together.
 */
async function reportWhisperModels(): Promise<void> {
  const entries = (await listModels()).filter((m) => m.valid);
  if (entries.length > 0) {
    printModelList(chalk.green("✓"), "whisper models", entries.map((m) => ({ name: m.stem, path: m.path })));
  } else {
    console.log(`  ${chalk.red("✗")} ${"whisper models".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("none downloaded — run `vno setup`")}`);
  }
}

/** The installed accelerator backend as a status line, in the same shape as the binaries above. */
function reportAccel(config: Config): void {
  const accel = accelState(config);
  if (accel.backend === null) {
    console.log(`  ${chalk.dim("?")} ${"accel".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("not installed yet — run `vno setup`")}`);
    return;
  }
  if (accel.backend === "cpu") {
    console.log(`  ${chalk.dim("-")} ${"accel".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("CPU only — no accelerator build available")}`);
    return;
  }
  const state = accel.use === false ? chalk.dim("off by choice") : chalk.green("in use");
  console.log(`  ${chalk.green("✓")} ${"accel".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim(accel.name || accel.backend)} ${state}`);
}

/**
 * Status line for the optional summarization engine, in the same
 * informational (never red) shape as the accel/protocol lines - a machine
 * that never opted in should never look broken over this.
 */
async function reportSummarization(config: Config): Promise<void> {
  const binary = await resolveLlamaBinary(config);
  if (!binary) {
    console.log(
      `  ${chalk.dim("?")} ${"llama.cpp".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("optional, for transcript summarization — run `vno setup --llama`")}`
    );
    return;
  }
  // Unlike whisper.cpp (a `resolveModel` alias/stem lookup), llama.cpp's
  // binary path is worth its own line - it's whichever PATH entry or manual
  // `config.llamaCliPath` override resolveBinary found, which isn't always
  // obvious the way a vendored whisper-cpp/bin/ path is.
  console.log(`  ${chalk.green("✓")} ${"llama.cpp".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim(binary)}`);
  const models = (await listLlamaModels()).filter((m) => m.valid);
  if (models.length === 0) {
    console.log(
      `  ${chalk.dim("?")} ${"llama models".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("llama.cpp installed, no model yet — run `vno setup --llama`")}`
    );
    return;
  }
  printModelList(chalk.green("✓"), "llama models", models.map((m) => ({ name: m.filename, path: m.path })));
}

/** Status line for the `vno://` browser-launch handler, in the same shape as the binary checks above. */
function reportProtocol(status: ProtocolStatus): void {
  if (!status.registered) {
    console.log(`  ${chalk.dim("?")} ${"vno://".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("not registered — lets a browser launch `vno v` directly")}`);
  } else if (!status.upToDate) {
    console.log(`  ${chalk.yellow("!")} ${"vno://".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("registered, but points at a different vno install")}`);
  } else {
    console.log(`  ${chalk.green("✓")} ${"vno://".padEnd(STATUS_LABEL_WIDTH)} ${chalk.dim("registered")}`);
  }
}

/**
 * Offers to register `vno://` as a Windows URL protocol (lib/protocol.ts) -
 * the same mechanism a `msteams://` or `zoommtg://` link uses - so a page
 * (the PWA's offline fallback, in particular) can trigger the browser's
 * native "Open vno?" dialog and have that launch `vno v`. Skipped when
 * there's no terminal to ask, and re-offered (as an update, not a fresh ask)
 * if it's registered but pointing at a stale install path.
 */
async function ensureProtocolHandler(status: ProtocolStatus): Promise<void> {
  if (status.registered && status.upToDate) return;
  if (!process.stdin.isTTY) return;

  const answer = await prompt([
    {
      type: "list",
      name: "choice",
      message: status.registered
        ? "vno:// is registered but points at a different vno install - update it?"
        : "Register vno:// so a browser can launch `vno v` directly (like a Teams/Zoom meeting link)?",
      choices: [
        { name: "Yes", value: true },
        { name: "No", value: false },
      ],
      default: true,
    },
  ]);
  if (answer === CANCELLED || !answer.choice) return;

  const result = await registerProtocol();
  console.log(result.ok ? chalk.green("  vno:// registered.") : chalk.red(`  Couldn't register vno://: ${result.output}`));
}

/**
 * Reads the accelerator backend whisper.cpp was installed with, straight out
 * of vno-install.json, and caches it in config for `resolveAccel` to read at
 * transcription time. Unlike the old torch probe this costs nothing - the
 * backend can't change without a fresh `vno setup` - so it always runs here,
 * not behind a separate slow-path gate.
 */
async function checkAccel(config: Config, mode: InstallMode): Promise<void> {
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
async function ensureModels(mode: InstallMode, only: string | null): Promise<void> {
  const wanted = only ? [only] : DEFAULT_MODELS;
  const before = await listModels();

  console.log();
  console.log(chalk.bold("Models:"));
  if (before.length === 0) {
    console.log(chalk.dim("  none found yet"));
  } else {
    for (const entry of before) {
      console.log(chalk.dim(`  ${entry.stem.padEnd(20)} ${((entry.size ?? 0) / 1e6).toFixed(0)} MB  ${entry.path}`));
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
        onChecksumMismatch: confirmChecksumMismatch,
      });
      console.log(chalk.green(`  ${name} ready.`));
    } catch (err) {
      console.log(chalk.red(`  Couldn't download "${name}": ${errorMessage(err)}`));
    }
  }
}

/** `vno setup --list-models` - the inventory alone, no install/download work. */
async function printModelInventory(): Promise<void> {
  const entries = await listModels();
  if (entries.length === 0) {
    console.log(chalk.dim("No models found. Run `vno setup` to download the defaults, or `vno setup --model <name>` for one specifically."));
  } else {
    for (const entry of entries) {
      const size = entry.size ? `${(entry.size / 1e6).toFixed(0)} MB` : "?";
      console.log(
        entry.valid
          ? `  ${chalk.green("✓")} ${entry.stem.padEnd(24)} ${chalk.dim(`${size}  ${entry.path}`)}`
          : `  ${chalk.red("✗")} ${entry.stem.padEnd(24)} ${chalk.dim(`invalid (${entry.reason}) — ${entry.path}`)}`
      );
    }
  }

  console.log();
  console.log(chalk.bold("Summarization models (optional):"));
  const llamaEntries = await listLlamaModels();
  if (llamaEntries.length === 0) {
    console.log(chalk.dim("  None found. Run `vno setup --llama` to install llama.cpp and pick one."));
    return;
  }
  for (const entry of llamaEntries) {
    const size = entry.size ? `${(entry.size / 1e6).toFixed(0)} MB` : "?";
    console.log(
      entry.valid
        ? `  ${chalk.green("✓")} ${entry.filename.padEnd(40)} ${chalk.dim(`${size}  ${entry.path}`)}`
        : `  ${chalk.red("✗")} ${entry.filename.padEnd(40)} ${chalk.dim(`invalid (${entry.reason}) — ${entry.path}`)}`
    );
  }
}

/** One deletable model, flattened across both engines for a single picker. */
interface RemovableModel {
  engine: "whisper" | "llama";
  /** What the user types to name it: a whisper stem, or a .gguf filename. */
  name: string;
  path: string;
  size: number;
  valid: boolean;
}

/**
 * Every model vno installed itself, in the order the inventory prints them.
 * Models found through Homebrew or a *_MODEL_PATH override are deliberately
 * excluded - see `isManagedModel` for why vno won't delete those.
 */
async function removableModels(): Promise<RemovableModel[]> {
  const [whisper, llama] = await Promise.all([listModels(), listLlamaModels()]);
  const out: RemovableModel[] = [];
  for (const m of whisper) {
    if (!isManagedModel(m.path)) continue;
    out.push({ engine: "whisper", name: m.stem, path: m.path, size: m.size ?? 0, valid: m.valid });
  }
  for (const m of llama) {
    if (!isManagedLlamaModel(m.path)) continue;
    out.push({ engine: "llama", name: m.filename, path: m.path, size: m.size ?? 0, valid: m.valid });
  }
  return out;
}

function formatGb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/**
 * Resolves a name typed after `--remove-model` against the installed models:
 * exact match first, then a unique case-insensitive substring. Several
 * matches lists them and resolves to nothing rather than guessing, the same
 * contract as `resolveNamedFile` for recordings.
 */
function matchRemovable(models: RemovableModel[], name: string): RemovableModel[] {
  const needle = name.trim().toLowerCase();
  const exact = models.filter((m) => m.name.toLowerCase() === needle);
  if (exact.length > 0) return exact;
  return models.filter((m) => m.name.toLowerCase().includes(needle));
}

/**
 * `vno setup --remove-model [name]` - reclaim disk space. Bare, it opens a
 * picker over everything installed; with a name, it targets just that one.
 * Either way the deletion itself is confirmed, defaulting to no, mirroring
 * the leftover-.pt offer below and `vno cleanup`'s prompt.
 *
 * Models are the one dependency that grows without bound - a couple of
 * whisper models plus a summarization GGUF is comfortably 10 GB - and
 * re-downloading one is a single command, so this is the rare delete where
 * the cost of being wrong is bandwidth rather than data.
 */
async function runRemoveModels(target: string | true): Promise<void> {
  const models = await removableModels();
  if (models.length === 0) {
    console.log(chalk.dim("No vno-installed models to remove."));
    console.log(chalk.dim("(Models from Homebrew or a *_MODEL_PATH override aren't vno's to delete.)"));
    return;
  }

  // No terminal means nowhere to confirm, and deletion in this codebase is
  // never unconfirmed - so this refuses rather than falling through to a
  // silent delete, even when a model was named explicitly.
  if (!process.stdin.isTTY) {
    console.log(chalk.red("Removing a model needs a terminal to confirm in."));
    process.exitCode = 1;
    return;
  }

  let chosen: RemovableModel[];

  if (typeof target === "string") {
    const matches = matchRemovable(models, target);
    if (matches.length === 0) {
      console.log(chalk.red(`No installed model matches "${target}".`));
      console.log(chalk.dim(`Installed: ${models.map((m) => m.name).join(", ")}`));
      process.exitCode = 1;
      return;
    }
    if (matches.length > 1) {
      console.log(chalk.red(`"${target}" matches several models:`));
      for (const m of matches) console.log(chalk.dim(`  ${m.name}`));
      console.log(chalk.dim("Name one exactly, or run `vno setup --remove-model` for a picker."));
      process.exitCode = 1;
      return;
    }
    chosen = matches;
  } else {
    const picked = await prompt([
      {
        type: "checkbox",
        name: "paths",
        message: "Which models should go? (Space toggles, Enter confirms)",
        choices: models.map((m) => ({
          name: `${m.engine === "llama" ? "summarize" : "transcribe"}  ${m.name.padEnd(40)} ${formatGb(m.size)}${m.valid ? "" : chalk.red("  (invalid)")}`,
          value: m.path,
        })),
      },
    ]);
    if (picked === CANCELLED) return;
    const paths = new Set<string>(picked.paths as string[]);
    chosen = models.filter((m) => paths.has(m.path));
    if (chosen.length === 0) {
      console.log(chalk.dim("Nothing selected."));
      return;
    }
  }

  const total = chosen.reduce((sum, m) => sum + m.size, 0);
  console.log();
  for (const m of chosen) console.log(chalk.dim(`  ${m.name} — ${formatGb(m.size)}  ${m.path}`));
  console.log(chalk.dim(`  Total: ${formatGb(total)}`));

  const answer = await prompt([
    {
      type: "list",
      name: "ok",
      message: `Delete ${chosen.length === 1 ? "this model" : `these ${chosen.length} models`}?`,
      choices: [
        { name: "No, keep them", value: false },
        { name: "Yes, delete", value: true },
      ],
      default: false,
    },
  ]);
  if (answer === CANCELLED || !answer.ok) {
    console.log(chalk.dim("Nothing deleted."));
    return;
  }

  let freed = 0;
  const gone: RemovableModel[] = [];
  for (const m of chosen) {
    const result = m.engine === "llama" ? await removeLlamaModel(m.path) : await removeModel(m.path);
    if (result.removed) {
      freed += result.freedBytes;
      gone.push(m);
    } else {
      console.log(chalk.red(`  Couldn't remove ${m.name}: ${result.reason}`));
    }
  }

  if (gone.length > 0) console.log(chalk.green(`  Deleted ${gone.length} model(s), reclaiming ${formatGb(freed)}.`));

  // A config pointing at a model that no longer exists would fail at job
  // time rather than here, so fix it now: summaryModel has no default to
  // fall back on and is cleared, while defaultModel does, and re-downloads.
  const config = await loadConfig();
  const removedNames = new Set(gone.map((m) => m.name));
  if (config.summaryModel && removedNames.has(config.summaryModel)) {
    await saveConfig({ ...config, summaryModel: null });
    console.log(chalk.dim(`  Cleared summaryModel (it pointed at ${config.summaryModel}).`));
  }
  if (config.defaultModel && removedNames.has(config.defaultModel)) {
    console.log(chalk.yellow(`  defaultModel is still "${config.defaultModel}" — the next transcribe will offer to download it again.`));
  }
}

/**
 * Reports (never deletes without asking) leftover PyTorch checkpoints from
 * the old Python whisper install - large-v3.pt alone is ~3GB, and a machine
 * that ran it for a while can be holding several times that.
 */
async function reportStalePythonCache(): Promise<void> {
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
