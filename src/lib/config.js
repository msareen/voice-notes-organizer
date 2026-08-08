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
    // What `vno setup` found out about GPU acceleration, and what the user
    // wants done with it. `device` is the probe result - null = never probed,
    // "cuda" = usable GPU, "cpu" = probed and there isn't one. `use` is the
    // answer to the offer: null = never asked, true/false = decided. Asking
    // torch costs seconds, which is why it's cached rather than re-checked;
    // see lib/gpu.js.
    gpu: { device: null, name: null, torch: null, use: null, probedAt: null },
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
    // `gpu` (or an older config that predates it) still has every key.
    return {
      ...defaults,
      ...data,
      knownMounts: { ...data.knownMounts },
      gpu: { ...defaults.gpu, ...data.gpu },
    };
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
