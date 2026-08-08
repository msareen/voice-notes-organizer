import path from "node:path";
import { spawn } from "node:child_process";
import fs from "fs-extra";
import { which, resolvePip } from "./setup.js";
import { saveConfig } from "./config.js";

/**
 * Whether transcription runs on the GPU, and how we find that out.
 *
 * whisper is PyTorch, so the only trustworthy answer is torch's own
 * `cuda.is_available()` - an NVIDIA card plus a driver still means CPU if the
 * installed torch happens to be the CPU-only wheel, which is what a plain
 * `pip install openai-whisper` gives you on many machines. Asking costs seconds
 * (it boots Python and imports torch), so the answer is probed once by
 * `vno setup` and cached in config; nothing here runs on a hot path.
 *
 * CUDA only. Apple's MPS backend still misses operators whisper needs, and
 * ROCm reports itself as cuda anyway.
 *
 * Like the rest of lib/, this module never prompts - `cli/setup.js` owns the ask.
 */

// Printed as one JSON line so a torch warning on stderr can't corrupt the answer.
const PROBE = [
  "import json",
  "try:",
  "    import torch",
  "    ok = bool(torch.cuda.is_available())",
  "    print(json.dumps({'cuda': ok, 'name': torch.cuda.get_device_name(0) if ok else None, 'torch': torch.__version__}))",
  "except Exception as e:",
  "    print(json.dumps({'cuda': False, 'name': None, 'torch': None, 'error': str(e)}))",
].join("\n");

const PROBE_TIMEOUT_MS = 120000;

/**
 * The Python that whisper itself runs under, so a venv or pipx install is
 * probed rather than whatever `python` happens to be first on PATH - those are
 * routinely different interpreters with different torch builds.
 *
 * A console script lives next to its interpreter: `<env>/bin/whisper` beside
 * `<env>/bin/python`, `<env>/Scripts/whisper.exe` beside `<env>/Scripts/python.exe`
 * or `<env>/python.exe`. On POSIX the shebang says so outright, so read it first.
 */
async function resolvePython() {
  const whisper = await which("whisper");
  if (whisper) {
    const dir = path.dirname(whisper);
    const candidates =
      process.platform === "win32"
        ? [path.join(dir, "python.exe"), path.join(path.dirname(dir), "python.exe")]
        : [];

    if (process.platform !== "win32") {
      const shebang = await readShebang(whisper);
      // `#!/usr/bin/env python` names no interpreter, so it tells us nothing.
      if (shebang && shebang.includes(path.sep) && !shebang.endsWith("env")) candidates.push(shebang);
      candidates.push(path.join(dir, "python3"), path.join(dir, "python"));
    }

    for (const candidate of candidates) {
      if (await fs.pathExists(candidate)) return { command: candidate, args: [] };
    }
  }

  // No whisper, or an unusual layout: fall back to the same resolution the
  // installer uses, which already knows every spelling of python/pip.
  const pip = await resolvePip();
  if (pip && pip.args.length > 0) return { command: pip.command, args: [] };
  for (const command of process.platform === "win32" ? ["python", "py"] : ["python3", "python"]) {
    const found = await which(command);
    if (found) return { command: found, args: [] };
  }
  return null;
}

async function readShebang(file) {
  try {
    const handle = await fs.open(file, "r");
    try {
      const buffer = Buffer.alloc(256);
      const { bytesRead } = await fs.read(handle, buffer, 0, 256, 0);
      const first = buffer.toString("utf8", 0, bytesRead).split(/\r?\n/)[0];
      if (!first.startsWith("#!")) return null;
      return first.slice(2).trim().split(/\s+/)[0];
    } finally {
      await fs.close(handle);
    }
  } catch {
    return null; // a binary launcher, or unreadable - neither is an error here
  }
}

/**
 * Asks torch what this machine has. Resolves to
 * `{ device: "cuda" | "cpu", name, torch, error }` and never rejects: a missing
 * Python, a missing torch and a crashed probe all just mean "cpu", which is
 * exactly what whisper would have done anyway.
 */
export async function probeGpu() {
  const python = await resolvePython();
  if (!python) return { device: "cpu", name: null, torch: null, error: "No Python interpreter found" };

  const output = await runProbe(python);
  if (!output.ok) return { device: "cpu", name: null, torch: null, error: output.error };

  try {
    // The probe prints one JSON line, but torch is happy to print warnings
    // around it, so take the last line that parses.
    const line = output.text
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.startsWith("{"))
      .pop();
    const parsed = JSON.parse(line);
    return {
      device: parsed.cuda ? "cuda" : "cpu",
      name: parsed.name || null,
      torch: parsed.torch || null,
      error: parsed.error || null,
    };
  } catch {
    return { device: "cpu", name: null, torch: null, error: "Couldn't read the GPU probe's answer" };
  }
}

function runProbe(python) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(python.command, [...python.args, "-c", PROBE], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }

    let text = "";
    let stderr = "";
    // A torch import can hang on a broken driver, and this is the one place vno
    // waits on Python for no user-visible reason - so it can't wait forever.
    const timer = setTimeout(() => {
      child.kill();
      resolve({ ok: false, error: "The GPU probe timed out" });
    }, PROBE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (text += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: err.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 && !text.includes("{")) {
        resolve({ ok: false, error: stderr.trim().split(/\r?\n/).pop() || `python exited with code ${code}` });
        return;
      }
      resolve({ ok: true, text });
    });
  });
}

/** The `gpu` block, defaulted, for a config that predates the setting. */
export function gpuState(config) {
  return { device: null, name: null, torch: null, use: null, probedAt: null, ...(config?.gpu || {}) };
}

/**
 * The device whisper should run on. A detected GPU is used unless the user has
 * said no: the browser has nowhere to ask at job time, and "not asked yet" on a
 * machine with a working CUDA build should be fast rather than cautious.
 */
export function resolveDevice(config) {
  const gpu = gpuState(config);
  return gpu.device === "cuda" && gpu.use !== false ? "cuda" : "cpu";
}

/** Whether the user has a detected GPU they were never asked about. */
export function gpuUnasked(config) {
  const gpu = gpuState(config);
  return gpu.device === "cuda" && gpu.use === null;
}

/**
 * Whether a whisper failure is about the GPU rather than the audio. Deliberately
 * narrow - a false positive would retry a genuinely broken file on the CPU and
 * report the wrong cause.
 */
export function isDeviceError(message) {
  return /Torch not compiled with CUDA|CUDA (error|out of memory|driver)|no CUDA GPUs are available|CUDA-capable device|no NVIDIA driver|no kernel image|torch\.cuda|cuDNN|CUDA_ERROR/i.test(
    message || ""
  );
}

/**
 * The useful line of a whisper failure: a Python traceback ends with the
 * exception, but also with trailing blank lines, so "the last line" isn't it.
 */
export function lastLine(message) {
  const lines = (message || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines[lines.length - 1] || "no output";
}

/**
 * Forgets the cached probe (but not the user's answer) after a GPU run failed,
 * so the next `vno setup` re-detects instead of the config insisting forever on
 * a device that no longer works.
 */
export async function forgetGpuProbe(config) {
  try {
    config.gpu = { ...gpuState(config), device: null, name: null, torch: null, probedAt: null };
    await saveConfig(config);
  } catch {
    // The cached probe is an optimisation, never load-bearing: failing to
    // forget it must not turn a transcription that recovered into an error.
  }
}
