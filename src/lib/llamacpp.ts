import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import fs from "fs-extra";
import { which, detectPackageManager, runStep } from "./setup.ts";
import type { AccelBackend } from "../types.ts";
import type { InstallStep } from "./setup.ts";
import {
  LLAMACPP_VERSION,
  LLAMACPP_REPO,
  HOMEBREW_URL,
  llamacppReleaseTagUrl,
  llamacppReleaseApiUrl,
  llamacppReleaseAssetUrl,
  llamacppCloneUrl,
  llamaModelSources,
} from "./webSources.ts";
import {
  isWindows,
  isMac,
  errorMessage,
  findFile,
  downloadFile,
  extractZip,
  extractTarGz,
  detectAccelCandidate,
  ensureGitignoreEntry,
  resolveInstallRoot as resolveEngineInstallRoot,
  installPaths,
  readManifest as readEngineManifest,
  writeManifest as writeEngineManifest,
  bothInstallRoots as bothEngineInstallRoots,
  registerExternalBinary as registerExternalEngineBinary,
  isManagedModel as isEngineManagedModel,
  removeEngineModel,
} from "./engineInstall.ts";
import type {
  InstallMode,
  BinaryRecord,
  AccelRecord,
  InstallManifest,
  InstallLayout,
  EngineRoot,
  AccelCandidate,
  DownloadProgressCallback,
  ModelRemoval,
} from "./engineInstall.ts";

/**
 * Installing and resolving the llama.cpp binary, its (optional) GGUF
 * summarization models and the vno-install.json manifest that records what
 * `vno setup --llama` found or built - the same construct as
 * lib/whispercpp.ts, deliberately, so this engine is discoverable/manageable
 * the same way: a vendored binary under llama-cpp/, models dropped into
 * llama-cpp/models/ with no npm dependency or native bindings involved.
 *
 * Unlike whisper.cpp, llama.cpp is entirely optional - nothing in `vno`
 * requires it, and `vno setup` never installs it unless explicitly asked
 * (`--llama`). See cli/setup.ts for the wizard that drives this module.
 */

const MANIFEST_DESCRIPTION =
  "This file is written and read by vno (the voice-note-organizer CLI), not by llama.cpp itself. " +
  "It records what `vno setup --llama` found or installed in this folder (the binary, its accelerator, " +
  "and any models downloaded here) so future runs don't have to redetect it. Safe to delete - vno " +
  "recreates it the next time `vno setup --llama` runs. This folder is entirely optional: vno's " +
  "transcription and import features never touch it, only transcript summarization does.";

const ENGINE: EngineRoot = { folderName: "llama-cpp", manifestDescription: MANIFEST_DESCRIPTION };

export type { InstallMode, BinaryRecord, AccelRecord, InstallManifest, InstallLayout };

/** Where llama-cpp/ lives for the given mode. */
export function resolveInstallRoot(mode: InstallMode = "local"): string {
  return resolveEngineInstallRoot(ENGINE, mode);
}

export { installPaths };

/** Reads vno-install.json for a root, or null if it's not there or unreadable. */
export async function readManifest(root: string): Promise<InstallManifest | null> {
  return readEngineManifest(root);
}

/** Writes vno-install.json, creating the root/bin/models layout if needed. */
export async function writeManifest(root: string, data: InstallManifest): Promise<void> {
  return writeEngineManifest(ENGINE, root, data);
}

/** Both install roots, local first - used by resolution that must check both. */
export function bothInstallRoots(): string[] {
  return bothEngineInstallRoots(ENGINE);
}

/** Whether vno installed this model itself, and may therefore delete it. */
export function isManagedModel(filePath: string): boolean {
  return isEngineManagedModel(ENGINE, filePath);
}

/** Deletes one vno-installed .gguf. Refuses anything `isManagedModel` rejects. */
export async function removeModel(filePath: string): Promise<ModelRemoval> {
  return removeEngineModel(ENGINE, filePath);
}

// As of the b-series releases, llama.cpp's CLI binary is `llama-cli`(.exe).
// Older releases called it `main` - tried as a fallback the same way
// whisper.cpp's `main`/`whisper-cli` rename is handled.
const BINARY_NAMES = isWindows ? ["llama-cli.exe", "main.exe"] : ["llama-cli", "main"];

/** Where the llama.cpp binary was found, and which root it belongs to. */
export interface ResolvedBinary {
  path: string;
  name: string;
  source: string;
  /** null when it came off PATH rather than an install root. */
  root: string | null;
}

/**
 * Finds the llama.cpp binary: whichever install root's `vno-install.json` is
 * newest, then the other root, then PATH under any known spelling. Mirrors
 * whisper.cpp's `resolveBinary` exactly - see its comment for why "newest
 * wins" matters once both roots have ever been used.
 */
export async function resolveBinary({ mode = "local" }: { mode?: InstallMode } = {}): Promise<ResolvedBinary | null> {
  const localRoot = resolveInstallRoot("local");
  const globalRoot = resolveInstallRoot("global");
  const [localManifest, globalManifest] = await Promise.all([readManifest(localRoot), readManifest(globalRoot)]);
  const installedAtMs = (manifest: InstallManifest | null) =>
    manifest?.installedAt ? Date.parse(manifest.installedAt) || 0 : 0;
  const localTime = installedAtMs(localManifest);
  const globalTime = installedAtMs(globalManifest);

  const roots =
    localTime !== globalTime
      ? localTime > globalTime
        ? [localRoot, globalRoot]
        : [globalRoot, localRoot]
      : mode === "global"
        ? [globalRoot, localRoot]
        : [localRoot, globalRoot];
  const manifestByRoot = new Map<string, InstallManifest | null>([
    [localRoot, localManifest],
    [globalRoot, globalManifest],
  ]);

  for (const root of roots) {
    const { binDir } = installPaths(root);
    for (const name of BINARY_NAMES) {
      const candidate = path.join(binDir, name);
      if (await fs.pathExists(candidate)) return { path: candidate, name, source: "vendored", root };
    }
    const manifest = manifestByRoot.get(root);
    const recorded = manifest?.binary?.path;
    if (recorded && (await fs.pathExists(recorded))) {
      return {
        path: recorded,
        name: manifest?.binary?.name || path.basename(recorded),
        source: manifest?.binary?.source || "manifest",
        root,
      };
    }
  }

  for (const name of BINARY_NAMES) {
    const found = await which(name);
    if (found) return { path: found, name, source: "path", root: null };
  }

  return null;
}

/** Whether a usable llama.cpp binary can be found - a directory/manifest scan, never a spawn. */
export async function isLlamaInstalled(): Promise<boolean> {
  return Boolean(await resolveBinary({}));
}

// Every name llama.cpp's binary is known to go by, across install methods.
const ALL_BINARY_NAMES = ["llama-cli", "llama-cli.exe", "main", "main.exe"];

/**
 * Points vno at a llama.cpp binary the user already has, instead of
 * installing one. Same reference-don't-copy contract as whisper.cpp's
 * `registerExternalBinary`.
 */
export async function registerExternalBinary(
  inputPath: string,
  opts: { mode?: InstallMode; backend?: AccelRecord["backend"]; name?: string | null } = {}
): Promise<InstallManifest> {
  return registerExternalEngineBinary(ENGINE, ALL_BINARY_NAMES, LLAMACPP_VERSION, inputPath, opts);
}

// ---------------------------------------------------------------------------
// Per-platform binary acquisition
// ---------------------------------------------------------------------------

/** What a per-platform install returns for the manifest to record. */
export interface InstallOutcome {
  binary: BinaryRecord;
  accel: AccelRecord;
}

/** macOS: Homebrew only, never a source build - matches whisper.cpp's approach. */
export async function installMacBinary(): Promise<InstallOutcome> {
  if (!(await which("brew"))) {
    throw new Error(`Homebrew isn't installed. Get it from ${HOMEBREW_URL}, then run \`vno setup --llama\` again.`);
  }
  const result = await runStep({ command: "brew", args: ["install", "llama.cpp"] });
  if (!result.ok) throw new Error(`brew install llama.cpp failed:\n${result.output}`);

  const resolved = await which("llama-cli");
  if (!resolved) throw new Error("brew install llama.cpp succeeded but llama-cli still isn't on PATH.");

  // Homebrew's llama.cpp formula builds with Metal enabled on Apple silicon,
  // same as whisper-cpp's formula.
  return {
    binary: { path: resolved, name: "llama-cli", source: "homebrew" },
    accel: { backend: "metal", name: "Apple Metal" },
  };
}

/** One downloadable file from a GitHub release. */
interface ReleaseAsset {
  name: string;
  url: string;
}

async function fetchReleaseAssets(version: string): Promise<ReleaseAsset[] | null> {
  const url = llamacppReleaseApiUrl(version);
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (response.status === 403) return null; // rate-limited - caller falls back to a pinned name
  if (!response.ok) {
    throw new Error(`Couldn't list llama.cpp ${version} release assets: ${response.status} ${response.statusText}`);
  }
  const release = (await response.json()) as { assets?: { name: string; browser_download_url: string }[] };
  return (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
}

interface PickedAsset {
  asset: ReleaseAsset;
  backend: AccelBackend;
  /** Set for a CUDA pick - which `cudart-llama-bin-win-cuda-<tag>-x64.zip` to also fetch. */
  cudaTag?: string;
}

/**
 * Picks a Windows asset by CUDA runtime version. Confirmed against the
 * actual b10618 release's asset list (2026-08-25) - upstream has changed
 * this naming before (the old `cu12.4`/`avx2`/`avx` scheme this replaced is
 * gone), so re-check `${llamacppReleaseApiUrl()}` if installs start failing
 * to find a match again:
 *
 *   llama-<tag>-bin-win-cuda-12.4-x64.zip   CUDA 12.4 (no "cu" prefix now)
 *   llama-<tag>-bin-win-cuda-13.3-x64.zip   CUDA 13.3
 *   cudart-llama-bin-win-cuda-<ver>-x64.zip runtime DLLs for the matching
 *                                           CUDA build above - no longer
 *                                           bundled into the main zip, so
 *                                           installWindowsBinary fetches it
 *                                           as a second asset when present
 *   llama-<tag>-bin-win-cpu-x64.zip         CPU (replaces the old avx2/avx
 *                                           split - one build now)
 *
 * A `win-vulkan-x64.zip` asset exists upstream now too (AMD/Intel GPU
 * acceleration), but isn't wired up here - `detectAccelCandidate` only ever
 * reports "cuda" or "cpu", matching whisper.cpp's Windows story, so a
 * non-NVIDIA GPU still gets the CPU build. That's a real v2 opportunity, not
 * a bug.
 */
function pickWindowsAsset(assets: ReleaseAsset[], version: string, accel: AccelCandidate): PickedAsset | null {
  const exact = (name: string) => assets.find((a) => a.name === name);

  if (accel.backend === "cuda" && accel.cudaVersion) {
    const major = parseInt(accel.cudaVersion.split(".")[0], 10);
    if (Number.isFinite(major)) {
      if (major >= 13) {
        const asset = exact(`llama-${version}-bin-win-cuda-13.3-x64.zip`);
        if (asset) return { asset, backend: "cuda", cudaTag: "13.3" };
      }
      if (major >= 12) {
        const asset = exact(`llama-${version}-bin-win-cuda-12.4-x64.zip`);
        if (asset) return { asset, backend: "cuda", cudaTag: "12.4" };
      }
    }
  }

  const cpu = exact(`llama-${version}-bin-win-cpu-x64.zip`) || assets.find((a) => /bin-win-cpu-x64/i.test(a.name));
  if (cpu) return { asset: cpu, backend: "cpu" };

  return null;
}

export type LogCallback = (message: string) => void;
export type StepCallback = (step: InstallStep) => void;

interface WindowsInstallOptions {
  onLog?: LogCallback;
  onProgress?: DownloadProgressCallback | null;
}

/** Windows: prebuilt release zip, never a source build. */
export async function installWindowsBinary(
  root: string,
  { onLog = () => {}, onProgress = null }: WindowsInstallOptions = {}
): Promise<InstallOutcome> {
  const accelCandidate = await detectAccelCandidate();
  onLog(
    accelCandidate.backend === "cuda"
      ? `Detected NVIDIA GPU (${accelCandidate.name}), driver supports CUDA ${accelCandidate.cudaVersion || "unknown"}.`
      : "No NVIDIA GPU detected; using the CPU build."
  );

  const assets = await fetchReleaseAssets(LLAMACPP_VERSION);
  if (!assets) {
    throw new Error(
      `GitHub's API is rate-limited right now and llama.cpp has no pinned fallback asset name yet. ` +
        `Try \`vno setup --llama\` again shortly, or check ${llamacppReleaseTagUrl()} yourself.`
    );
  }

  const picked = pickWindowsAsset(assets, LLAMACPP_VERSION, accelCandidate);
  if (!picked) {
    throw new Error(
      `No matching Windows asset found in llama.cpp ${LLAMACPP_VERSION}. Available assets:\n` +
        assets.map((a) => `  - ${a.name}`).join("\n")
    );
  }

  onLog(`Chosen asset: ${picked.asset.name} (${picked.backend})`);

  const { binDir } = installPaths(root);
  await fs.ensureDir(binDir);
  const zipPath = path.join(os.tmpdir(), `vno-llamacpp-${Date.now()}.zip`);
  await downloadFile(picked.asset.url, zipPath, { onProgress });
  try {
    await extractZip(zipPath, binDir);
  } finally {
    await fs.remove(zipPath);
  }

  // The CUDA build's runtime DLLs (cudart64_*.dll, cublas64_*.dll, ...) ship
  // as a separate asset now rather than bundled into the main zip - without
  // this the binary extracts fine but fails to launch at all.
  if (picked.cudaTag) {
    const cudartName = `cudart-llama-bin-win-cuda-${picked.cudaTag}-x64.zip`;
    const cudartAsset = assets.find((a) => a.name === cudartName);
    if (cudartAsset) {
      onLog(`Downloading CUDA runtime (${cudartName})...`);
      const cudartZipPath = path.join(os.tmpdir(), `vno-llamacpp-cudart-${Date.now()}.zip`);
      await downloadFile(cudartAsset.url, cudartZipPath, { onProgress });
      try {
        await extractZip(cudartZipPath, binDir);
      } finally {
        await fs.remove(cudartZipPath);
      }
    } else {
      onLog(
        `Warning: no ${cudartName} asset found - the CUDA binary may fail to start unless a matching CUDA runtime is already on PATH.`
      );
    }
  }

  const exe = (await findFile(binDir, "llama-cli.exe")) || (await findFile(binDir, "main.exe"));
  if (!exe) {
    throw new Error(`Extracted ${picked.asset.name} but couldn't find llama-cli.exe inside ${binDir}.`);
  }

  return {
    binary: { path: exe, name: path.basename(exe), source: "release-zip", asset: picked.asset.name },
    accel: { backend: picked.backend, name: accelCandidate.name },
  };
}

interface LinuxInstallOptions {
  onLog?: LogCallback;
  onStep?: StepCallback;
  onProgress?: DownloadProgressCallback | null;
}

/**
 * Linux: a prebuilt CPU zip exists (`llama-<tag>-bin-ubuntu-x64.zip`) and is
 * used whenever there's no GPU to build CUDA support for. A detected NVIDIA
 * GPU means building from source with `-DGGML_CUDA=ON` (no prebuilt Linux
 * CUDA asset), mirroring whisper.cpp's Linux install exactly.
 */
export async function installLinuxBinary(
  root: string,
  { onLog = () => {}, onStep = () => {}, onProgress = null }: LinuxInstallOptions = {}
): Promise<InstallOutcome> {
  const accelCandidate = await detectAccelCandidate();
  const useCuda = accelCandidate.backend === "cuda";

  if (!useCuda) {
    try {
      return await installLinuxPrebuilt(root, { onLog, onProgress });
    } catch (err) {
      onLog(`Prebuilt Linux binary didn't work out (${errorMessage(err)}); building from source instead.`);
    }
  }

  return installLinuxSource(root, { onLog, onStep, useCuda, accelCandidate });
}

async function installLinuxPrebuilt(
  root: string,
  { onLog, onProgress }: { onLog: LogCallback; onProgress: DownloadProgressCallback | null }
): Promise<InstallOutcome> {
  // As of b10618 this is a .tar.gz, not the .zip earlier llama.cpp releases
  // used (whisper.cpp's Linux prebuilt is still a tarball too, for the same
  // reason - tar preserves the executable bit, which a zip on Linux won't).
  const assetName =
    os.arch() === "arm64"
      ? `llama-${LLAMACPP_VERSION}-bin-ubuntu-arm64.tar.gz`
      : `llama-${LLAMACPP_VERSION}-bin-ubuntu-x64.tar.gz`;

  const assets = await fetchReleaseAssets(LLAMACPP_VERSION);
  if (!assets) throw new Error("GitHub's API is rate-limited right now");
  const found = assets.find((a) => a.name === assetName);
  if (!found) throw new Error(`no ${assetName} in the ${LLAMACPP_VERSION} release`);

  onLog(`Downloading ${assetName}...`);
  const { binDir } = installPaths(root);
  await fs.ensureDir(binDir);
  const tarPath = path.join(os.tmpdir(), `vno-llamacpp-${Date.now()}.tar.gz`);
  await downloadFile(found.url, tarPath, { onProgress });
  try {
    await extractTarGz(tarPath, binDir);
  } finally {
    await fs.remove(tarPath);
  }

  const cli = (await findFile(binDir, "llama-cli")) || (await findFile(binDir, "main"));
  if (!cli) {
    throw new Error(`extracted ${assetName} but found no llama.cpp binary inside ${binDir}`);
  }
  await fs.chmod(cli, 0o755).catch(() => {});

  return {
    binary: { path: cli, name: path.basename(cli), source: "release-tarball", asset: assetName },
    accel: { backend: "cpu", name: null },
  };
}

async function installLinuxSource(
  root: string,
  {
    onLog,
    onStep,
    useCuda,
    accelCandidate,
  }: { onLog: LogCallback; onStep: StepCallback; useCuda: boolean; accelCandidate: AccelCandidate }
): Promise<InstallOutcome> {
  const missing: string[] = [];
  if (!(await which("cmake"))) missing.push("cmake");
  if (!(await which("git"))) missing.push("git");
  if (!(await which("cc")) && !(await which("gcc")) && !(await which("g++"))) missing.push("build-essential");

  if (missing.length > 0) {
    const manager = await detectPackageManager();
    const installHint =
      manager?.id === "apt"
        ? `sudo apt-get install -y ${missing.join(" ")}`
        : manager?.id === "dnf"
          ? `sudo dnf install -y cmake git gcc-c++`
          : `install ${missing.join(", ")} with your distro's package manager`;
    throw new Error(
      `Building llama.cpp needs ${missing.join(", ")}, which ${missing.length > 1 ? "aren't" : "isn't"} installed.\n` +
        `Run this yourself (vno won't sudo on your behalf):\n  ${installHint}`
    );
  }

  const cloneDir = path.join(os.tmpdir(), `vno-llamacpp-src-${Date.now()}`);

  const cloneStep: InstallStep = {
    command: "git",
    args: ["clone", "--depth", "1", "--branch", LLAMACPP_VERSION, llamacppCloneUrl(), cloneDir],
  };
  onLog(`Cloning llama.cpp ${LLAMACPP_VERSION}...`);
  onStep(cloneStep);
  let result = await runStep(cloneStep);
  if (!result.ok) throw new Error(`git clone failed:\n${result.output}`);

  const cmakeArgs = ["-B", "build", "-DCMAKE_BUILD_TYPE=Release"];
  if (useCuda) cmakeArgs.push("-DGGML_CUDA=ON");
  onLog(`Configuring with cmake${useCuda ? " (CUDA enabled)" : ""}...`);
  result = await runStep({ command: "cmake", args: cmakeArgs, cwd: cloneDir });
  if (!result.ok) throw new Error(`cmake configure failed:\n${result.output}`);

  onLog("Building (this can take a few minutes)...");
  result = await runStep({ command: "cmake", args: ["--build", "build", "-j", "--config", "Release"], cwd: cloneDir });
  if (!result.ok) throw new Error(`cmake build failed:\n${result.output}`);

  const { binDir } = installPaths(root);
  await fs.ensureDir(binDir);
  const builtBinDir = path.join(cloneDir, "build", "bin");
  const builtFiles = await fs.readdir(builtBinDir).catch(() => []);
  for (const file of builtFiles) {
    await fs.copy(path.join(builtBinDir, file), path.join(binDir, file));
  }
  await fs.remove(cloneDir);

  const cli = path.join(binDir, "llama-cli");
  if (!(await fs.pathExists(cli))) {
    throw new Error(`Build finished but ${cli} wasn't produced. Files copied: ${builtFiles.join(", ") || "(none)"}`);
  }
  await fs.chmod(cli, 0o755).catch(() => {});

  return {
    binary: { path: cli, name: "llama-cli", source: "source-build" },
    accel: { backend: useCuda ? "cuda" : "cpu", name: useCuda ? accelCandidate.name : null },
  };
}

interface InstallLlamaOptions {
  mode?: InstallMode;
  onLog?: LogCallback;
  onProgress?: DownloadProgressCallback | null;
  onStep?: StepCallback;
}

/** Installs llama.cpp for this platform into `root`, writing vno-install.json. */
export async function installLlamaCpp({
  mode = "local",
  onLog = () => {},
  onProgress = null,
  onStep = () => {},
}: InstallLlamaOptions = {}): Promise<InstallManifest> {
  const root = resolveInstallRoot(mode);
  const platform = os.platform();

  let outcome: InstallOutcome;
  if (isMac) outcome = await installMacBinary();
  else if (isWindows) outcome = await installWindowsBinary(root, { onLog, onProgress });
  else outcome = await installLinuxBinary(root, { onLog, onStep, onProgress });

  const existing = (await readManifest(root)) || {};
  const manifest: InstallManifest = {
    ...existing,
    version: LLAMACPP_VERSION,
    platform,
    arch: os.arch(),
    mode,
    binary: outcome.binary,
    accel: outcome.accel,
    installedAt: new Date().toISOString(),
  };
  await writeManifest(root, manifest);
  await ensureGitignoreEntry(ENGINE, mode);
  return manifest;
}

// ---------------------------------------------------------------------------
// Model resolution & download
// ---------------------------------------------------------------------------

/** One curated summarization model vno knows how to fetch by a friendly alias. */
interface ModelAlias {
  repo: string;
  filename: string;
  /**
   * Exact download size in bytes, straight from Hugging Face's
   * `Content-Length` - kept for display in pickers and as a fallback sanity
   * check when `sha256` is unset, but `sha256` is what actually decides
   * validity when both are present.
   */
  size?: number;
  /**
   * The file's SHA-256, straight from Hugging Face's `X-Linked-ETag` header
   * (the LFS blob hash, not a guess) - `validateModelFile` hashes the
   * download and compares against this rather than trusting size alone,
   * which can't tell a truncated/corrupted download from a genuine one at
   * the same byte count.
   */
  sha256?: string;
  /** Short freeform note shown next to the size in pickers, e.g. context window. */
  note?: string;
}

// A short, deliberately small starting set - reasonable size/quality
// tradeoffs for local, CPU-friendly summarization. This is a convenience
// catalog only: any .gguf file dropped into llama-cpp/models/ is discovered
// by `listModels`/`resolveModel` without needing an entry here.
//
// size/sha256 below were read directly off Hugging Face's response headers
// for each file's resolve/main URL (Content-Length and X-Linked-ETag) on
// 2026-08-25, not guessed - see the sha256 doc comment on ModelAlias.
//
// Order is the picker order, so the smallest capable model comes first: for
// "compress a transcript into a few sentences" the ceiling is set by
// instruction-following and context, not parameter count, and every hour
// spent on a bigger download is one the user waits through. Deliberately
// absent: the reasoning variants (Phi-4-mini-reasoning, Phi-4-reasoning-plus,
// the Qwen3 *-Thinking builds), which emit their chain of thought into
// stdout - wrong shape entirely for something written straight to a
// .summary.txt sidecar.
const LLAMA_MODEL_ALIASES: Record<string, ModelAlias> = {
  "phi4-mini": {
    repo: "unsloth/Phi-4-mini-instruct-GGUF",
    filename: "Phi-4-mini-instruct-Q4_K_M.gguf",
    size: 2_491_874_272,
    sha256: "88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a",
    note: "131K context",
  },
  "gemma4-e2b": {
    repo: "unsloth/gemma-4-E2B-it-GGUF",
    filename: "gemma-4-E2B-it-Q4_K_M.gguf",
    size: 3_106_738_272,
    sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
    note: "131K context",
  },
  "gemma4-e4b": {
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    filename: "gemma-4-E4B-it-Q4_K_M.gguf",
    size: 4_977_171_584,
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
    note: "131K context",
  },
  "qwen2.5-3b": {
    repo: "Qwen/Qwen2.5-3B-Instruct-GGUF",
    filename: "qwen2.5-3b-instruct-q4_k_m.gguf",
    size: 2_104_932_768,
    sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
  },
  "llama3.2-3b": {
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    filename: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    size: 2_019_377_696,
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
  },
};

/** The curated aliases, for a picker UI (CLI wizard, settings dropdown, --list-models). */
export function listModelAliases(): { alias: string; repo: string; filename: string; size?: number; note?: string }[] {
  return Object.entries(LLAMA_MODEL_ALIASES).map(([alias, m]) => ({ alias, ...m }));
}

/**
 * Normalizes anything a caller might pass - a curated alias ("qwen2.5-3b"),
 * a bare filename, or a path - into `{ filename, path }`. Unlike whisper's
 * ggml stem convention, a llama.cpp GGUF keeps its upstream filename as-is;
 * only curated aliases get a name→filename translation.
 */
function normalizeModelName(name: string): { filename: string; explicitPath: string | null } {
  const raw = String(name).trim();
  if (raw.includes("/") || raw.includes("\\")) {
    return { filename: path.basename(raw), explicitPath: raw };
  }
  const alias = LLAMA_MODEL_ALIASES[raw];
  return { filename: alias ? alias.filename : raw, explicitPath: null };
}

/** Why a model file was rejected, or how big it is if it passed. */
export interface ModelValidation {
  valid: boolean;
  reason?: string;
  size?: number;
}

/** Streaming SHA-256 of a file - avoids loading multi-GB models into memory. */
async function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/**
 * Whether a .gguf file at `filePath` is genuinely usable: readable, valid
 * GGUF magic bytes, and - when the filename matches a curated alias - its
 * SHA-256 matches exactly. Size alone can't catch a truncated-but-plausible
 * download (see the note on ModelAlias.sha256); a hash mismatch is checked
 * whenever one's known, with the old ~10% size tolerance kept only as a
 * fallback for a curated alias that doesn't have a recorded hash yet. A
 * dropped-in model whose filename isn't a curated alias skips both checks
 * but still needs valid magic bytes.
 */
export async function validateModelFile(filePath: string): Promise<ModelValidation> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return { valid: false, reason: "not readable" };
  }
  if (!stats.isFile() || stats.size === 0) return { valid: false, reason: "empty or not a file" };

  const filename = path.basename(filePath);
  const alias = Object.values(LLAMA_MODEL_ALIASES).find((m) => m.filename === filename);

  if (!alias?.sha256 && alias?.size && Math.abs(stats.size - alias.size) / alias.size > 0.1) {
    return { valid: false, reason: `size ${stats.size} is far from the expected ~${alias.size} bytes` };
  }

  const handle = await fs.open(filePath, "r").catch(() => null);
  if (handle === null) return { valid: false, reason: "not readable" };
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await fs.read(handle, buffer, 0, 4, 0);
    if (bytesRead < 4) return { valid: false, reason: "too short to contain a header" };
    if (buffer.toString("ascii") !== "GGUF") return { valid: false, reason: "missing GGUF magic bytes - likely an HTML stub" };
  } finally {
    await fs.close(handle);
  }

  if (alias?.sha256) {
    const actual = await sha256File(filePath);
    if (actual !== alias.sha256) {
      return { valid: false, reason: `sha256 ${actual} doesn't match the expected ${alias.sha256}` };
    }
  }

  return { valid: true, size: stats.size };
}

/**
 * Finds an already-present model: an explicit path or `VNO_LLAMA_MODEL_PATH`
 * override, the local install's models/, the global install's models/, or
 * any absolute path a previous run recorded in either vno-install.json.
 * Mirrors whisper.cpp's `resolveModel` - never downloads.
 */
export async function resolveModel(name: string): Promise<string | null> {
  const { filename, explicitPath } = normalizeModelName(name);

  const candidates: string[] = [];

  if (explicitPath) candidates.push(explicitPath);

  const envOverride = process.env.VNO_LLAMA_MODEL_PATH;
  if (envOverride) {
    const stats = await fs.stat(envOverride).catch(() => null);
    candidates.push(stats?.isDirectory() ? path.join(envOverride, filename) : envOverride);
  }

  for (const root of bothInstallRoots()) {
    candidates.push(path.join(installPaths(root).modelsDir, filename));
    const manifest = await readManifest(root);
    const recorded = manifest?.models?.[filename];
    if (recorded) candidates.push(recorded);
  }

  for (const candidate of candidates) {
    if (!(await fs.pathExists(candidate))) continue;
    const result = await validateModelFile(candidate);
    if (result.valid) return path.resolve(candidate);
  }
  return null;
}

interface DownloadModelOptions {
  mode?: InstallMode;
  onProgress?: DownloadProgressCallback | null;
  onLog?: LogCallback;
}

/**
 * Downloads a curated model by alias that `resolveModel` couldn't find, into
 * the given install root's models/ directory. Only curated aliases are
 * downloadable - an arbitrary filename with no known repo/filename pair has
 * nothing to fetch from, matching whisper.cpp's "explicit path has nothing
 * to download" behavior for the analogous case.
 */
export async function downloadModel(
  name: string,
  { mode = "local", onProgress = null, onLog = () => {} }: DownloadModelOptions = {}
): Promise<string> {
  const alias = LLAMA_MODEL_ALIASES[name];
  if (!alias) {
    throw new Error(`"${name}" isn't a known model alias - nothing to download. Known: ${Object.keys(LLAMA_MODEL_ALIASES).join(", ")}`);
  }

  const existing = await resolveModel(name);
  if (existing) return existing;

  const root = resolveInstallRoot(mode);
  const { modelsDir } = installPaths(root);
  const destPath = path.join(modelsDir, alias.filename);
  const sources = llamaModelSources(alias.repo);
  const failures: string[] = [];

  for (const source of sources) {
    const url = `${source.base}/${alias.filename}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      onLog(`Downloading ${alias.filename}${attempt > 1 ? " (retry)" : ""} from ${source.label}...`);
      try {
        await downloadFile(url, destPath, { onProgress });
      } catch (err) {
        failures.push(`${source.label}: ${errorMessage(err)}`);
        break;
      }

      const result = await validateModelFile(destPath);
      if (result.valid) {
        const manifest = (await readManifest(root)) || {};
        manifest.models = { ...manifest.models, [alias.filename]: destPath };
        await writeManifest(root, manifest);
        return destPath;
      }

      onLog(`Downloaded file failed validation (${result.reason}); deleting and retrying.`);
      await fs.remove(destPath);
      await fs.remove(`${destPath}.part`).catch(() => {});
      if (attempt === 2) failures.push(`${source.label}: failed validation twice (${result.reason})`);
    }
  }

  throw new Error(
    `Could not download ${alias.filename} from any source.\n` +
      failures.map((f) => `  - ${f}`).join("\n") +
      `\nTry again later, or set VNO_LLAMA_MODEL_BASE to a mirror you can reach.`
  );
}

/** One .gguf model file found on disk, wherever it lives. */
export interface ModelEntry {
  /** The install root it sits in, or "VNO_LLAMA_MODEL_PATH". */
  label: string;
  path: string;
  filename: string;
  size: number | null;
  valid: boolean;
  reason: string | null;
}

/**
 * An inventory of every .gguf file under either install root's models/
 * (plus VNO_LLAMA_MODEL_PATH, if set) - the actual "drop-in a model" support:
 * any file matching `*.gguf` is discovered here whether or not it's one of
 * the curated aliases. Doesn't touch the network.
 */
export async function listModels(): Promise<ModelEntry[]> {
  const seen = new Set<string>();
  const entries: ModelEntry[] = [];

  const check = async (label: string, filePath: string) => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (!(await fs.pathExists(resolved))) return;
    const result = await validateModelFile(resolved);
    const stats = await fs.stat(resolved).catch(() => null);
    entries.push({
      label,
      path: resolved,
      filename: path.basename(resolved),
      size: stats?.size ?? null,
      valid: result.valid,
      reason: result.reason || null,
    });
  };

  for (const root of bothInstallRoots()) {
    const { modelsDir } = installPaths(root);
    const files = await fs.readdir(modelsDir).catch(() => []);
    for (const file of files) {
      if (!/\.gguf$/i.test(file)) continue;
      await check(root, path.join(modelsDir, file));
    }
  }

  if (process.env.VNO_LLAMA_MODEL_PATH) {
    const envPath = process.env.VNO_LLAMA_MODEL_PATH;
    const stats = await fs.stat(envPath).catch(() => null);
    if (stats?.isFile()) {
      await check("VNO_LLAMA_MODEL_PATH", envPath);
    } else if (stats?.isDirectory()) {
      const files = await fs.readdir(envPath).catch(() => []);
      for (const file of files) {
        if (!/\.gguf$/i.test(file)) continue;
        await check("VNO_LLAMA_MODEL_PATH", path.join(envPath, file));
      }
    }
  }

  return entries;
}
