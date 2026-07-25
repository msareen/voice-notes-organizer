import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import fs from "fs-extra";

/**
 * The external programs vno shells out to, and how to find them.
 *
 * ffmpeg and ffprobe are two binaries from one package: whisper decodes audio
 * with ffmpeg, while `vno cleanup` and the note model read durations with
 * ffprobe. Missing either one means the same install, so they're one entry.
 *
 * This module only *knows* things - detection, install recipes, running them.
 * Asking the user anything lives in `cli/setup.js`, since lib/ never prompts.
 */
export const DEPENDENCIES = {
  ffmpeg: {
    label: "ffmpeg",
    commands: ["ffmpeg", "ffprobe"],
    usedFor: "decoding audio for whisper and reading recording durations",
  },
  whisper: {
    label: "whisper",
    commands: ["whisper"],
    usedFor: "transcribing and translating recordings",
  },
  python: {
    label: "Python (pip)",
    commands: [],
    usedFor: "installing whisper, which ships as a Python package",
  },
};

const isWindows = os.platform() === "win32";

function pathExtensions() {
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
 * Probing by execution (`whisper --help`) costs seconds - it boots Python and
 * torch - which is far too slow to do at the start of every command. A
 * directory scan is instant, so the startup check can be unconditional.
 */
export async function which(command) {
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
export async function checkDependency(name) {
  const meta = DEPENDENCIES[name];
  if (!meta) throw new Error(`Unknown dependency "${name}"`);

  if (name === "python") {
    const pip = await resolvePip();
    return { name, label: meta.label, usedFor: meta.usedFor, found: Boolean(pip), missing: [], pip };
  }

  const missing = [];
  let resolvedPath = null;
  for (const command of meta.commands) {
    const found = await which(command);
    if (found) resolvedPath = resolvedPath || found;
    else missing.push(command);
  }
  return { name, label: meta.label, usedFor: meta.usedFor, found: missing.length === 0, missing, path: resolvedPath };
}

/** Status for several dependencies at once, in the order given. */
export async function checkDependencies(names = ["ffmpeg", "whisper"]) {
  const results = [];
  for (const name of names) results.push(await checkDependency(name));
  return results;
}

// Package managers we know how to drive, most preferred first per platform.
const PACKAGE_MANAGERS = {
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
export async function detectPackageManager() {
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
async function needsSudo() {
  if (isWindows) return false;
  if (typeof process.getuid === "function" && process.getuid() === 0) return false;
  return Boolean(await which("sudo"));
}

const step = (command, args, label) => ({ command, args, label: label || `${command} ${args.join(" ")}` });

/**
 * How to install ffmpeg with each manager. Windows and Homebrew installs are
 * per-user or self-elevating; the Linux system managers need root, which the
 * caller prefixes on.
 */
function ffmpegSteps(managerId) {
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

/** How to install Python + pip, which whisper's install needs. */
function pythonSteps(managerId) {
  switch (managerId) {
    case "winget":
      return [
        step("winget", [
          "install",
          "--id",
          "Python.Python.3.12",
          "-e",
          "--source",
          "winget",
          "--accept-package-agreements",
          "--accept-source-agreements",
        ]),
      ];
    case "choco":
      return [step("choco", ["install", "python", "-y"])];
    case "scoop":
      return [step("scoop", ["install", "python"])];
    case "brew":
      return [step("brew", ["install", "python"])];
    case "port":
      return [step("port", ["install", "python312", "py312-pip"])];
    case "apt":
      return [step("apt-get", ["update"]), step("apt-get", ["install", "-y", "python3-pip"])];
    case "dnf":
      return [step("dnf", ["install", "-y", "python3-pip"])];
    case "yum":
      return [step("yum", ["install", "-y", "python3-pip"])];
    case "pacman":
      return [step("pacman", ["-S", "--noconfirm", "python-pip"])];
    case "zypper":
      return [step("zypper", ["install", "-y", "python3-pip"])];
    case "apk":
      return [step("apk", ["add", "py3-pip"])];
    default:
      return null;
  }
}

// Managers whose own installs are per-user or self-elevating, so prefixing
// sudo would be wrong (Homebrew actively refuses to run as root).
const SELF_ELEVATING = new Set(["winget", "choco", "scoop", "brew"]);

/**
 * Resolves how to invoke pip. Spellings differ per platform and install
 * method, and `python -m pip` works where a bare `pip` shim was never created,
 * so try the plain commands first and fall back to the module form.
 */
export async function resolvePip() {
  for (const command of ["pip3", "pip"]) {
    const found = await which(command);
    if (found) return { command, args: [] };
  }
  for (const command of isWindows ? ["python", "py", "python3"] : ["python3", "python"]) {
    const found = await which(command);
    if (found) return { command, args: ["-m", "pip"] };
  }
  return null;
}

/**
 * Builds the install plan for one dependency on this machine, or null when we
 * have nothing to drive (no known package manager, no Python for whisper).
 * `null` isn't a failure - the caller falls back to `manualHelp()`.
 */
export async function buildInstallPlan(name) {
  const manager = await detectPackageManager();
  const sudo = await needsSudo();

  const withPrivileges = (steps, managerId) => {
    if (!sudo || SELF_ELEVATING.has(managerId)) return steps;
    return steps.map((s) => step("sudo", [s.command, ...s.args]));
  };

  if (name === "ffmpeg" || name === "python") {
    if (!manager) return null;
    const steps = name === "ffmpeg" ? ffmpegSteps(manager.id) : pythonSteps(manager.id);
    if (!steps) return null;
    return {
      dependency: name,
      via: manager.label,
      steps: withPrivileges(steps, manager.id),
      note: noteFor(name, manager.id),
    };
  }

  if (name === "whisper") {
    const pip = await resolvePip();
    if (!pip) return null; // caller installs Python first, then asks again
    return {
      dependency: "whisper",
      via: `${pip.command}${pip.args.length ? " -m pip" : ""}`,
      steps: [step(pip.command, [...pip.args, "install", "-U", "openai-whisper"])],
      note: null,
    };
  }

  throw new Error(`Unknown dependency "${name}"`);
}

/**
 * A pip install can fail on Debian/Ubuntu (and Homebrew Python) because the
 * interpreter is marked externally managed - a policy refusal, not a broken
 * install, and one with two different fixes. Recognised from the output so the
 * caller can say which applies instead of just "install failed".
 */
export function isExternallyManagedError(output) {
  return /externally[- ]managed[- ]environment/i.test(output || "");
}

/** Fallback pip install through pipx, which sidesteps an externally managed Python. */
export async function buildPipxPlan() {
  if (!(await which("pipx"))) return null;
  return {
    dependency: "whisper",
    via: "pipx",
    steps: [step("pipx", ["install", "openai-whisper"])],
    note: "pipx puts whisper in its own environment, which the system Python allows.",
  };
}

function noteFor(name, managerId) {
  if (name === "ffmpeg" && managerId === "dnf") {
    return "Fedora ships ffmpeg through RPM Fusion - if this fails, enable that repository first.";
  }
  if (name === "ffmpeg" && (managerId === "winget" || managerId === "choco")) {
    return "Windows may show a UAC prompt, and the new PATH entry only reaches shells started afterwards.";
  }
  return null;
}

/** Copy-pasteable instructions for when we can't install it ourselves. */
export function manualHelp(name) {
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
    return [
      "pip install -U openai-whisper",
      "…or pipx install openai-whisper if your Python is externally managed",
    ];
  }
  if (name === "python") {
    if (platform === "win32") return ["winget install --id Python.Python.3.12 -e"];
    if (platform === "darwin") return ["brew install python"];
    return ["sudo apt-get install python3-pip   # or your distro's equivalent"];
  }
  return [];
}

/**
 * Runs one install step. stdin is inherited so `sudo` can ask for a password
 * and a package manager can ask its questions; stdout/stderr are echoed raw
 * (not line-buffered) so a trailing prompt like "Password:" actually shows up,
 * while still being collected for the caller to inspect afterwards.
 */
export function runStep({ command, args }, { onOutput = null } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["inherit", "pipe", "pipe"], windowsHide: true });
    } catch (err) {
      resolve({ ok: false, output: err.message });
      return;
    }

    let output = "";
    const collect = (chunk) => {
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
export async function runPlan(plan, { onOutput = null, onStep = null } = {}) {
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
 * Re-reads PATH after an install so the freshly installed binary is usable in
 * this same run. A child process inherits PATH as it was at launch, so without
 * this an install always ends in "restart your terminal" - which is a poor end
 * to `vno t` that just installed what it needed.
 *
 * Windows keeps the real PATH in the registry, so we ask it for the current
 * value. Elsewhere it's enough to add the handful of directories package
 * managers and pip install into, when they exist and aren't already listed.
 */
export async function refreshPath() {
  const before = process.env.PATH || "";
  const additions = [];

  if (isWindows) {
    const fromRegistry = await readWindowsPath();
    if (fromRegistry) {
      for (const dir of fromRegistry.split(path.delimiter)) {
        if (dir && !containsDir(process.env.PATH, dir)) additions.push(dir);
      }
    }
  } else {
    const home = os.homedir();
    const candidates = [
      "/opt/homebrew/bin", // Apple silicon Homebrew
      "/usr/local/bin",
      "/home/linuxbrew/.linuxbrew/bin",
      "/opt/local/bin", // MacPorts
      path.join(home, ".local", "bin"), // pip --user, pipx
      path.join(home, "Library", "Python", "3.12", "bin"),
      path.join(home, "Library", "Python", "3.11", "bin"),
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

function containsDir(pathValue, dir) {
  const wanted = dir.replace(/[\\/]+$/, "").toLowerCase();
  return (pathValue || "")
    .split(path.delimiter)
    .some((entry) => entry.replace(/[\\/]+$/, "").toLowerCase() === wanted);
}

/** The machine + user PATH as Windows currently has it, joined. */
function readWindowsPath() {
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
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code === 0 ? out.trim() : null));
  });
}
