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
    return { ...defaultConfig(), ...data, knownMounts: { ...data.knownMounts } };
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
