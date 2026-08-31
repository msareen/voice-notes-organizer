import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import { which, detectPackageManager, runStep } from "../setup.ts";
import type { AccelBackend } from "../../types.ts";
import type { InstallStep } from "../setup.ts";
import {
  WHISPERCPP_VERSION,
  WHISPERCPP_REPO,
  HOMEBREW_URL,
  whispercppReleaseTagUrl,
  whispercppReleaseApiUrl,
  whispercppReleaseAssetUrl,
  whispercppCloneUrl,
  modelSources,
  whisperModelCatalog,
  WHISPER_DEFAULT_MODELS,
  vadModelSources,
  WHISPER_VAD_MODEL,
} from "../webSources/whisperModels.ts";
import {
  isWindows,
  isMac,
  errorMessage,
  findFile,
  probeCommand,
  downloadFile,
  sha256File,
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
} from "../engineInstall.ts";
import type {
  InstallMode,
  BinaryRecord,
  AccelRecord,
  InstallManifest,
  InstallLayout,
  EngineRoot,
  AccelCandidate,
  DownloadProgress,
  DownloadProgressCallback,
  ModelRemoval,
  ChecksumMismatchHandler,
} from "../engineInstall.ts";

/**
 * Installing and resolving the whisper.cpp binary, its models and the
 * vno-install.json manifest that records what `vno setup` found or built.
 *
 * Mirrors lib/setup.ts's own rule: this module only *knows* things -
 * detection, acquisition, manifest bookkeeping. Asking the user anything
 * (which mode, whether to install, whether to delete stale files) lives in
 * cli/setup.ts.
 *
 * The generic parts of this (root/manifest handling, download, archive
 * extraction, GPU detection) live in lib/engineInstall.ts, shared with
 * lib/llama/llamacpp.ts - everything below is whisper.cpp-specific: per-platform
 * asset picking, the model alias/size tables, and the ggml-*.bin naming
 * convention.
 */

// Purely informational - never read back by vno itself. Explains the file to
// someone who stumbles on it inside whisper-cpp/ and might otherwise assume
// it's a whisper.cpp artifact rather than vno's own bookkeeping.
const MANIFEST_DESCRIPTION =
  "This file is written and read by vno (the voice-note-organizer CLI), not by whisper.cpp itself. " +
  "It records what `vno setup` found or installed in this folder (the binary, its accelerator, and any " +
  "models downloaded here) so future runs don't have to redetect it. Safe to delete - vno recreates it " +
  "the next time `vno setup` runs. Not read for anything vno can't re-derive on its own.";

const ENGINE: EngineRoot = { folderName: "whisper-cpp", manifestDescription: MANIFEST_DESCRIPTION };

export type { InstallMode, BinaryRecord, AccelRecord, InstallManifest, InstallLayout };

/** Where whisper-cpp/ lives for the given mode. */
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

/**
 * The models/ folder to show the user - whichever install root already has
 * one on disk (local first), or the local root's folder (created if
 * missing) when neither does yet, so "Show models folder" always opens
 * somewhere real rather than erroring on a fresh install.
 */
export async function resolveModelsDir(): Promise<string> {
  for (const root of bothInstallRoots()) {
    const { modelsDir } = installPaths(root);
    if (await fs.pathExists(modelsDir)) return modelsDir;
  }
  const { modelsDir } = installPaths(resolveInstallRoot("local"));
  await fs.ensureDir(modelsDir);
  return modelsDir;
}

/** Whether vno installed this model itself, and may therefore delete it. */
export function isManagedModel(filePath: string): boolean {
  return isEngineManagedModel(ENGINE, filePath);
}

/** Deletes one vno-installed model file. Refuses anything `isManagedModel` rejects. */
export async function removeModel(filePath: string): Promise<ModelRemoval> {
  return removeEngineModel(ENGINE, filePath);
}

const BINARY_NAMES = isWindows
  ? ["whisper-cli.exe"]
  : ["whisper-cpp", "whisper-cli"];

/** Where the whisper.cpp binary was found, and which root it belongs to. */
export interface ResolvedBinary {
  path: string;
  name: string;
  source: string;
  /** null when it came off PATH rather than an install root. */
  root: string | null;
}

/**
 * Finds the whisper.cpp binary: whichever install root's `vno-install.json` is
 * newest, then the other root, then PATH under any known spelling. Binary
 * name isn't hardcoded to one install method - Homebrew calls it
 * `whisper-cpp`, the Windows zip and a Linux source build both call it
 * `whisper-cli`(.exe) - so every name is tried everywhere.
 *
 * "Newest wins" (not "local always first") matters once both roots have ever
 * been used - e.g. a local install from before `--global` was chosen, or
 * from an earlier `vno setup` run. Without it, a fresh `vno setup --global`
 * would silently keep resolving to a stale local install that happens to sit
 * first in a fixed search order, and models would then download into the
 * wrong root's `models/` to match. Ties (typically: neither has run yet)
 * fall back to `mode`'s root first.
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

// Every name whisper.cpp's binary is known to go by, across install methods -
// used when searching a user-given directory, where the platform that built
// it isn't necessarily the convention to assume.
const ALL_BINARY_NAMES = ["whisper-cpp", "whisper-cli", "whisper-cli.exe"];

/**
 * Points vno at a whisper.cpp binary the user already has, instead of
 * installing one. `inputPath` can be the binary itself or a folder
 * containing it (searched for any known binary name). Never copies the file
 * - the resolved absolute path is recorded in vno-install.json, the same
 * reference-don't-copy approach `resolveModel` uses for a model found outside
 * the active install root.
 */
export async function registerExternalBinary(
  inputPath: string,
  opts: { mode?: InstallMode; backend?: AccelRecord["backend"]; name?: string | null } = {}
): Promise<InstallManifest> {
  return registerExternalEngineBinary(ENGINE, ALL_BINARY_NAMES, WHISPERCPP_VERSION, inputPath, opts);
}

export type { AccelCandidate, DownloadProgress, DownloadProgressCallback };
export { detectAccelCandidate, downloadFile, extractTarGz, extractZip };

// ---------------------------------------------------------------------------
// Per-platform binary acquisition
// ---------------------------------------------------------------------------

/** What a per-platform install returns for the manifest to record. */
export interface InstallOutcome {
  binary: BinaryRecord;
  accel: AccelRecord;
}

/**
 * macOS: Homebrew only, never a source build. The formula ships with Metal
 * enabled, so this is already GPU-accelerated on Apple silicon with no
 * cmake/Xcode/clone.
 */
export async function installMacBinary(): Promise<InstallOutcome> {
  if (!(await which("brew"))) {
    throw new Error(
      `Homebrew isn't installed. Get it from ${HOMEBREW_URL}, then run \`vno setup\` again.`
    );
  }
  const result = await runStep({ command: "brew", args: ["install", "whisper-cpp"] });
  if (!result.ok) throw new Error(`brew install whisper-cpp failed:\n${result.output}`);

  const resolved = await which("whisper-cpp");
  if (!resolved) throw new Error("brew install whisper-cpp succeeded but whisper-cpp still isn't on PATH.");

  return {
    binary: { path: resolved, name: "whisper-cpp", source: "homebrew" },
    accel: { backend: "metal", name: "Apple Metal" },
  };
}

/** One downloadable file from a GitHub release. */
interface ReleaseAsset {
  name: string;
  url: string;
}

/**
 * Fetches the whisper.cpp release manifest from GitHub's API. Unauthenticated
 * requests are rate-limited (60/hour/IP), so a 403 falls back to a pinned
 * asset-name guess rather than crashing - logged loudly, since a guess that's
 * wrong needs to be visible.
 */
async function fetchReleaseAssets(version: string): Promise<ReleaseAsset[] | null> {
  const url = whispercppReleaseApiUrl(version);
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (response.status === 403) {
    return null; // rate-limited - caller falls back to a pinned name
  }
  if (!response.ok) {
    throw new Error(`Couldn't list whisper.cpp ${version} release assets: ${response.status} ${response.statusText}`);
  }
  const release = (await response.json()) as { assets?: { name: string; browser_download_url: string }[] };
  return (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
}

interface PickedAsset {
  asset: ReleaseAsset;
  backend: AccelBackend;
}

/**
 * Picks a Windows asset by CUDA runtime version, not by guessing a substring
 * match against whatever the release happens to be named this time. As of
 * v1.9.2 the real asset list is:
 *
 *   whisper-cublas-11.8.0-bin-x64.zip   CUDA, bundles its own 11.8 runtime
 *   whisper-cublas-12.4.0-bin-x64.zip   CUDA, bundles its own 12.4 runtime
 *   whisper-blas-bin-x64.zip            CPU, BLAS-accelerated (no GPU needed)
 *   whisper-bin-x64.zip                 CPU, plain
 *   whisper-bin-Win32.zip / whisper-blas-bin-Win32.zip   32-bit, unused here
 *   whisper-v1.9.2-xcframework.zip      an Xcode library, not a CLI - never select
 *
 * There is no Vulkan asset for any platform, so AMD/Intel GPUs on Windows get
 * BLAS (CPU-executed, still faster than plain) rather than acceleration.
 * Both CUDA zips bundle their own runtime DLLs, so picking between them is a
 * driver-version question, not a toolkit-version one - see
 * `detectAccelCandidate`. NVIDIA drivers run older CUDA runtimes than they
 * report supporting (backward compatible), so a driver reporting 12.4+ takes
 * the 12.4 build, one reporting 11.x-<12.4 takes the 11.8 build, and
 * anything older (or undetermined) falls back to BLAS rather than risk a
 * mismatched CUDA zip, which fails opaquely at model load.
 */
function pickWindowsAsset(assets: ReleaseAsset[], accel: AccelCandidate): PickedAsset | null {
  const exact = (name: string) => assets.find((a) => a.name === name);

  if (accel.backend === "cuda" && accel.cudaVersion) {
    const major = parseInt(accel.cudaVersion.split(".")[0], 10);
    if (Number.isFinite(major)) {
      if (major >= 12) {
        const asset = exact("whisper-cublas-12.4.0-bin-x64.zip");
        if (asset) return { asset, backend: "cuda" };
      }
      if (major >= 11) {
        const asset = exact("whisper-cublas-11.8.0-bin-x64.zip");
        if (asset) return { asset, backend: "cuda" };
      }
      // Driver too old for either bundled CUDA runtime - BLAS/CPU below.
    }
  }

  const blas = exact("whisper-blas-bin-x64.zip") || assets.find((a) => /^whisper-blas-bin-x64/i.test(a.name));
  if (blas) return { asset: blas, backend: "cpu" };

  const cpu = exact("whisper-bin-x64.zip") || assets.find((a) => /^whisper-bin-x64/i.test(a.name));
  if (cpu) return { asset: cpu, backend: "cpu" };

  return null;
}

// Used only when the GitHub API is rate-limited (403). Best-effort: logged as
// a guess, and the caller reports available names if it's wrong.
const PINNED_WINDOWS_FALLBACK: Record<string, string> = {
  "cuda-12": "whisper-cublas-12.4.0-bin-x64.zip",
  "cuda-11": "whisper-cublas-11.8.0-bin-x64.zip",
  cpu: "whisper-blas-bin-x64.zip",
};

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
      : "No NVIDIA GPU detected; using the BLAS-accelerated CPU build."
  );

  const assets = await fetchReleaseAssets(WHISPERCPP_VERSION);
  let picked: PickedAsset;
  let usedPinnedFallback = false;

  if (assets) {
    const found = pickWindowsAsset(assets, accelCandidate);
    if (!found) {
      throw new Error(
        `No matching Windows asset found in whisper.cpp ${WHISPERCPP_VERSION}. Available assets:\n` +
          assets.map((a) => `  - ${a.name}`).join("\n")
      );
    }
    picked = found;
  } else {
    usedPinnedFallback = true;
    const major = accelCandidate.cudaVersion ? parseInt(accelCandidate.cudaVersion.split(".")[0], 10) : null;
    const pinnedKey =
      accelCandidate.backend === "cuda" && major !== null && major >= 12
        ? "cuda-12"
        : accelCandidate.backend === "cuda" && major !== null && major >= 11
          ? "cuda-11"
          : "cpu";
    const name = PINNED_WINDOWS_FALLBACK[pinnedKey];
    const backend: AccelBackend = pinnedKey === "cpu" ? "cpu" : "cuda";
    onLog(
      `GitHub's API is rate-limited right now, so falling back to a pinned asset name (${name}). ` +
        `If this is wrong, run \`vno setup\` again later or check ${whispercppReleaseTagUrl()} yourself.`
    );
    picked = {
      asset: { name, url: whispercppReleaseAssetUrl(name) },
      backend,
    };
  }

  onLog(`Chosen asset: ${picked.asset.name} (${picked.backend}${usedPinnedFallback ? ", pinned guess" : ""})`);

  const { binDir } = installPaths(root);
  await fs.ensureDir(binDir);
  const zipPath = path.join(os.tmpdir(), `vno-whispercpp-${Date.now()}.zip`);
  await downloadFile(picked.asset.url, zipPath, { onProgress });
  try {
    await extractZip(zipPath, binDir);
  } finally {
    await fs.remove(zipPath);
  }

  const exe = await findFile(binDir, "whisper-cli.exe");
  if (!exe) {
    throw new Error(`Extracted ${picked.asset.name} but couldn't find whisper-cli.exe inside ${binDir}.`);
  }

  return {
    binary: { path: exe, name: "whisper-cli.exe", source: "release-zip", asset: picked.asset.name },
    accel: { backend: picked.backend, name: accelCandidate.name },
  };
}

interface LinuxInstallOptions {
  onLog?: LogCallback;
  onStep?: StepCallback;
  onProgress?: DownloadProgressCallback | null;
}

/**
 * Linux: a prebuilt CPU tarball exists (`whisper-bin-ubuntu-x64.tar.gz` /
 * `-arm64.tar.gz`) and is used whenever there's no GPU to build CUDA support
 * for - no compiler needed, no wait. There's no prebuilt CUDA asset for
 * Linux though, so a detected NVIDIA GPU means building from source with
 * `-DGGML_CUDA=ON`, same as before. Either way, never runs anything needing
 * sudo; a missing build-essential/cmake (only relevant for the source path)
 * prints the exact command for the detected package manager and stops.
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

/** The CPU-only prebuilt tarball - the fast path when there's no GPU to build for. */
async function installLinuxPrebuilt(
  root: string,
  { onLog, onProgress }: { onLog: LogCallback; onProgress: DownloadProgressCallback | null }
): Promise<InstallOutcome> {
  const assetName = os.arch() === "arm64" ? "whisper-bin-ubuntu-arm64.tar.gz" : "whisper-bin-ubuntu-x64.tar.gz";

  const assets = await fetchReleaseAssets(WHISPERCPP_VERSION);
  let url: string;
  if (assets) {
    const found = assets.find((a) => a.name === assetName);
    if (!found) throw new Error(`no ${assetName} in the ${WHISPERCPP_VERSION} release`);
    url = found.url;
  } else {
    onLog(`GitHub's API is rate-limited right now, falling back to a pinned URL for ${assetName}.`);
    url = whispercppReleaseAssetUrl(assetName);
  }

  onLog(`Downloading ${assetName}...`);
  const { binDir } = installPaths(root);
  await fs.ensureDir(binDir);
  const tarPath = path.join(os.tmpdir(), `vno-whispercpp-${Date.now()}.tar.gz`);
  await downloadFile(url, tarPath, { onProgress });
  try {
    await extractTarGz(tarPath, binDir);
  } finally {
    await fs.remove(tarPath);
  }

  // Older whisper.cpp releases named the CLI `main`; current ones use
  // `whisper-cli`. Try both rather than pin to one.
  const cli = (await findFile(binDir, "whisper-cli")) || (await findFile(binDir, "main"));
  if (!cli) {
    throw new Error(`extracted ${assetName} but found no whisper.cpp binary inside ${binDir}`);
  }
  await fs.chmod(cli, 0o755).catch(() => {});

  return {
    binary: { path: cli, name: path.basename(cli), source: "release-tarball", asset: assetName },
    accel: { backend: "cpu", name: null },
  };
}

/** The `cmake` source build - required for CUDA (no prebuilt Linux CUDA asset), fallback otherwise. */
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
        ? `sudo apt-get install -y ${missing.map((m) => (m === "build-essential" ? "build-essential" : m)).join(" ")}`
        : manager?.id === "dnf"
          ? `sudo dnf install -y cmake git gcc-c++`
          : `install ${missing.join(", ")} with your distro's package manager`;
    throw new Error(
      `Building whisper.cpp needs ${missing.join(", ")}, which ${missing.length > 1 ? "aren't" : "isn't"} installed.\n` +
        `Run this yourself (vno won't sudo on your behalf):\n  ${installHint}`
    );
  }

  const cloneDir = path.join(os.tmpdir(), `vno-whispercpp-src-${Date.now()}`);

  const cloneStep: InstallStep = {
    command: "git",
    args: ["clone", "--depth", "1", "--branch", WHISPERCPP_VERSION, whispercppCloneUrl(), cloneDir],
  };
  onLog(`Cloning whisper.cpp ${WHISPERCPP_VERSION}...`);
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

  const cli = path.join(binDir, "whisper-cli");
  if (!(await fs.pathExists(cli))) {
    throw new Error(`Build finished but ${cli} wasn't produced. Files copied: ${builtFiles.join(", ") || "(none)"}`);
  }
  await fs.chmod(cli, 0o755).catch(() => {});

  return {
    binary: { path: cli, name: "whisper-cli", source: "source-build" },
    accel: { backend: useCuda ? "cuda" : "cpu", name: useCuda ? accelCandidate.name : null },
  };
}

interface InstallWhisperOptions {
  mode?: InstallMode;
  onLog?: LogCallback;
  onProgress?: DownloadProgressCallback | null;
  onStep?: StepCallback;
}

/**
 * Installs whisper.cpp for this platform into `root`, writing vno-install.json.
 * `mode` is recorded so `resolveModel` below can tell which root a manifest
 * came from without re-deriving it.
 */
export async function installWhisperCpp({
  mode = "local",
  onLog = () => {},
  onProgress = null,
  onStep = () => {},
}: InstallWhisperOptions = {}): Promise<InstallManifest> {
  const root = resolveInstallRoot(mode);
  const platform = os.platform();

  let outcome: InstallOutcome;
  if (isMac) outcome = await installMacBinary();
  else if (isWindows) outcome = await installWindowsBinary(root, { onLog, onProgress });
  else outcome = await installLinuxBinary(root, { onLog, onStep, onProgress });

  const existing = (await readManifest(root)) || {};
  const manifest: InstallManifest = {
    ...existing,
    version: WHISPERCPP_VERSION,
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

// Every ggml-*.bin this project knows about now lives in one place -
// webSources/whisperModels.ts:whisperModelCatalog - shared with llama.cpp's catalog shape.
// The three tables below are just that catalog reshaped into the lookups the
// rest of this file wants; nothing here is hand-maintained.
const WHISPER_CATALOG = whisperModelCatalog();

// Friendly names this project already uses (matching the model picker in
// cli/transcribe.ts and the web MODELS list), plus their ggml filenames.
// Anything not in this map falls through to `ggml-<name>.bin` so quantized
// and less common variants (small.en-q5_1, large-v3-turbo-q8_0, ...) still work.
const MODEL_ALIASES: Record<string, string> = Object.fromEntries(
  WHISPER_CATALOG.flatMap((m) => (m.aliases || []).map((alias) => [alias, m.stem] as const))
);

// Approximate sizes for the models this project offers by default, used only
// as a sanity check (~10% tolerance) against a corrupt or truncated download.
// Anything outside this table skips the size check but still gets the magic-
// byte and readability checks.
const MODEL_SIZES: Record<string, number> = Object.fromEntries(
  WHISPER_CATALOG.map((m) => [m.stem, m.approxBytes] as const)
);

// SHA-256 of each ggml-*.bin - see WhisperModelSource's doc comment in
// webSources/interfaces.ts for provenance. Checked once, right after download - see
// downloadModel below. A stem missing here just skips the check, same as a
// missing MODEL_SIZES entry skips the size check.
const MODEL_SHA256: Record<string, string> = Object.fromEntries(
  WHISPER_CATALOG.filter((m) => m.sha256).map((m) => [m.stem, m.sha256 as string] as const)
);

/**
 * Normalizes anything a caller might pass - a bare alias ("turbo"), a ggml
 * stem ("large-v3-turbo"), a full filename ("ggml-small.bin") or a path -
 * into `{ filename, path }`. `path` is set only when the input already looked
 * like a path (absolute, or containing a separator); resolution below still
 * applies to a bare filename or alias.
 */
function normalizeModelName(name: string): { filename: string; explicitPath: string | null } {
  const raw = String(name).trim();
  if (raw.includes("/") || raw.includes("\\")) {
    return { filename: path.basename(raw).replace(/^ggml-/, "").replace(/\.bin$/i, ""), explicitPath: raw };
  }
  const stem = raw.replace(/^ggml-/, "").replace(/\.bin$/i, "");
  const canonical = MODEL_ALIASES[stem] || stem;
  return { filename: canonical, explicitPath: null };
}

const modelFileName = (stem: string) => `ggml-${stem}.bin`;

/** Why a model file was rejected, or how big it is if it passed. */
export interface ModelValidation {
  valid: boolean;
  reason?: string;
  size?: number;
}

/**
 * Whether a model file at `filePath` is genuinely usable, not just present:
 * size within ~10% of what's expected (when known), GGML/GGUF magic bytes,
 * and readable. This is what catches the classic failure mode - an HTML
 * redirect stub saved as if it were the model - before it becomes an opaque
 * error at load time.
 */
export async function validateModelFile(filePath: string, stem: string): Promise<ModelValidation> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return { valid: false, reason: "not readable" };
  }
  if (!stats.isFile() || stats.size === 0) return { valid: false, reason: "empty or not a file" };

  const expected = MODEL_SIZES[stem];
  if (expected && Math.abs(stats.size - expected) / expected > 0.1) {
    return { valid: false, reason: `size ${stats.size} is far from the expected ~${expected} bytes` };
  }

  const handle = await fs.open(filePath, "r").catch(() => null);
  if (handle === null) return { valid: false, reason: "not readable" };
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await fs.read(handle, buffer, 0, 4, 0);
    if (bytesRead < 4) return { valid: false, reason: "too short to contain a header" };
    const isGguf = buffer.toString("ascii") === "GGUF";
    const isGgml = buffer.readUInt32LE(0) === 0x67676d6c;
    if (!isGguf && !isGgml) return { valid: false, reason: "missing GGML/GGUF magic bytes - likely an HTML stub" };
  } finally {
    await fs.close(handle);
  }
  return { valid: true, size: stats.size };
}

/**
 * Finds an already-present model, checking (in order): an explicit path or
 * `WHISPER_MODEL_PATH` override, the local install's models/, the global
 * install's models/, any absolute path a previous run recorded in either
 * vno-install.json, then Homebrew's shared dir on macOS. Both install roots are
 * always checked regardless of which is active, so a global install from
 * last month and a local one today don't each re-fetch the same gigabytes.
 *
 * Returns an absolute path, or null if nothing valid was found - resolution
 * never downloads, that's `downloadModel`'s job.
 */
export async function resolveModel(name: string): Promise<string | null> {
  const { filename: stem, explicitPath } = normalizeModelName(name);
  const targetName = modelFileName(stem);

  const candidates: string[] = [];

  if (explicitPath) candidates.push(explicitPath);

  const envOverride = process.env.WHISPER_MODEL_PATH;
  if (envOverride) {
    const stats = await fs.stat(envOverride).catch(() => null);
    candidates.push(stats?.isDirectory() ? path.join(envOverride, targetName) : envOverride);
  }

  for (const root of bothInstallRoots()) {
    candidates.push(path.join(installPaths(root).modelsDir, targetName));
    const manifest = await readManifest(root);
    const recorded = manifest?.models?.[stem];
    if (recorded) candidates.push(recorded);
  }

  if (isMac) {
    const brewPrefix = await probeCommand("brew", ["--prefix"]);
    if (brewPrefix) candidates.push(path.join(brewPrefix, "share", "whisper-cpp", targetName));
  }

  for (const candidate of candidates) {
    if (!(await fs.pathExists(candidate))) continue;
    const result = await validateModelFile(candidate, stem);
    if (result.valid) return path.resolve(candidate);
  }
  return null;
}

interface DownloadModelOptions {
  mode?: InstallMode;
  onProgress?: DownloadProgressCallback | null;
  onLog?: LogCallback;
  /**
   * Asked only if MODEL_SHA256 has an entry for this model and the download
   * doesn't match it - see ChecksumMismatchHandler's doc comment. Omitted
   * entirely, a mismatch is logged and the file is kept rather than silently
   * deleted.
   */
  onChecksumMismatch?: ChecksumMismatchHandler;
}

/**
 * Downloads a model that `resolveModel` couldn't find, into the given
 * install root's models/ directory. A file that fails validation once is
 * deleted and re-fetched exactly once rather than reused - an interrupted
 * earlier run must never look like a completed one. When MODEL_SHA256 knows
 * this model's checksum, it's verified once here, right after the download -
 * never on every later `listModels()`/`resolveModel()` scan, which would mean
 * re-hashing a multi-gigabyte file on every startup.
 */
export async function downloadModel(
  name: string,
  { mode = "local", onProgress = null, onLog = () => {}, onChecksumMismatch }: DownloadModelOptions = {}
): Promise<string> {
  const { filename: stem, explicitPath } = normalizeModelName(name);
  if (explicitPath) {
    throw new Error(`"${name}" looks like a path, not a model name - nothing to download for an explicit path.`);
  }

  const existing = await resolveModel(name);
  if (existing) return existing;

  const root = resolveInstallRoot(mode);
  const { modelsDir } = installPaths(root);
  const destPath = path.join(modelsDir, modelFileName(stem));
  const sources = modelSources();
  const failures: string[] = [];
  const expectedSha256 = MODEL_SHA256[stem];

  for (const source of sources) {
    const url = `${source.base}/${modelFileName(stem)}`;

    for (let attempt = 1; attempt <= 2; attempt++) {
      onLog(`Downloading ${modelFileName(stem)}${attempt > 1 ? " (retry)" : ""} from ${source.label}...`);
      onLog(`  URL: ${url}`);
      try {
        await downloadFile(url, destPath, { onProgress });
      } catch (err) {
        // A transport failure (blocked, DNS, 403, connection reset) won't fix
        // itself on a second identical request, so move to the next mirror
        // rather than spending another timeout here. The partial `.part` file
        // is deliberately left in place: the mirrors serve byte-identical
        // files, so the next source resumes instead of restarting a download
        // that may already be gigabytes in.
        failures.push(`${source.label}: ${errorMessage(err)}`);
        break;
      }

      const result = await validateModelFile(destPath, stem);
      if (!result.valid) {
        onLog(`Downloaded file failed validation (${result.reason}); deleting and retrying.`);
        await fs.remove(destPath);
        await fs.remove(`${destPath}.part`).catch(() => {});
        if (attempt === 2) failures.push(`${source.label}: failed validation twice (${result.reason})`);
        continue;
      }

      if (expectedSha256) {
        const actual = await sha256File(destPath);
        if (actual.toLowerCase() !== expectedSha256.toLowerCase()) {
          onLog(`Checksum mismatch for ${modelFileName(stem)} (expected ${expectedSha256}, got ${actual}).`);
          const shouldDelete = onChecksumMismatch
            ? await onChecksumMismatch({ filename: modelFileName(stem), expected: expectedSha256, actual })
            : false;
          if (shouldDelete) {
            await fs.remove(destPath);
            await fs.remove(`${destPath}.part`).catch(() => {});
            if (attempt === 2) failures.push(`${source.label}: checksum mismatch (deleted)`);
            continue;
          }
          onLog("Keeping the downloaded file despite the checksum mismatch.");
        }
      }

      const manifest = (await readManifest(root)) || {};
      manifest.models = { ...manifest.models, [stem]: destPath };
      await writeManifest(root, manifest);
      return destPath;
    }
  }

  throw new Error(
    `Could not download ${modelFileName(stem)} from any source.\n` +
      failures.map((f) => `  - ${f}`).join("\n") +
      `\nTry again later, or set VNO_MODEL_BASE to a mirror you can reach.`
  );
}

/** The model names this project ensures are present unless told otherwise. */
export const DEFAULT_MODELS = WHISPER_DEFAULT_MODELS;

/** One model file found on disk, wherever it lives. */
export interface ModelEntry {
  /** The install root it sits in, or "homebrew"/"WHISPER_MODEL_PATH". */
  label: string;
  path: string;
  stem: string;
  size: number | null;
  valid: boolean;
  reason: string | null;
}

/**
 * An inventory of every place a model could live, for `--list-models` and
 * for the before/after report `vno setup` prints. Doesn't touch the network.
 */
export async function listModels(): Promise<ModelEntry[]> {
  const seen = new Set<string>();
  const entries: ModelEntry[] = [];

  const check = async (label: string, filePath: string, stem: string) => {
    const resolved = path.resolve(filePath);
    if (seen.has(resolved)) return;
    seen.add(resolved);
    if (!(await fs.pathExists(resolved))) return;
    const result = await validateModelFile(resolved, stem);
    const stats = await fs.stat(resolved).catch(() => null);
    entries.push({ label, path: resolved, stem, size: stats?.size ?? null, valid: result.valid, reason: result.reason || null });
  };

  for (const root of bothInstallRoots()) {
    const { modelsDir } = installPaths(root);
    const files = await fs.readdir(modelsDir).catch(() => []);
    for (const file of files) {
      if (!/^ggml-.*\.bin$/i.test(file)) continue;
      const stem = file.replace(/^ggml-/, "").replace(/\.bin$/i, "");
      await check(root, path.join(modelsDir, file), stem);
    }
  }

  if (isMac) {
    const brewPrefix = await probeCommand("brew", ["--prefix"]);
    if (brewPrefix) {
      const dir = path.join(brewPrefix, "share", "whisper-cpp");
      const files = await fs.readdir(dir).catch(() => []);
      for (const file of files) {
        if (!/^ggml-.*\.bin$/i.test(file)) continue;
        const stem = file.replace(/^ggml-/, "").replace(/\.bin$/i, "");
        await check("homebrew", path.join(dir, file), stem);
      }
    }
  }

  if (process.env.WHISPER_MODEL_PATH) {
    const envPath = process.env.WHISPER_MODEL_PATH;
    const stats = await fs.stat(envPath).catch(() => null);
    if (stats?.isFile()) {
      const stem = path.basename(envPath).replace(/^ggml-/, "").replace(/\.bin$/i, "");
      await check("WHISPER_MODEL_PATH", envPath, stem);
    } else if (stats?.isDirectory()) {
      const files = await fs.readdir(envPath).catch(() => []);
      for (const file of files) {
        if (!/^ggml-.*\.bin$/i.test(file)) continue;
        const stem = file.replace(/^ggml-/, "").replace(/\.bin$/i, "");
        await check("WHISPER_MODEL_PATH", path.join(envPath, file), stem);
      }
    }
  }

  return entries;
}

export interface StalePythonCache {
  dir: string;
  files: { path: string; size: number }[];
  totalBytes: number;
}

/**
 * The old Python whisper's model cache - PyTorch .pt checkpoints, not usable
 * by whisper.cpp (different format, and the GGML versions are a direct
 * download rather than something worth converting). Reported so a machine
 * that ran Python whisper for a while can reclaim the space; never deleted
 * here - `cli/setup.ts` prompts before removing anything.
 */
export async function findStalePythonCache(): Promise<StalePythonCache> {
  const dir = path.join(os.homedir(), ".cache", "whisper");
  const files = await fs.readdir(dir).catch(() => []);
  const entries: { path: string; size: number }[] = [];
  let totalBytes = 0;
  for (const file of files) {
    if (!file.endsWith(".pt")) continue;
    const filePath = path.join(dir, file);
    const stats = await fs.stat(filePath).catch(() => null);
    if (!stats) continue;
    entries.push({ path: filePath, size: stats.size });
    totalBytes += stats.size;
  }
  return { dir, files: entries, totalBytes };
}

// ---------------------------------------------------------------------------
// The Silero VAD model
// ---------------------------------------------------------------------------
//
// Kept apart from the transcription models above rather than folded into the
// catalog, because almost nothing about it is the same: a different Hugging
// Face repo, under a megabyte instead of gigabytes, no aliases, and it's an
// optional extra that a failed download must never turn into a failed
// transcription. `vno setup` fetches it silently; every read path degrades to
// "no VAD" when it isn't there.

const vadFileName = () => `ggml-${WHISPER_VAD_MODEL.stem}.bin`;

/**
 * The VAD model's path, or null if it isn't installed. Never downloads -
 * that's `downloadVadModel`'s job, and this one is called on the
 * transcription hot path where a network fetch would be a surprise.
 */
export async function resolveVadModel(): Promise<string | null> {
  const envOverride = process.env.WHISPER_VAD_MODEL_PATH;
  const candidates: string[] = [];
  if (envOverride) {
    const stats = await fs.stat(envOverride).catch(() => null);
    candidates.push(stats?.isDirectory() ? path.join(envOverride, vadFileName()) : envOverride);
  }
  for (const root of bothInstallRoots()) {
    candidates.push(path.join(installPaths(root).modelsDir, vadFileName()));
  }
  for (const candidate of candidates) {
    const stats = await fs.stat(candidate).catch(() => null);
    // Only a size sanity check, not validateModelFile: the VAD model is a raw
    // ggml tensor dump without the GGML/GGUF magic the transcription models
    // carry, so the magic-byte test would reject a perfectly good file.
    if (stats?.isFile() && Math.abs(stats.size - WHISPER_VAD_MODEL.approxBytes) / WHISPER_VAD_MODEL.approxBytes < 0.1) {
      return path.resolve(candidate);
    }
  }
  return null;
}

/**
 * Downloads the VAD model if it isn't already there, returning its path - or
 * null if it couldn't be fetched. Deliberately doesn't throw: this is called
 * from `vno setup`, where a blocked mirror should cost the user the optional
 * VAD pre-filter and not the whole install.
 */
export async function downloadVadModel({
  mode = "local",
  onProgress = null,
  onLog = () => {},
}: {
  mode?: InstallMode;
  onProgress?: DownloadProgressCallback | null;
  onLog?: (message: string) => void;
} = {}): Promise<string | null> {
  const existing = await resolveVadModel();
  if (existing) return existing;

  const { modelsDir } = installPaths(resolveInstallRoot(mode));
  const destPath = path.join(modelsDir, vadFileName());
  await fs.ensureDir(modelsDir);

  for (const source of vadModelSources()) {
    const url = `${source.base}/${vadFileName()}`;
    onLog(`Downloading ${vadFileName()} from ${source.label}...`);
    try {
      await downloadFile(url, destPath, { onProgress });
    } catch (err) {
      onLog(`  ${errorMessage(err)}`);
      continue;
    }
    const actual = await sha256File(destPath);
    if (actual.toLowerCase() !== WHISPER_VAD_MODEL.sha256!.toLowerCase()) {
      onLog(`  Checksum mismatch for ${vadFileName()}; discarding.`);
      await fs.remove(destPath).catch(() => {});
      await fs.remove(`${destPath}.part`).catch(() => {});
      continue;
    }
    return destPath;
  }

  onLog(`Could not download ${vadFileName()}. Transcription works without it; the adaptive`);
  onLog("mode just won't be able to pre-filter silence. Re-run `vno setup` to try again.");
  return null;
}
