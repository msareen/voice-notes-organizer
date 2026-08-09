import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import fs from "fs-extra";
import { which, detectPackageManager, runStep } from "./setup.js";

/**
 * Installing and resolving the whisper.cpp binary, its models and the
 * install.json manifest that records what `vno setup` found or built.
 *
 * Mirrors lib/setup.js's own rule: this module only *knows* things -
 * detection, acquisition, manifest bookkeeping. Asking the user anything
 * (which mode, whether to install, whether to delete stale files) lives in
 * cli/setup.js.
 */

const WHISPER_CPP_VERSION = "v1.9.2";
const GITHUB_REPO = "ggml-org/whisper.cpp";

const isWindows = os.platform() === "win32";
const isMac = os.platform() === "darwin";

// vno is a globally-installed CLI, not a project you `npm install` into, so
// "local" has no cwd to anchor to. The natural equivalent is beside vno's own
// install - resolved off import.meta.url the same way server.js finds its
// asset directory - so the binary/model set travels with this install of vno
// and survives an `npm update` in place.
const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Where whisper-cpp/ lives for the given mode. */
export function resolveInstallRoot(mode = "local") {
  if (mode === "global") {
    if (isWindows) {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      return path.join(localAppData, "whisper-cpp");
    }
    return path.join(os.homedir(), ".whisper-cpp");
  }
  return path.join(PACKAGE_ROOT, "whisper-cpp");
}

/** The fixed layout inside an install root, local or global. */
export function installPaths(root) {
  return {
    root,
    binDir: path.join(root, "bin"),
    modelsDir: path.join(root, "models"),
    manifestPath: path.join(root, "install.json"),
  };
}

/** Reads install.json for a root, or null if it's not there or unreadable. */
export async function readManifest(root) {
  const { manifestPath } = installPaths(root);
  try {
    return await fs.readJson(manifestPath);
  } catch {
    return null;
  }
}

/** Writes install.json, creating the root/bin/models layout if needed. */
export async function writeManifest(root, data) {
  const paths = installPaths(root);
  await fs.ensureDir(paths.binDir);
  await fs.ensureDir(paths.modelsDir);
  await fs.writeJson(paths.manifestPath, data, { spaces: 2 });
}

/** Both install roots, local first - used by resolution that must check both. */
export function bothInstallRoots() {
  return [resolveInstallRoot("local"), resolveInstallRoot("global")];
}

const BINARY_NAMES = isWindows
  ? ["whisper-cli.exe"]
  : ["whisper-cpp", "whisper-cli"];

/**
 * Finds the whisper.cpp binary: whichever install root's `install.json` is
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
export async function resolveBinary({ mode = "local" } = {}) {
  const localRoot = resolveInstallRoot("local");
  const globalRoot = resolveInstallRoot("global");
  const [localManifest, globalManifest] = await Promise.all([readManifest(localRoot), readManifest(globalRoot)]);
  const installedAtMs = (manifest) => (manifest?.installedAt ? Date.parse(manifest.installedAt) || 0 : 0);
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
  const manifestByRoot = new Map([
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
      return { path: recorded, name: manifest.binary.name || path.basename(recorded), source: manifest.binary.source || "manifest", root };
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
 * - the resolved absolute path is recorded in install.json, the same
 * reference-don't-copy approach `resolveModel` uses for a model found outside
 * the active install root.
 */
export async function registerExternalBinary(inputPath, { mode = "local", backend = "unknown", name = null } = {}) {
  const expanded = inputPath.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats) throw new Error(`${resolved} doesn't exist.`);

  let binaryPath = resolved;
  if (stats.isDirectory()) {
    let found = null;
    for (const candidateName of ALL_BINARY_NAMES) {
      found = await findFile(resolved, candidateName);
      if (found) break;
    }
    if (!found) {
      throw new Error(
        `Couldn't find a whisper.cpp binary (${ALL_BINARY_NAMES.join(", ")}) under ${resolved}.`
      );
    }
    binaryPath = found;
  }

  const root = resolveInstallRoot(mode);
  const existing = (await readManifest(root)) || {};
  const manifest = {
    ...existing,
    version: existing.version || WHISPER_CPP_VERSION,
    platform: os.platform(),
    arch: os.arch(),
    mode,
    binary: { path: binaryPath, name: path.basename(binaryPath), source: "external" },
    accel: { backend, name },
    installedAt: new Date().toISOString(),
  };
  await writeManifest(root, manifest);
  return manifest;
}

/** Runs a command and collects stdout, never throwing - used for probes. */
function probeCommand(command, args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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

/**
 * What accelerator this machine can plausibly use, decided at install time
 * rather than probed at runtime - whisper.cpp's accel backend is fixed by
 * which binary got installed, not chosen per run the way torch's device is.
 *
 * The CUDA version that matters for picking a prebuilt asset is the driver's
 * supported runtime - plain `nvidia-smi` prints it as "CUDA Version: X.Y" in
 * its header - not whether a CUDA *toolkit* (`nvcc`) is installed. NVIDIA
 * drivers are backward compatible with older CUDA runtimes, and the release
 * zips bundle their own runtime DLLs, so a machine with a current driver and
 * no toolkit at all still runs a prebuilt CUDA build fine. Checking for
 * `nvcc` instead would wrongly report "no CUDA" on exactly that (common)
 * machine.
 */
export async function detectAccelCandidate() {
  const gpuInfo = await probeCommand("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"]);
  if (!gpuInfo) {
    // No NVIDIA card, or no driver. whisper.cpp ships no Vulkan asset, so
    // there's nothing structural to offer AMD/Intel here - BLAS or plain CPU
    // is the whole story off NVIDIA.
    return { backend: "cpu", name: null, driverVersion: null, cudaVersion: null };
  }
  const [name, driverVersion] = gpuInfo.split(",").map((s) => s.trim());

  const plain = await probeCommand("nvidia-smi", []);
  const versionMatch = plain && plain.match(/CUDA Version:\s*([\d.]+)/i);

  return {
    backend: "cuda",
    name: name || "NVIDIA GPU",
    driverVersion: driverVersion || null,
    cudaVersion: versionMatch ? versionMatch[1] : null,
  };
}

// ---------------------------------------------------------------------------
// Downloading: shared by the Windows binary zip and (in lib/models.js) model
// files. Redirect-following and resumable, writes to a .part file so an
// interrupted run never leaves something that looks complete.
// ---------------------------------------------------------------------------

/**
 * Downloads `url` to `destPath`, following redirects and resuming a partial
 * `.part` file with an HTTP Range request when one exists. Renames to the
 * final name only once the response has been fully written.
 */
export async function downloadFile(url, destPath, { onProgress = null, headers = {} } = {}) {
  const partPath = `${destPath}.part`;
  await fs.ensureDir(path.dirname(destPath));

  let startAt = 0;
  if (await fs.pathExists(partPath)) {
    startAt = (await fs.stat(partPath)).size;
  }

  const requestHeaders = { ...headers };
  if (startAt > 0) requestHeaders.Range = `bytes=${startAt}-`;

  const response = await fetch(url, { headers: requestHeaders, redirect: "follow" });
  if (!response.ok && response.status !== 206) {
    // A server that doesn't honour Range starts over from the top.
    if (startAt > 0 && response.status !== 416) {
      await fs.remove(partPath);
      return downloadFile(url, destPath, { onProgress, headers });
    }
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${url})`);
  }

  const resumed = response.status === 206;
  const total = Number(response.headers.get("content-length") || 0) + (resumed ? startAt : 0);
  const writeStream = fs.createWriteStream(partPath, { flags: resumed ? "a" : "w" });

  let received = resumed ? startAt : 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    await new Promise((resolve, reject) => {
      writeStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
    });
    if (onProgress) onProgress({ received, total: total || null });
  }
  await new Promise((resolve, reject) => writeStream.end((err) => (err ? reject(err) : resolve())));

  await fs.move(partPath, destPath, { overwrite: true });
  return destPath;
}

// ---------------------------------------------------------------------------
// Minimal tar.gz extraction (no archiver dependency) - the Linux prebuilt
// asset shape. Handles regular files only, which is all a whisper.cpp
// release tarball contains.
// ---------------------------------------------------------------------------

/** Extracts every regular file in a gzipped tar into destDir. */
export async function extractTarGz(tarGzPath, destDir) {
  const gz = await fs.readFile(tarGzPath);
  const buffer = zlib.gunzipSync(gz);

  const extracted = [];
  let offset = 0;
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break; // end-of-archive marker

    const name = tarString(header, 0, 100);
    if (!name) break;
    const prefix = tarString(header, 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    const size = parseInt(tarString(header, 124, 12) || "0", 8) || 0;
    const typeFlag = String.fromCharCode(header[156]);

    const dataStart = offset + 512;
    if (typeFlag === "0" || typeFlag === "\0") {
      const destPath = path.join(destDir, fullName);
      if (!path.resolve(destPath).startsWith(path.resolve(destDir) + path.sep)) {
        throw new Error(`Refusing to extract ${fullName}: escapes the destination directory`);
      }
      await fs.ensureDir(path.dirname(destPath));
      await fs.writeFile(destPath, buffer.subarray(dataStart, dataStart + size));
      extracted.push(destPath);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return extracted;
}

function tarString(header, start, length) {
  const slice = header.subarray(start, start + length);
  const nul = slice.indexOf(0);
  return (nul === -1 ? slice : slice.subarray(0, nul)).toString("utf8").trim();
}

// ---------------------------------------------------------------------------
// Minimal ZIP extraction (no archiver dependency - only DEFLATE and store are
// supported, which is what GitHub release zips use).
// ---------------------------------------------------------------------------

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

/** Extracts every file in a zip into destDir, keeping its internal paths. */
export async function extractZip(zipPath, destDir) {
  const buffer = await fs.readFile(zipPath);

  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= 0; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset === -1) throw new Error(`${zipPath} doesn't look like a zip file (no end-of-central-directory)`);

  const entryCount = buffer.readUInt16LE(eocdOffset + 10);
  let centralDirOffset = buffer.readUInt32LE(eocdOffset + 16);

  const extracted = [];
  for (let i = 0; i < entryCount; i++) {
    if (buffer.readUInt32LE(centralDirOffset) !== CENTRAL_DIR_SIGNATURE) {
      throw new Error(`${zipPath} has a corrupt central directory entry`);
    }
    const compressionMethod = buffer.readUInt16LE(centralDirOffset + 10);
    const compressedSize = buffer.readUInt32LE(centralDirOffset + 20);
    const nameLength = buffer.readUInt16LE(centralDirOffset + 28);
    const extraLength = buffer.readUInt16LE(centralDirOffset + 30);
    const commentLength = buffer.readUInt16LE(centralDirOffset + 32);
    const localHeaderOffset = buffer.readUInt32LE(centralDirOffset + 42);
    const name = buffer.toString("utf8", centralDirOffset + 46, centralDirOffset + 46 + nameLength);

    if (buffer.readUInt32LE(localHeaderOffset) !== LOCAL_FILE_SIGNATURE) {
      throw new Error(`${zipPath} has a corrupt local file header for ${name}`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);

    if (!name.endsWith("/")) {
      const destPath = path.join(destDir, name);
      // Zip slip: refuse anything that would land outside destDir.
      if (!path.resolve(destPath).startsWith(path.resolve(destDir) + path.sep)) {
        throw new Error(`Refusing to extract ${name}: escapes the destination directory`);
      }
      await fs.ensureDir(path.dirname(destPath));
      const data = compressionMethod === 8 ? zlib.inflateRawSync(compressed) : compressed;
      await fs.writeFile(destPath, data);
      extracted.push(destPath);
    }

    centralDirOffset += 46 + nameLength + extraLength + commentLength;
  }
  return extracted;
}

// ---------------------------------------------------------------------------
// Per-platform binary acquisition
// ---------------------------------------------------------------------------

/**
 * macOS: Homebrew only, never a source build. The formula ships with Metal
 * enabled, so this is already GPU-accelerated on Apple silicon with no
 * cmake/Xcode/clone.
 */
export async function installMacBinary() {
  if (!(await which("brew"))) {
    throw new Error(
      "Homebrew isn't installed. Get it from https://brew.sh, then run `vno setup` again."
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

/**
 * Fetches the whisper.cpp release manifest from GitHub's API. Unauthenticated
 * requests are rate-limited (60/hour/IP), so a 403 falls back to a pinned
 * asset-name guess rather than crashing - logged loudly, since a guess that's
 * wrong needs to be visible.
 */
async function fetchReleaseAssets(version) {
  const url = `https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${version}`;
  const response = await fetch(url, { headers: { Accept: "application/vnd.github+json" } });
  if (response.status === 403) {
    return null; // rate-limited - caller falls back to a pinned name
  }
  if (!response.ok) {
    throw new Error(`Couldn't list whisper.cpp ${version} release assets: ${response.status} ${response.statusText}`);
  }
  const release = await response.json();
  return (release.assets || []).map((a) => ({ name: a.name, url: a.browser_download_url }));
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
function pickWindowsAsset(assets, accel) {
  const exact = (name) => assets.find((a) => a.name === name);

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
const PINNED_WINDOWS_FALLBACK = {
  "cuda-12": "whisper-cublas-12.4.0-bin-x64.zip",
  "cuda-11": "whisper-cublas-11.8.0-bin-x64.zip",
  cpu: "whisper-blas-bin-x64.zip",
};

/** Windows: prebuilt release zip, never a source build. */
export async function installWindowsBinary(root, { onLog = () => {}, onProgress = null } = {}) {
  const accelCandidate = await detectAccelCandidate();
  onLog(
    accelCandidate.backend === "cuda"
      ? `Detected NVIDIA GPU (${accelCandidate.name}), driver supports CUDA ${accelCandidate.cudaVersion || "unknown"}.`
      : "No NVIDIA GPU detected; using the BLAS-accelerated CPU build."
  );

  let assets = await fetchReleaseAssets(WHISPER_CPP_VERSION);
  let picked;
  let usedPinnedFallback = false;

  if (assets) {
    picked = pickWindowsAsset(assets, accelCandidate);
    if (!picked) {
      throw new Error(
        `No matching Windows asset found in whisper.cpp ${WHISPER_CPP_VERSION}. Available assets:\n` +
          assets.map((a) => `  - ${a.name}`).join("\n")
      );
    }
  } else {
    usedPinnedFallback = true;
    const major = accelCandidate.cudaVersion ? parseInt(accelCandidate.cudaVersion.split(".")[0], 10) : null;
    const pinnedKey =
      accelCandidate.backend === "cuda" && major >= 12 ? "cuda-12" : accelCandidate.backend === "cuda" && major >= 11 ? "cuda-11" : "cpu";
    const name = PINNED_WINDOWS_FALLBACK[pinnedKey];
    const backend = pinnedKey === "cpu" ? "cpu" : "cuda";
    onLog(
      `GitHub's API is rate-limited right now, so falling back to a pinned asset name (${name}). ` +
        `If this is wrong, run \`vno setup\` again later or check https://github.com/${GITHUB_REPO}/releases/tag/${WHISPER_CPP_VERSION} yourself.`
    );
    picked = {
      asset: { name, url: `https://github.com/${GITHUB_REPO}/releases/download/${WHISPER_CPP_VERSION}/${name}` },
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

async function findFile(dir, filename) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(full, filename);
      if (found) return found;
    } else if (entry.name.toLowerCase() === filename.toLowerCase()) {
      return full;
    }
  }
  return null;
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
export async function installLinuxBinary(root, { onLog = () => {}, onStep = () => {}, onProgress = null } = {}) {
  const accelCandidate = await detectAccelCandidate();
  const useCuda = accelCandidate.backend === "cuda";

  if (!useCuda) {
    try {
      return await installLinuxPrebuilt(root, { onLog, onProgress });
    } catch (err) {
      onLog(`Prebuilt Linux binary didn't work out (${err.message}); building from source instead.`);
    }
  }

  return installLinuxSource(root, { onLog, onStep, useCuda, accelCandidate });
}

/** The CPU-only prebuilt tarball - the fast path when there's no GPU to build for. */
async function installLinuxPrebuilt(root, { onLog, onProgress }) {
  const assetName = os.arch() === "arm64" ? "whisper-bin-ubuntu-arm64.tar.gz" : "whisper-bin-ubuntu-x64.tar.gz";

  const assets = await fetchReleaseAssets(WHISPER_CPP_VERSION);
  let url;
  if (assets) {
    const found = assets.find((a) => a.name === assetName);
    if (!found) throw new Error(`no ${assetName} in the ${WHISPER_CPP_VERSION} release`);
    url = found.url;
  } else {
    onLog(`GitHub's API is rate-limited right now, falling back to a pinned URL for ${assetName}.`);
    url = `https://github.com/${GITHUB_REPO}/releases/download/${WHISPER_CPP_VERSION}/${assetName}`;
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
async function installLinuxSource(root, { onLog, onStep, useCuda, accelCandidate }) {
  const missing = [];
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

  const cloneStep = {
    command: "git",
    args: ["clone", "--depth", "1", "--branch", WHISPER_CPP_VERSION, `https://github.com/${GITHUB_REPO}`, cloneDir],
  };
  onLog(`Cloning whisper.cpp ${WHISPER_CPP_VERSION}...`);
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

/**
 * Installs whisper.cpp for this platform into `root`, writing install.json.
 * `mode` is recorded so `resolveModel` below can tell which root a manifest
 * came from without re-deriving it.
 */
export async function installWhisperCpp({ mode = "local", onLog = () => {}, onProgress = null, onStep = () => {} } = {}) {
  const root = resolveInstallRoot(mode);
  const platform = os.platform();

  let outcome;
  if (isMac) outcome = await installMacBinary();
  else if (isWindows) outcome = await installWindowsBinary(root, { onLog, onProgress });
  else outcome = await installLinuxBinary(root, { onLog, onStep, onProgress });

  const existing = (await readManifest(root)) || {};
  const manifest = {
    ...existing,
    version: WHISPER_CPP_VERSION,
    platform,
    arch: os.arch(),
    mode,
    binary: outcome.binary,
    accel: outcome.accel,
    installedAt: new Date().toISOString(),
  };
  await writeManifest(root, manifest);
  await ensureGitignoreEntry(mode);
  return manifest;
}

/**
 * Adds whisper-cpp/ to .gitignore, but only in a dev checkout of this
 * repo (a .git directory beside package.json) - a globally npm-installed vno
 * has no working tree to ignore anything in, and touching a file there would
 * be pointless at best.
 */
async function ensureGitignoreEntry(mode) {
  if (mode !== "local") return;
  const gitDir = path.join(PACKAGE_ROOT, ".git");
  const gitignorePath = path.join(PACKAGE_ROOT, ".gitignore");
  if (!(await fs.pathExists(gitDir)) || !(await fs.pathExists(gitignorePath))) return;

  const content = await fs.readFile(gitignorePath, "utf8");
  if (/(^|\n)whisper-cpp\/?(\r?\n|$)/.test(content)) return;
  const separator = content.endsWith("\n") ? "" : "\n";
  await fs.appendFile(gitignorePath, `${separator}\n# whisper.cpp binary + models (vno setup, local mode)\nwhisper-cpp/\n`);
}

// ---------------------------------------------------------------------------
// Model resolution & download
// ---------------------------------------------------------------------------

const HUGGINGFACE_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";

// Friendly names this project already uses (matching the model picker in
// cli/transcribe.js and server.js's MODELS list), plus their ggml filenames.
// Anything not in this map falls through to `ggml-<name>.bin` so quantized
// and less common variants (small.en-q5_1, large-v3-turbo-q8_0, ...) still work.
const MODEL_ALIASES = {
  tiny: "tiny",
  base: "base",
  small: "small",
  medium: "medium",
  large: "large-v3",
  turbo: "large-v3-turbo",
};

// Approximate sizes for the models this project offers by default, used only
// as a sanity check (~10% tolerance) against a corrupt or truncated download.
// Anything outside this table skips the size check but still gets the magic-
// byte and readability checks.
const MODEL_SIZES = {
  tiny: 77_700_000,
  base: 148_000_000,
  small: 488_000_000,
  medium: 1_530_000_000,
  "large-v3": 3_100_000_000,
  "large-v3-turbo": 1_620_000_000,
};

/**
 * Normalizes anything a caller might pass - a bare alias ("turbo"), a ggml
 * stem ("large-v3-turbo"), a full filename ("ggml-small.bin") or a path -
 * into `{ filename, path }`. `path` is set only when the input already looked
 * like a path (absolute, or containing a separator); resolution below still
 * applies to a bare filename or alias.
 */
function normalizeModelName(name) {
  const raw = String(name).trim();
  if (raw.includes("/") || raw.includes("\\")) {
    return { filename: path.basename(raw).replace(/^ggml-/, "").replace(/\.bin$/i, ""), explicitPath: raw };
  }
  const stem = raw.replace(/^ggml-/, "").replace(/\.bin$/i, "");
  const canonical = MODEL_ALIASES[stem] || stem;
  return { filename: canonical, explicitPath: null };
}

const modelFileName = (stem) => `ggml-${stem}.bin`;

/**
 * Whether a model file at `filePath` is genuinely usable, not just present:
 * size within ~10% of what's expected (when known), GGML/GGUF magic bytes,
 * and readable. This is what catches the classic failure mode - an HTML
 * redirect stub saved as if it were the model - before it becomes an opaque
 * error at load time.
 */
export async function validateModelFile(filePath, stem) {
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
  if (!handle) return { valid: false, reason: "not readable" };
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
 * install.json, then Homebrew's shared dir on macOS. Both install roots are
 * always checked regardless of which is active, so a global install from
 * last month and a local one today don't each re-fetch the same gigabytes.
 *
 * Returns an absolute path, or null if nothing valid was found - resolution
 * never downloads, that's `downloadModel`'s job.
 */
export async function resolveModel(name) {
  const { filename: stem, explicitPath } = normalizeModelName(name);
  const targetName = modelFileName(stem);

  const candidates = [];

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

/**
 * Downloads a model that `resolveModel` couldn't find, into the given
 * install root's models/ directory. A file that fails validation once is
 * deleted and re-fetched exactly once rather than reused - an interrupted
 * earlier run must never look like a completed one.
 */
export async function downloadModel(name, { mode = "local", onProgress = null, onLog = () => {} } = {}) {
  const { filename: stem, explicitPath } = normalizeModelName(name);
  if (explicitPath) {
    throw new Error(`"${name}" looks like a path, not a model name - nothing to download for an explicit path.`);
  }

  const existing = await resolveModel(name);
  if (existing) return existing;

  const root = resolveInstallRoot(mode);
  const { modelsDir } = installPaths(root);
  const destPath = path.join(modelsDir, modelFileName(stem));
  const url = `${HUGGINGFACE_BASE}/${modelFileName(stem)}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    onLog(`Downloading ${modelFileName(stem)}${attempt > 1 ? " (retry)" : ""} from ${url}...`);
    await downloadFile(url, destPath, { onProgress });
    const result = await validateModelFile(destPath, stem);
    if (result.valid) {
      const manifest = (await readManifest(root)) || {};
      manifest.models = { ...manifest.models, [stem]: destPath };
      await writeManifest(root, manifest);
      return destPath;
    }
    onLog(`Downloaded file failed validation (${result.reason}); deleting and retrying.`);
    await fs.remove(destPath);
  }
  throw new Error(`${modelFileName(stem)} failed validation twice in a row - giving up. Try again later, or check ${url} in a browser.`);
}

/** The model names this project ensures are present unless told otherwise. */
export const DEFAULT_MODELS = ["small", "turbo"];

/**
 * An inventory of every place a model could live, for `--list-models` and
 * for the before/after report `vno setup` prints. Doesn't touch the network.
 */
export async function listModels() {
  const seen = new Set();
  const entries = [];

  const check = async (label, filePath, stem) => {
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

/**
 * The old Python whisper's model cache - PyTorch .pt checkpoints, not usable
 * by whisper.cpp (different format, and the GGML versions are a direct
 * download rather than something worth converting). Reported so a machine
 * that ran Python whisper for a while can reclaim the space; never deleted
 * here - `cli/setup.js` prompts before removing anything.
 */
export async function findStalePythonCache() {
  const dir = path.join(os.homedir(), ".cache", "whisper");
  const files = await fs.readdir(dir).catch(() => []);
  const entries = [];
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

export const WHISPERCPP_VERSION = WHISPER_CPP_VERSION;
export const WHISPERCPP_REPO = GITHUB_REPO;
