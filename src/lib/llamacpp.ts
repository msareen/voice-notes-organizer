import path from "node:path";
import fs from "fs-extra";
import { which, runStep } from "./setup.ts";
import { HOMEBREW_URL } from "./webSources.ts";
import {
  isWindows,
  isMac,
  resolveInstallRoot as resolveEngineInstallRoot,
  installPaths,
  bothInstallRoots as bothEngineInstallRoots,
  isManagedModel as isEngineManagedModel,
  removeEngineModel,
} from "./engineInstall.ts";
import type { InstallMode, EngineRoot, ModelRemoval } from "./engineInstall.ts";
import type { Config } from "../types.ts";

/**
 * Installing and resolving the llama.cpp binary, and finding the (optional)
 * GGUF summarization models the user drops in - deliberately bare-bones,
 * unlike whisper.cpp's install story: llama.cpp is entirely optional, and
 * installing/updating the binary is the OS package manager's job
 * (`brew`/`winget`), not vno's. vno's only jobs here are (1) finding the
 * binary - PATH, or a manual override in `config.llamaCliPath` for when a
 * fresh `winget install` isn't visible on PATH in the same shell session -
 * and (2) knowing which folder(s) to look in for `.gguf` model files the
 * user places there themselves. No download, no curated model catalog, no
 * checksum verification, no install manifest.
 */

// Only the models/ folder concept is reused from engineInstall.ts (shared
// with whisper.cpp) - "local"/"global" now mean "which folder holds my
// models", never anything about the binary itself.
const ENGINE: EngineRoot = {
  folderName: "llama-cpp",
  manifestDescription: "Unused by llama.cpp's simplified install - kept only so the models/ folder layout matches whisper.cpp's.",
};

export type { InstallMode };

/** Where the local/global models folder lives for the given mode. */
export function resolveInstallRoot(mode: InstallMode = "local"): string {
  return resolveEngineInstallRoot(ENGINE, mode);
}

export { installPaths };

/** Both models-folder roots, local first. */
export function bothInstallRoots(): string[] {
  return bothEngineInstallRoots(ENGINE);
}

/** Whether a model file sits inside one of vno's own local/global models/ folders. */
export function isManagedModel(filePath: string): boolean {
  return isEngineManagedModel(ENGINE, filePath);
}

/** Deletes one model file, refusing anything outside the local/global models/ folders. */
export async function removeModel(filePath: string): Promise<ModelRemoval> {
  return removeEngineModel(ENGINE, filePath);
}

// As of the b-series releases, llama.cpp's CLI binary is `llama-cli`(.exe).
// Older releases (and some package managers) still call it `main`.
const BINARY_NAMES = isWindows ? ["llama-cli.exe", "main.exe"] : ["llama-cli", "main"];

/**
 * Finds the llama.cpp binary: `config.llamaCliPath` first (a manual override
 * for when a fresh install isn't on this shell's PATH yet), then PATH under
 * any known spelling. No vendored install root, no manifest - the binary is
 * whatever the OS package manager put on PATH, or wherever the user pointed us.
 */
export async function resolveBinary(config: Pick<Config, "llamaCliPath"> | null | undefined): Promise<string | null> {
  const override = config?.llamaCliPath;
  if (override && (await fs.pathExists(override))) return override;

  for (const name of BINARY_NAMES) {
    const found = await which(name);
    if (found) return found;
  }
  return null;
}

/** Whether a usable llama.cpp binary can be found - never a spawn. */
export async function isLlamaInstalled(config: Pick<Config, "llamaCliPath"> | null | undefined): Promise<boolean> {
  return Boolean(await resolveBinary(config));
}

// ---------------------------------------------------------------------------
// Per-platform binary acquisition - both are one package-manager command;
// vno never downloads or builds llama.cpp itself.
// ---------------------------------------------------------------------------

export const WINGET_PACKAGE_ID = "ggml.llamacpp";

/** macOS: Homebrew. */
export async function installMacBinary(): Promise<string> {
  if (!(await which("brew"))) {
    throw new Error(`Homebrew isn't installed. Get it from ${HOMEBREW_URL}, then run \`vno setup --llama\` again.`);
  }
  const result = await runStep({ command: "brew", args: ["install", "llama.cpp"] });
  if (!result.ok) throw new Error(`brew install llama.cpp failed:\n${result.output}`);

  const resolved = await which("llama-cli");
  if (!resolved) throw new Error("brew install llama.cpp succeeded but llama-cli still isn't on PATH.");
  return resolved;
}

/** Windows: winget. Returns the resolved path if PATH already sees it in this shell, else null. */
export async function installWindowsBinary(): Promise<string | null> {
  if (!(await which("winget"))) {
    throw new Error("winget isn't available on this machine. Install llama.cpp yourself: https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md");
  }
  const result = await runStep({
    command: "winget",
    args: ["install", "--id", WINGET_PACKAGE_ID, "-e", "--accept-source-agreements", "--accept-package-agreements"],
  });
  if (!result.ok) throw new Error(`winget install --id ${WINGET_PACKAGE_ID} failed:\n${result.output}`);

  for (const name of BINARY_NAMES) {
    const found = await which(name);
    if (found) return found;
  }
  // winget often registers PATH for a new shell only - not a failure, just
  // needs either a fresh terminal or a manually-given path.
  return null;
}

/** Where to point someone on a platform vno doesn't auto-install on (Linux). */
export function manualInstallHint(): string {
  return "Install llama.cpp yourself (e.g. your distro's package manager, or build from source), then either open a new terminal or give vno the binary's path: https://github.com/ggml-org/llama.cpp/blob/master/docs/install.md";
}

export function platformInstallDescription(): string {
  if (isMac) return "Installs via Homebrew (brew install llama.cpp).";
  if (isWindows) return `Installs via winget (winget install --id ${WINGET_PACKAGE_ID}).`;
  return "No automatic install on Linux - see the manual instructions.";
}

// ---------------------------------------------------------------------------
// Model discovery - a plain directory scan, no catalog, no download.
// ---------------------------------------------------------------------------

/** Why a model file was rejected, or how big it is if it passed. */
export interface ModelValidation {
  valid: boolean;
  reason?: string;
  size?: number;
}

/**
 * Whether a .gguf file at `filePath` is usable: readable, non-empty, and
 * starts with the GGUF magic bytes. Nothing more - every model here is
 * user-provided, so there's no catalog to check a hash or size against.
 */
export async function validateModelFile(filePath: string): Promise<ModelValidation> {
  let stats;
  try {
    stats = await fs.stat(filePath);
  } catch {
    return { valid: false, reason: "not readable" };
  }
  if (!stats.isFile() || stats.size === 0) return { valid: false, reason: "empty or not a file" };

  const handle = await fs.open(filePath, "r").catch(() => null);
  if (handle === null) return { valid: false, reason: "not readable" };
  try {
    const buffer = Buffer.alloc(4);
    const { bytesRead } = await fs.read(handle, buffer, 0, 4, 0);
    if (bytesRead < 4) return { valid: false, reason: "too short to contain a header" };
    if (buffer.toString("ascii") !== "GGUF") return { valid: false, reason: "missing GGUF magic bytes" };
  } finally {
    await fs.close(handle);
  }

  return { valid: true, size: stats.size };
}

/**
 * Finds an already-present model by filename: an explicit path, the
 * `VNO_LLAMA_MODEL_PATH` override, or a matching filename in either
 * local/global models/ folder. Never downloads - if it's not there, the
 * user needs to place it there themselves.
 */
export async function resolveModel(name: string): Promise<string | null> {
  const raw = String(name).trim();
  const candidates: string[] = [];

  if (raw.includes("/") || raw.includes("\\")) {
    candidates.push(raw);
  }
  const filename = path.basename(raw);

  const envOverride = process.env.VNO_LLAMA_MODEL_PATH;
  if (envOverride) {
    const stats = await fs.stat(envOverride).catch(() => null);
    candidates.push(stats?.isDirectory() ? path.join(envOverride, filename) : envOverride);
  }

  for (const root of bothInstallRoots()) {
    candidates.push(path.join(installPaths(root).modelsDir, filename));
  }

  for (const candidate of candidates) {
    if (!(await fs.pathExists(candidate))) continue;
    const result = await validateModelFile(candidate);
    if (result.valid) return path.resolve(candidate);
  }
  return null;
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
 * An inventory of every .gguf file under either local/global models/ folder
 * (plus `VNO_LLAMA_MODEL_PATH`, if set) - drop a file in and it shows up
 * here, whether or not vno has ever heard of it. Doesn't touch the network.
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
