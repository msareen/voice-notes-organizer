import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const CONFIG_DIR = path.join(os.homedir(), ".vno");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

function defaultConfig() {
  return {
    // Where imported/synced audio files land. Defaults to a "voice-notes"
    // folder in whatever directory `vno` was first run from - configurable
    // afterwards by editing this file.
    target: path.join(process.cwd(), "voice-notes"),
    // Optional manually-configured source folders to import from in addition
    // to auto-detected removable volumes (e.g. network shares or folders
    // that are already mounted). Only settable by editing this file for now.
    sources: [],
    // keyed by a stable identifier for the volume (label + size), remembers
    // whether the user wants it auto-imported and when it was last synced.
    knownMounts: {},
    // Whether freshly imported notes are auto-transcribed with whisper's
    // translate task (audio in any language -> English transcript) as they
    // come in. null = not decided yet, so `vno` asks once and remembers the
    // answer here; true/false = translate imports (or don't) without asking.
    autoTranslate: null,
    // Default whisper model used for auto-translation and as the pre-selected
    // choice in the transcribe picker.
    defaultModel: "turbo",
    // Language whisper.cpp is told to expect, as an ISO-639-1 code, or "auto"
    // to let it detect per file. Worth pinning for speakers of acoustically
    // similar languages whisper.cpp's auto-detect confuses (Hindi/Urdu is the
    // classic case) - forcing "hi" still transcribes code-switched English
    // fine, so this is also the fix for "mostly Hindi with English mixed in".
    transcribeLanguage: "auto",
    // Whether recordings deleted through vno (the UI's delete/cleanup, and
    // `vno cleanup`) are remembered in ~/.vno/deleted.json so a later import
    // doesn't copy them back off a device that still has them. Turning this
    // off stops both the remembering and the skipping; the ledger file itself
    // can be thrown away at any time with `vno cleanup ledger`.
    rememberDeletions: true,
    // After an import/transcribe run finishes, reveal the folder(s) the new
    // files landed in and open the regenerated index.html player. Set to
    // false (or pass --no-open) to keep runs headless.
    openWhenDone: true,
    // What `vno setup` installed for whisper.cpp's accelerator backend, and
    // what the user wants done with it. `backend` is fixed by which binary
    // got installed - null = not installed yet, "cpu" = installed but no
    // accelerator build available, "cuda"/"metal"/"vulkan" = installed with
    // that backend. `use` is the answer to the offer: null = never asked,
    // true/false = decided. Unlike the old torch probe this never needs
    // re-checking on a hot path, since the backend can't change without a
    // fresh `vno setup`; see lib/whisper.js:accelState.
    accel: { backend: null, name: null, use: null, resolvedAt: null },
  };
}

export async function loadConfig() {
  await fs.ensureDir(CONFIG_DIR);
  if (!(await fs.pathExists(CONFIG_FILE))) {
    const config = defaultConfig();
    await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
    return config;
  }
  try {
    const data = await fs.readJson(CONFIG_FILE);
    const defaults = defaultConfig();
    // The nested blocks are merged field by field, so a hand-edited partial
    // `accel` (or an older config that predates it) still has every key. A
    // stale `gpu` block from before this migration is dropped rather than
    // migrated - it's a cached torch probe result, meaningless once
    // transcription runs through whisper.cpp instead.
    const merged = {
      ...defaults,
      ...data,
      knownMounts: { ...data.knownMounts },
      accel: { ...defaults.accel, ...data.accel },
    };
    delete merged.gpu;
    return merged;
  } catch {
    // corrupt config file - back it up and start fresh rather than crash
    await fs.move(CONFIG_FILE, `${CONFIG_FILE}.bak-${Date.now()}`, { overwrite: true });
    const config = defaultConfig();
    await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
    return config;
  }
}

export async function saveConfig(config) {
  await fs.ensureDir(CONFIG_DIR);
  await fs.writeJson(CONFIG_FILE, config, { spaces: 2 });
}

export function configFilePath() {
  return CONFIG_FILE;
}
