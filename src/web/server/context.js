import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { saveConfig, configFilePath } from "../../lib/config.js";
import { buildNotes, TRANSCRIPT_EXTS } from "../../lib/notes.js";
import { accelState, resolveAccel } from "../../lib/whisper.js";
import { resolveModel } from "../../lib/whispercpp.js";
import { checkDependencies } from "../../lib/setup.js";
import { recordDeletions } from "../../lib/ledger.js";
import { AUDIO_EXTENSIONS } from "../../lib/sync.js";
import { MODELS, LANGUAGES } from "./constants.js";

/**
 * The shared mutable state and helpers every route module closes over:
 * notes, config, the single running job, SSE clients, and the small pieces
 * of plumbing (JSON responses, path confinement, job lifecycle) that don't
 * belong to any one route. `index.js` attaches `stop`/`scheduleShutdown`/
 * `cancelShutdown` onto the returned object once the http.Server exists,
 * since those need the server/socket lifecycle that lives there.
 */
export async function createContext({ config, target, onScanProgress }) {
  // Notes are expensive to build (an ffprobe per file), so they're cached and
  // rebuilt only when something actually changes them.
  let notes = await buildNotes(target, { onProgress: onScanProgress });
  let currentConfig = config;
  let job = null; // at most one long-running job at a time

  const clients = new Set(); // open SSE responses

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  async function refreshNotes() {
    // No progress reporting here: rebuilds happen while the page is up, where
    // status belongs in the page log, not drawn over the terminal.
    notes = await buildNotes(target);
    broadcast("notes", { count: notes.length });
  }

  function noteFor(rel) {
    return notes.find((n) => n.rel === rel) || null;
  }

  /** Resolves a target-relative path, refusing anything that escapes it. */
  function resolveInside(rel) {
    const cleaned = String(rel ?? "").split("/").filter((s) => s && s !== "." && s !== "..").join(path.sep);
    const full = path.resolve(target, cleaned);
    if (full !== target && !full.startsWith(target + path.sep)) return null;
    return full;
  }

  function sendJson(res, status, data) {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 5e6) reject(new Error("Request body too large"));
      });
      req.on("end", () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Malformed JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  // Both probes are PATH lookups, so they're cheap enough to redo per request -
  // which also means the page notices an install done in another terminal as
  // soon as it refreshes, with nothing to invalidate.
  async function dependencyStatus() {
    const [ffmpeg, whisper] = await checkDependencies(["ffmpeg", "whisper"]);
    return { ffmpeg: ffmpeg.found, whisper: whisper.found };
  }

  // Whether each model is already downloaded, so the picker can say so rather
  // than the user finding out only once a transcribe job starts downloading
  // a gigabyte in the background. Cheap: resolveModel only stats + reads a
  // 4-byte header per candidate path, no network.
  async function modelAvailability() {
    const availability = {};
    for (const m of MODELS) availability[m] = (await resolveModel(m)) !== null;
    return availability;
  }

  async function stateResponse() {
    return {
      notes,
      config: {
        target,
        rootLabel: path.basename(target) || "voice notes",
        autoTranslate: currentConfig.autoTranslate ?? null,
        defaultModel: currentConfig.defaultModel || "turbo",
        transcribeLanguage: currentConfig.transcribeLanguage || "auto",
        openWhenDone: currentConfig.openWhenDone !== false,
        rememberDeletions: currentConfig.rememberDeletions !== false,
        sources: currentConfig.sources || [],
        audioExtensions: Array.from(AUDIO_EXTENSIONS).sort(),
        // Only the answer is the browser's to change; the backend itself is
        // fixed by whichever whisper.cpp build `vno setup` installed, since
        // the page can't run an installer.
        gpu: {
          checked: accelState(currentConfig).backend !== null,
          available: accelState(currentConfig).backend !== null && accelState(currentConfig).backend !== "cpu",
          name: accelState(currentConfig).name,
          use: accelState(currentConfig).use,
          active: resolveAccel(currentConfig) !== "cpu",
        },
        configPath: configFilePath(),
      },
      models: MODELS,
      modelAvailability: await modelAvailability(),
      languages: LANGUAGES,
      ...(await dependencyStatus()),
      job,
    };
  }

  /* --------------------------------- jobs -------------------------------- */

  function startJob(kind, title, total) {
    job = { id: crypto.randomUUID(), kind, title, total, done: 0, running: true, error: null, lines: [] };
    broadcast("job", job);
    return job;
  }

  function jobLog(line) {
    if (!job) return;
    job.lines.push(line);
    if (job.lines.length > 200) job.lines.shift();
    broadcast("job", job);
  }

  function jobProgress(done, title) {
    if (!job) return;
    job.done = done;
    if (title) job.title = title;
    broadcast("job", job);
  }

  async function endJob(error) {
    if (!job) return;
    job.running = false;
    job.error = error ? String(error.message || error) : null;
    broadcast("job", job);
    await refreshNotes();
  }

  function guardJob(res) {
    if (job && job.running) {
      sendJson(res, 409, { error: `Busy: ${job.title}` });
      return true;
    }
    return false;
  }

  /* ------------------------- shared file mutation ------------------------ */

  /**
   * Deletes an audio file plus any transcript sidecars. Returns the file count
   * and, when the recording itself was really there, the `{ rel, size }` the
   * deletion ledger needs - read before the delete, since it can't be after.
   * Callers record the entries themselves so a batch is one ledger write.
   */
  async function removeRecording(rel) {
    const audio = resolveInside(rel);
    if (!audio) throw new Error("Path outside the target folder");

    let size = null;
    let existed = false;
    try {
      const stat = await fs.stat(audio);
      existed = stat.isFile();
      size = stat.size;
    } catch {
      // already gone, or unreadable - the sidecars are still worth clearing
    }

    const base = audio.slice(0, -path.extname(audio).length);
    let removed = 0;
    for (const file of [audio, ...TRANSCRIPT_EXTS.map((ext) => base + ext)]) {
      if (await fs.pathExists(file)) {
        await fs.remove(file);
        removed++;
      }
    }
    return { removed, entry: existed ? { rel, size } : null };
  }

  /** Writes a batch of deletions to the ledger, honouring the config switch. */
  function remember(entries, via) {
    return recordDeletions(
      target,
      entries.map((entry) => ({ ...entry, via })),
      { enabled: currentConfig.rememberDeletions !== false }
    );
  }

  return {
    target,
    get notes() {
      return notes;
    },
    set notes(v) {
      notes = v;
    },
    get config() {
      return currentConfig;
    },
    async saveConfig() {
      await saveConfig(currentConfig);
    },
    get job() {
      return job;
    },
    clients,
    log: (msg) => console.log(chalk.dim(msg)),
    broadcast,
    sendJson,
    readBody,
    noteFor,
    resolveInside,
    refreshNotes,
    dependencyStatus,
    modelAvailability,
    stateResponse,
    startJob,
    jobLog,
    jobProgress,
    endJob,
    guardJob,
    removeRecording,
    remember,
  };
}
