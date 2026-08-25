import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "fs-extra";
import { WHISPERCPP_VERSION, whispercppReleaseTagUrl, whispercppCloneUrl } from "./webSources.ts";

export type DependencyName = "ffmpeg" | "whisper" | "llama";

export interface DependencyMeta {
  label: string;
  /** The binaries that must be on PATH; empty for whisper, resolved separately. */
  commands: string[];
  usedFor: string;
}

export interface DependencyStatus {
  name: DependencyName;
  label: string;
  usedFor: string;
  found: boolean;
  missing: string[];
  path: string | null;
}

/**
 * The external programs vno shells out to, and how to find them.
 *
 * ffmpeg and ffprobe are two binaries from one package: whisper decodes audio
 * with ffmpeg, while `vno cleanup` and the note model read durations with
 * ffprobe. Missing either one means the same install, so they're one entry.
 *
 * This module only *knows* things - detection, install recipes, running them.
 * Asking the user anything lives in `cli/setup.ts`, since lib/ never prompts.
 */
export const DEPENDENCIES: Record<DependencyName, DependencyMeta> = {
  ffmpeg: {
    label: "ffmpeg",
    commands: ["ffmpeg", "ffprobe"],
    usedFor: "decoding audio for whisper and reading recording durations",
  },
  whisper: {
    label: "whisper.cpp",
    commands: [],
    usedFor: "transcribing and translating recordings",
  },
  // Entirely optional - see cli/setup.ts's REQUIRED list, which never
  // includes "llama". Nothing in vno's startup guard checks this; only the
  // summarize route and `vno setup --llama`/`vno status` look at it.
  llama: {
    label: "llama.cpp",
    commands: [],
    usedFor: "summarizing transcripts (optional)",
  },
};

const isWindows = os.platform() === "win32";

function pathExtensions(): string[] {
  if (!isWindows) return [""];
  const exts = (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((e) => e.trim())
    .filter(Boolean);
  return ["", ...exts];
}

/**
 * Resolves a command against PATH without running it.
 *
 * Probing by execution costs real time on some tools (the old Python whisper
 * booted an interpreter just to answer `--help`), which is far too slow to do
 * at the start of every command. A directory scan is instant, so the startup
 * check can be unconditional.
 */
export async function which(command: string | null | undefined): Promise<string | null> {
  if (!command) return null;
  if (command.includes("/") || command.includes("\\")) {
    return (await fs.pathExists(command)) ? path.resolve(command) : null;
  }
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = pathExtensions();
  for (const rawDir of dirs) {
    // Windows tolerates quoted PATH entries; path.join would keep the quotes.
    const dir = isWindows ? rawDir.replace(/^"|"$/g, "") : rawDir;
    for (const ext of extensions) {
      const candidate = path.join(dir, command + ext);
      try {
        // lstat, not stat: Windows App Execution Aliases (how winget and the
        // Store Python are reached) are reparse points that stat() refuses
        // with EACCES, and a symlinked /usr/bin/python3 is just as valid.
        const stats = await fs.lstat(candidate);
        if (stats.isFile() || stats.isSymbolicLink()) return candidate;
      } catch {
        // not there, or unreadable - keep looking
      }
    }
  }
  return null;
}

/** Whether every command a dependency needs is on PATH. */
export async function checkDependency(name: DependencyName): Promise<DependencyStatus> {
  const meta = DEPENDENCIES[name];
  if (!meta) throw new Error(`Unknown dependency "${name}"`);

  if (name === "whisper") {
    // whisper.cpp isn't found on PATH the way ffmpeg is - it's usually
    // vendored under whisper-cpp/bin/ by `vno setup`. Imported lazily to
    // avoid a static import cycle (lib/whisper/whispercpp.ts itself uses which() and
    // runStep() from this module).
    const { resolveBinary } = await import("./whisper/whispercpp.ts");
    const binary = await resolveBinary({});
    return {
      name,
      label: meta.label,
      usedFor: meta.usedFor,
      found: Boolean(binary),
      missing: binary ? [] : ["whisper-cli"],
      path: binary?.path || null,
    };
  }

  if (name === "llama") {
    // llama.cpp is found on PATH (or config.llamaCliPath) rather than
    // vendored - see lib/llama/llamacpp.ts. Nothing calls this with "llama" today
    // (it's not in REQUIRED, and cli/setup.ts's own llama flow calls
    // llamacpp.ts directly with the real config), but it's kept correct for
    // DependencyName's sake. Imported lazily for the same import-cycle
    // reason as whisper.cpp above.
    const { resolveBinary } = await import("./llama/llamacpp.ts");
    const binaryPath = await resolveBinary(null);
    return {
      name,
      label: meta.label,
      usedFor: meta.usedFor,
      found: Boolean(binaryPath),
      missing: binaryPath ? [] : ["llama-cli"],
      path: binaryPath,
    };
  }

  const missing: string[] = [];
  let resolvedPath: string | null = null;
  for (const command of meta.commands) {
    const found = await which(command);
    if (found) resolvedPath = resolvedPath || found;
    else missing.push(command);
  }
  return { name, label: meta.label, usedFor: meta.usedFor, found: missing.length === 0, missing, path: resolvedPath };
}

/** Status for several dependencies at once, in the order given. */
export async function checkDependencies(
  names: DependencyName[] = ["ffmpeg", "whisper"]
): Promise<DependencyStatus[]> {
  const results: DependencyStatus[] = [];
  for (const name of names) results.push(await checkDependency(name));
  return results;
}

export interface PackageManager {
  id: string;
  command: string;
  label: string;
}

// Package managers we know how to drive, most preferred first per platform.
const PACKAGE_MANAGERS: Record<string, PackageManager[]> = {
  win32: [
    { id: "winget", command: "winget", label: "winget" },
    { id: "choco", command: "choco", label: "Chocolatey" },
    { id: "scoop", command: "scoop", label: "Scoop" },
  ],
  darwin: [
    { id: "brew", command: "brew", label: "Homebrew" },
    { id: "port", command: "port", label: "MacPorts" },
  ],
  linux: [
    { id: "apt", command: "apt-get", label: "apt" },
    { id: "dnf", command: "dnf", label: "dnf" },
    { id: "yum", command: "yum", label: "yum" },
    { id: "pacman", command: "pacman", label: "pacman" },
    { id: "zypper", command: "zypper", label: "zypper" },
    { id: "apk", command: "apk", label: "apk" },
    { id: "brew", command: "brew", label: "Homebrew" },
  ],
};

/** The first known package manager present on this machine, or null. */
export async function detectPackageManager(): Promise<PackageManager | null> {
  const candidates = PACKAGE_MANAGERS[os.platform()] || PACKAGE_MANAGERS.linux;
  for (const candidate of candidates) {
    if (await which(candidate.command)) return candidate;
  }
  return null;
}

/**
 * Whether system-wide installs on this machine need `sudo`. Root already has
 * the rights, and Windows elevates through UAC rather than a command prefix.
 */
async function needsSudo(): Promise<boolean> {
  if (isWindows) return false;
  if (typeof process.getuid === "function" && process.getuid() === 0) return false;
  return Boolean(await which("sudo"));
}

/** One command to run as part of an install. */
export interface InstallStep {
  command: string;
  args: string[];
  label?: string;
  cwd?: string;
}

export interface InstallPlan {
  dependency: DependencyName;
  via: string;
  steps: InstallStep[];
  note: string | null;
}

const step = (command: string, args: string[], label?: string): InstallStep => ({
  command,
  args,
  label: label || `${command} ${args.join(" ")}`,
});

/**
 * How to install ffmpeg with each manager. Windows and Homebrew installs are
 * per-user or self-elevating; the Linux system managers need root, which the
 * caller prefixes on.
 */
function ffmpegSteps(managerId: string): InstallStep[] | null {
  switch (managerId) {
    case "winget":
      // -e pins the exact id so a fuzzy match can't pull in something else, and
      // the accept flags stop winget blocking on its licence prompts.
      return [
        step("winget", [
          "install",
          "--id",
          "Gyan.FFmpeg",
          "-e",
          "--source",
          "winget",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ]),
      ];
    case "choco":
      return [step("choco", ["install", "ffmpeg", "-y"])];
    case "scoop":
      return [step("scoop", ["install", "ffmpeg"])];
    case "brew":
      return [step("brew", ["install", "ffmpeg"])];
    case "port":
      return [step("port", ["install", "ffmpeg"])];
    case "apt":
      // A fresh machine often has no package lists at all, so the install would
      // fail on its own with "unable to locate package".
      return [step("apt-get", ["update"]), step("apt-get", ["install", "-y", "ffmpeg"])];
    case "dnf":
      return [step("dnf", ["install", "-y", "ffmpeg"])];
    case "yum":
      return [step("yum", ["install", "-y", "ffmpeg"])];
    case "pacman":
      return [step("pacman", ["-S", "--noconfirm", "ffmpeg"])];
    case "zypper":
      return [step("zypper", ["install", "-y", "ffmpeg"])];
    case "apk":
      return [step("apk", ["add", "ffmpeg"])];
    default:
      return null;
  }
}

// Managers whose own installs are per-user or self-elevating, so prefixing
// sudo would be wrong (Homebrew actively refuses to run as root).
const SELF_ELEVATING = new Set(["winget", "choco", "scoop", "brew"]);

/**
 * Builds the install plan for one dependency on this machine, or null when we
 * have nothing to drive (no known package manager). `null` isn't a failure -
 * the caller falls back to `manualHelp()`.
 *
 * whisper.cpp isn't built here: its install is per-platform binary/source
 * acquisition (brew formula, GitHub release zip, cmake build), not a package
 * manager one-liner - see `lib/whisper/whispercpp.ts:installWhisperCpp`.
 */
export async function buildInstallPlan(name: DependencyName): Promise<InstallPlan | null> {
  if (name !== "ffmpeg") throw new Error(`Unknown dependency "${name}"`);

  const manager = await detectPackageManager();
  if (!manager) return null;

  const sudo = await needsSudo();
  const withPrivileges = (steps: InstallStep[], managerId: string) => {
    if (!sudo || SELF_ELEVATING.has(managerId)) return steps;
    return steps.map((s) => step("sudo", [s.command, ...s.args]));
  };

  const steps = ffmpegSteps(manager.id);
  if (!steps) return null;
  return {
    dependency: name,
    via: manager.label,
    steps: withPrivileges(steps, manager.id),
    note: noteFor(name, manager.id),
  };
}

function noteFor(name: DependencyName, managerId: string): string | null {
  if (name === "ffmpeg" && managerId === "dnf") {
    return "Fedora ships ffmpeg through RPM Fusion - if this fails, enable that repository first.";
  }
  if (name === "ffmpeg" && (managerId === "winget" || managerId === "choco")) {
    return "Windows may show a UAC prompt, and the new PATH entry only reaches shells started afterwards.";
  }
  return null;
}

/** Copy-pasteable instructions for when we can't install it ourselves. */
export function manualHelp(name: DependencyName): string[] {
  const platform = os.platform();
  if (name === "ffmpeg") {
    if (platform === "win32") {
      return [
        "winget install --id Gyan.FFmpeg -e",
        "…or download a build from https://www.gyan.dev/ffmpeg/builds/ and add its bin/ folder to PATH",
      ];
    }
    if (platform === "darwin") {
      return ["brew install ffmpeg", "…or get Homebrew first from https://brew.sh"];
    }
    return [
      "sudo apt-get install ffmpeg      # Debian/Ubuntu",
      "sudo dnf install ffmpeg          # Fedora (needs RPM Fusion)",
      "sudo pacman -S ffmpeg            # Arch",
    ];
  }
  if (name === "whisper") {
    if (platform === "darwin") {
      return ["brew install whisper-cpp", "…or get Homebrew first from https://brew.sh"];
    }
    if (platform === "win32") {
      return [
        `Download a release zip from ${whispercppReleaseTagUrl()}`,
        "…and extract it (keeping every .dll beside whisper-cli.exe) into the location `vno setup` reports",
      ];
    }
    return [
      `git clone --depth 1 --branch ${WHISPERCPP_VERSION} ${whispercppCloneUrl()}`,
      "cmake -B build -DCMAKE_BUILD_TYPE=Release   # add -DGGML_CUDA=ON for an NVIDIA GPU",
      "cmake --build build -j --config Release",
    ];
  }
  if (name === "llama") {
    if (platform === "darwin") {
      return ["brew install llama.cpp", "…or get Homebrew first from https://brew.sh"];
    }
    if (platform === "win32") {
      return [
        "winget install --id ggml.llamacpp -e",
        "…then either open a new terminal, or give vno the binary's path when `vno setup --llama` asks",
      ];
    }
    return [
      "install it via your distro's package manager or build it yourself:",
      "https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md",
    ];
  }
  return [];
}

export interface StepResult {
  ok: boolean;
  code?: number | null;
  output: string;
}

export interface PlanResult {
  ok: boolean;
  output: string;
  failedStep?: InstallStep;
}

/**
 * Runs one install step. stdin is inherited so `sudo` can ask for a password
 * and a package manager can ask its questions; stdout/stderr are echoed raw
 * (not line-buffered) so a trailing prompt like "Password:" actually shows up,
 * while still being collected for the caller to inspect afterwards.
 */
export function runStep(
  { command, args, cwd }: InstallStep,
  { onOutput = null }: { onOutput?: ((text: string) => void) | null } = {}
): Promise<StepResult> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"], windowsHide: true, cwd });
    } catch (err) {
      resolve({ ok: false, output: err instanceof Error ? err.message : String(err) });
      return;
    }

    let output = "";
    const collect = (chunk: Buffer | string) => {
      const text = chunk.toString();
      output += text;
      if (onOutput) onOutput(text);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.on("error", (err) => resolve({ ok: false, output: `${output}${err.message}` }));
    child.on("close", (code) => resolve({ ok: code === 0, code, output }));
  });
}

/** Runs a plan's steps in order, stopping at the first failure. */
export async function runPlan(
  plan: InstallPlan,
  {
    onOutput = null,
    onStep = null,
  }: { onOutput?: ((text: string) => void) | null; onStep?: ((step: InstallStep) => void) | null } = {}
): Promise<PlanResult> {
  let output = "";
  for (const s of plan.steps) {
    if (onStep) onStep(s);
    const result = await runStep(s, { onOutput });
    output += result.output || "";
    if (!result.ok) return { ok: false, output, failedStep: s };
  }
  return { ok: true, output };
}

/**
 * Re-reads PATH after an install so a freshly installed ffmpeg is usable in
 * this same run. A child process inherits PATH as it was at launch, so without
 * this an install always ends in "restart your terminal" - which is a poor end
 * to `vno t` that just installed what it needed. (whisper.cpp itself doesn't
 * go through PATH - it's vendored into whisper-cpp/bin/ and resolved directly
 * by `lib/whisper/whispercpp.ts:resolveBinary`, so this only ever matters for ffmpeg.)
 *
 * Windows keeps the real PATH in the registry, so we ask it for the current
 * value. Elsewhere it's enough to add the handful of directories package
 * managers install into, when they exist and aren't already listed.
 */
export async function refreshPath(): Promise<boolean> {
  const before = process.env.PATH || "";
  const additions: string[] = [];

  if (isWindows) {
    const fromRegistry = await readWindowsPath();
    if (fromRegistry) {
      for (const dir of fromRegistry.split(path.delimiter)) {
        if (dir && !containsDir(process.env.PATH, dir)) additions.push(dir);
      }
    }
  } else {
    const candidates = [
      "/opt/homebrew/bin", // Apple silicon Homebrew
      "/usr/local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/opt/local/bin", // MacPorts
    ];
    for (const dir of candidates) {
      if (containsDir(process.env.PATH, dir)) continue;
      if (await fs.pathExists(dir)) additions.push(dir);
    }
  }

  if (additions.length > 0) {
    process.env.PATH = [before, ...additions].filter(Boolean).join(path.delimiter);
  }
  return process.env.PATH !== before;
}

function containsDir(pathValue: string | undefined, dir: string): boolean {
  const wanted = dir.replace(/[\\/]+$/, "").toLowerCase();
  return (pathValue || "")
    .split(path.delimiter)
    .some((entry) => entry.replace(/[\\/]+$/, "").toLowerCase() === wanted);
}

/** The machine + user PATH as Windows currently has it, joined. */
function readWindowsPath(): Promise<string | null> {
  return new Promise((resolve) => {
    const script =
      '[System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + ' +
      '[System.Environment]::GetEnvironmentVariable("Path","User")';
    let child;
    try {
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}
