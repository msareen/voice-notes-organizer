import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import zlib from "node:zlib";
import fs from "fs-extra";
import type { AccelBackend } from "../types.ts";

/**
 * Engine-agnostic pieces of "install and resolve a vendored binary +
 * models under a vno-managed folder, tracked by a vno-install.json
 * manifest" - shared by whisper.cpp (lib/whisper/whispercpp.ts) and llama.cpp
 * (lib/llama/llamacpp.ts). Nothing here knows which engine it's serving; each
 * engine module binds an `EngineRoot` describing its own folder name and
 * manifest description text, and calls through to these.
 *
 * Per-platform binary acquisition (release asset picking, Homebrew formula
 * names, source-build recipes) and model catalog/naming stay in the engine
 * modules - those genuinely differ per engine.
 */

export const isWindows = os.platform() === "win32";
export const isMac = os.platform() === "darwin";

// vno is a globally-installed CLI, not a project you `bun install` into, so
// "local" has no cwd to anchor to. The natural equivalent is beside vno's own
// install - resolved off import.meta.url the same way the server finds its
// asset directory - so the binary/model set travels with this install of vno
// and survives an update in place.
export const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Which install root a call targets: beside this vno install, or under $HOME. */
export type InstallMode = "local" | "global";

/** The binary an install produced or was pointed at, as recorded in vno-install.json. */
export interface BinaryRecord {
  path: string;
  name: string;
  source: string;
  /** The release asset it came out of, when it came from one. */
  asset?: string;
}

/** The accelerator backend baked into the installed binary. */
export interface AccelRecord {
  backend: AccelBackend;
  name: string | null;
}

/** vno-install.json. Every field but `description` is whatever the run that wrote it recorded. */
export interface InstallManifest {
  /** Human-readable, for anyone who opens the file - never read back by vno. */
  description?: string;
  version?: string;
  platform?: string;
  arch?: string;
  mode?: InstallMode;
  binary?: BinaryRecord;
  accel?: AccelRecord;
  installedAt?: string;
  /** Absolute paths of models downloaded into this root, keyed by model stem. */
  models?: Record<string, string>;
}

export interface InstallLayout {
  root: string;
  binDir: string;
  modelsDir: string;
  manifestPath: string;
}

/** Identifies an engine's own folder name and manifest text - the only per-engine bits these helpers need. */
export interface EngineRoot {
  /** e.g. "whisper-cpp" / "llama-cpp" - the folder name under PACKAGE_ROOT and under $HOME. */
  folderName: string;
  /** Purely informational text written into vno-install.json's `description` field. */
  manifestDescription: string;
}

/** Where `engine`'s folder lives for the given mode. */
export function resolveInstallRoot(engine: EngineRoot, mode: InstallMode = "local"): string {
  if (mode === "global") {
    if (isWindows) {
      const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
      return path.join(localAppData, engine.folderName);
    }
    return path.join(os.homedir(), `.${engine.folderName}`);
  }
  return path.join(PACKAGE_ROOT, engine.folderName);
}

/** The fixed layout inside an install root, local or global. */
export function installPaths(root: string): InstallLayout {
  return {
    root,
    binDir: path.join(root, "bin"),
    modelsDir: path.join(root, "models"),
    manifestPath: path.join(root, "vno-install.json"),
  };
}

/** Reads vno-install.json for a root, or null if it's not there or unreadable. */
export async function readManifest(root: string): Promise<InstallManifest | null> {
  const { manifestPath } = installPaths(root);
  try {
    return await fs.readJson(manifestPath);
  } catch {
    return null;
  }
}

/** Writes vno-install.json, creating the root/bin/models layout if needed. */
export async function writeManifest(engine: EngineRoot, root: string, data: InstallManifest): Promise<void> {
  const paths = installPaths(root);
  await fs.ensureDir(paths.binDir);
  await fs.ensureDir(paths.modelsDir);
  await fs.writeJson(paths.manifestPath, { ...data, description: engine.manifestDescription }, { spaces: 2 });
}

/** Both install roots, local first - used by resolution that must check both. */
export function bothInstallRoots(engine: EngineRoot): string[] {
  return [resolveInstallRoot(engine, "local"), resolveInstallRoot(engine, "global")];
}

/**
 * Whether a model file is one vno put there - i.e. it sits inside either
 * install root's models/. This is the line deletion is allowed to cross and
 * nothing else is: a model found via Homebrew's share directory belongs to
 * brew, and one found through WHISPER_MODEL_PATH/VNO_LLAMA_MODEL_PATH belongs
 * to whoever pointed the variable there. Both are referenced, never copied,
 * so removing them would be deleting someone else's file out from under a
 * different tool.
 */
export function isManagedModel(engine: EngineRoot, filePath: string): boolean {
  const resolved = path.resolve(filePath);
  return bothInstallRoots(engine).some((root) => {
    const rel = path.relative(installPaths(root).modelsDir, resolved);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

/** What `removeEngineModel` did, so a caller can report bytes reclaimed. */
export interface ModelRemoval {
  removed: boolean;
  reason?: string;
  freedBytes: number;
}

/**
 * Deletes one model file vno installed, and drops whatever manifest entry
 * pointed at it. Refuses anything outside the engine's own models/ dirs (see
 * `isManagedModel`) rather than trusting the caller's path.
 *
 * The manifest sweep matches on the recorded *value*, not the key, because
 * the two engines key `models` differently - whisper.cpp by stem, llama.cpp
 * by filename - and a stale entry pointing at a file that no longer exists
 * would make `resolveModel` hand out a dead path.
 */
export async function removeEngineModel(engine: EngineRoot, filePath: string): Promise<ModelRemoval> {
  const resolved = path.resolve(filePath);
  if (!isManagedModel(engine, resolved)) {
    return { removed: false, reason: "not inside a vno-managed models/ folder", freedBytes: 0 };
  }

  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats?.isFile()) return { removed: false, reason: "not found", freedBytes: 0 };

  try {
    await fs.remove(resolved);
  } catch (err) {
    return { removed: false, reason: err instanceof Error ? err.message : String(err), freedBytes: 0 };
  }

  for (const root of bothInstallRoots(engine)) {
    const manifest = await readManifest(root);
    if (!manifest?.models) continue;
    const kept = Object.entries(manifest.models).filter(([, recorded]) => path.resolve(recorded) !== resolved);
    if (kept.length === Object.keys(manifest.models).length) continue;
    // A failed manifest rewrite must not turn a successful delete into an
    // error - the file is already gone, and a stale entry self-heals on the
    // next download of the same model.
    await writeManifest(engine, root, { ...manifest, models: Object.fromEntries(kept) }).catch(() => {});
  }

  return { removed: true, freedBytes: stats.size };
}

/** Runs a command and collects stdout, never throwing - used for probes. */
export function probeCommand(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
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

/** What accelerator this machine could plausibly use, decided at install time. */
export interface AccelCandidate {
  backend: "cpu" | "cuda";
  name: string | null;
  driverVersion: string | null;
  cudaVersion: string | null;
}

/**
 * What accelerator this machine can plausibly use, decided at install time
 * rather than probed at runtime - a binary's accel backend is fixed by which
 * one got installed, not chosen per run the way torch's device is. Shared by
 * every engine: it's a question about the GPU, not about whisper.cpp or
 * llama.cpp specifically.
 *
 * The CUDA version that matters for picking a prebuilt asset is the driver's
 * supported runtime - plain `nvidia-smi` prints it as "CUDA Version: X.Y" in
 * its header - not whether a CUDA *toolkit* (`nvcc`) is installed. NVIDIA
 * drivers are backward compatible with older CUDA runtimes, and release
 * assets typically bundle their own runtime DLLs, so a machine with a current
 * driver and no toolkit at all still runs a prebuilt CUDA build fine.
 * Checking for `nvcc` instead would wrongly report "no CUDA" on exactly that
 * (common) machine.
 */
export async function detectAccelCandidate(): Promise<AccelCandidate> {
  const gpuInfo = await probeCommand("nvidia-smi", ["--query-gpu=name,driver_version", "--format=csv,noheader"]);
  if (!gpuInfo) {
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

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function findFile(dir: string, filename: string): Promise<string | null> {
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
 * Points vno at a binary the user already has, instead of installing one.
 * `inputPath` can be the binary itself or a folder containing it (searched
 * for any of `binaryNames`). Never copies the file - the resolved absolute
 * path is recorded in vno-install.json, the same reference-don't-copy
 * approach model resolution uses for a model found outside the active
 * install root.
 */
export async function registerExternalBinary(
  engine: EngineRoot,
  binaryNames: string[],
  defaultVersion: string,
  inputPath: string,
  {
    mode = "local",
    backend = "unknown",
    name = null,
  }: { mode?: InstallMode; backend?: AccelRecord["backend"]; name?: string | null } = {}
): Promise<InstallManifest> {
  const expanded = inputPath.replace(/^~(?=$|[\\/])/, os.homedir());
  const resolved = path.resolve(expanded);
  const stats = await fs.stat(resolved).catch(() => null);
  if (!stats) throw new Error(`${resolved} doesn't exist.`);

  let binaryPath = resolved;
  if (stats.isDirectory()) {
    let found: string | null = null;
    for (const candidateName of binaryNames) {
      found = await findFile(resolved, candidateName);
      if (found) break;
    }
    if (!found) {
      throw new Error(`Couldn't find a binary (${binaryNames.join(", ")}) under ${resolved}.`);
    }
    binaryPath = found;
  }

  const root = resolveInstallRoot(engine, mode);
  const existing = (await readManifest(root)) || {};
  const manifest: InstallManifest = {
    ...existing,
    version: existing.version || defaultVersion,
    platform: os.platform(),
    arch: os.arch(),
    mode,
    binary: { path: binaryPath, name: path.basename(binaryPath), source: "external" },
    accel: { backend, name },
    installedAt: new Date().toISOString(),
  };
  await writeManifest(engine, root, manifest);
  return manifest;
}

// ---------------------------------------------------------------------------
// Downloading: shared by release binary archives and model files.
// Redirect-following and resumable, writes to a .part file so an
// interrupted run never leaves something that looks complete.
// ---------------------------------------------------------------------------

/** Bytes received so far, and the total when the server declared one. */
export interface DownloadProgress {
  received: number;
  total: number | null;
}

export type DownloadProgressCallback = (progress: DownloadProgress) => void;

interface DownloadOptions {
  onProgress?: DownloadProgressCallback | null;
  headers?: Record<string, string>;
}

/**
 * Downloads `url` to `destPath`, following redirects and resuming a partial
 * `.part` file with an HTTP Range request when one exists. Renames to the
 * final name only once the response has been fully written.
 */
export async function downloadFile(
  url: string,
  destPath: string,
  { onProgress = null, headers = {} }: DownloadOptions = {}
): Promise<string> {
  const partPath = `${destPath}.part`;
  await fs.ensureDir(path.dirname(destPath));

  let startAt = 0;
  if (await fs.pathExists(partPath)) {
    startAt = (await fs.stat(partPath)).size;
  }

  const requestHeaders: Record<string, string> = { ...headers };
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
  if (!response.body) throw new Error(`Download failed: ${url} returned no body`);

  const resumed = response.status === 206;
  const total = Number(response.headers.get("content-length") || 0) + (resumed ? startAt : 0);
  const writeStream = fs.createWriteStream(partPath, { flags: resumed ? "a" : "w" });

  let received = resumed ? startAt : 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.length;
    await new Promise<void>((resolve, reject) => {
      writeStream.write(Buffer.from(value), (err) => (err ? reject(err) : resolve()));
    });
    if (onProgress) onProgress({ received, total: total || null });
  }
  await new Promise<void>((resolve, reject) => writeStream.end((err?: Error | null) => (err ? reject(err) : resolve())));

  await fs.move(partPath, destPath, { overwrite: true });
  return destPath;
}

// ---------------------------------------------------------------------------
// Minimal tar.gz extraction (no archiver dependency) - handles regular files
// only, which is all a prebuilt release tarball contains.
// ---------------------------------------------------------------------------

/** Extracts every regular file in a gzipped tar into destDir. */
export async function extractTarGz(tarGzPath: string, destDir: string): Promise<string[]> {
  const gz = await fs.readFile(tarGzPath);
  const buffer = zlib.gunzipSync(gz);

  const extracted: string[] = [];
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

function tarString(header: Buffer, start: number, length: number): string {
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
export async function extractZip(zipPath: string, destDir: string): Promise<string[]> {
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

  const extracted: string[] = [];
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

export { findFile, errorMessage };

/**
 * Adds `engine.folderName/` to .gitignore, but only in a dev checkout of this
 * repo (a .git directory beside package.json) - a globally installed vno has
 * no working tree to ignore anything in, and touching a file there would be
 * pointless at best.
 */
export async function ensureGitignoreEntry(engine: EngineRoot, mode: InstallMode): Promise<void> {
  if (mode !== "local") return;
  const gitDir = path.join(PACKAGE_ROOT, ".git");
  const gitignorePath = path.join(PACKAGE_ROOT, ".gitignore");
  if (!(await fs.pathExists(gitDir)) || !(await fs.pathExists(gitignorePath))) return;

  const content = await fs.readFile(gitignorePath, "utf8");
  const pattern = new RegExp(`(^|\\n)${engine.folderName}\\/?(\\r?\\n|$)`);
  if (pattern.test(content)) return;
  const separator = content.endsWith("\n") ? "" : "\n";
  await fs.appendFile(
    gitignorePath,
    `${separator}\n# ${engine.folderName} binary + models (vno setup, local mode)\n${engine.folderName}/\n`
  );
}
