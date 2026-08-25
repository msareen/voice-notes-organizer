import crypto from "node:crypto";
import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { saveConfig, configFilePath } from "../../lib/config.ts";
import { buildNotes, TRANSCRIPT_EXTS, SUMMARY_EXT } from "../../lib/notes.ts";
import { accelState, resolveAccel, crossLanguageState } from "../../lib/whisper.ts";
import { resolveModel } from "../../lib/whispercpp.ts";
import { isLlamaInstalled } from "../../lib/llama.ts";
import { listModels as listLlamaModels } from "../../lib/llamacpp.ts";
import { checkDependencies } from "../../lib/setup.ts";
import { recordDeletions } from "../../lib/ledger.ts";
import { MEDIA_EXTENSIONS } from "../../lib/sync.ts";
import { THEMES, themeOf } from "../../lib/themes.ts";
import { MODELS, LANGUAGES } from "./constants.ts";
import type {
  Config,
  Job,
  Note,
  ProgressCallback,
  StateResponse,
} from "../../types.ts";
import type { DeletionItem } from "../../lib/ledger.ts";

/** What `removeRecording` reports back for the ledger. */
export interface RemovalResult {
  removed: number;
  /** null when the recording itself wasn't there to begin with. */
  entry: { rel: string; size: number | null } | null;
}

/**
 * The shared mutable state and helpers every route module closes over.
 * `index.ts` attaches the three lifecycle methods once the http.Server exists,
 * which is why they're declared here but not returned by `createContext`.
 */
export interface ServerContext {
  readonly target: string;
  notes: Note[];
  readonly config: Config;
  saveConfig(): Promise<void>;
  readonly job: Job | null;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
  log(msg: string): void;
  broadcast(event: string, data?: unknown): void;
  sendJson(status: number, data: unknown): Response;
  readBody(req: Request): Promise<any>;
  noteFor(rel: string): Note | null;
  /** Absolute path for a target-relative `rel`, or null if it escapes the target. */
  resolveInside(rel: string | null | undefined): string | null;
  refreshNotes(): Promise<void>;
  dependencyStatus(): Promise<{ ffmpeg: boolean; whisper: boolean; llama: boolean }>;
  modelAvailability(): Promise<Record<string, boolean>>;
  /** Optional: whether summarization (llama.cpp + at least one valid model) is usable right now. */
  summarizationStatus(): Promise<{ available: boolean; models: string[] }>;
  stateResponse(): Promise<StateResponse>;
  startJob(kind: string, title: string, total: number): Job;
  jobLog(line: string): void;
  jobProgress(done: number, title?: string): void;
  endJob(error?: unknown): Promise<void>;
  /** Returns a 409 Response when a job is already running, null otherwise. */
  guardJob(): Response | null;
  removeRecording(rel: string): Promise<RemovalResult>;
  remember(entries: { rel: string; size: number | null }[], via: string): Promise<number>;

  // Attached by index.ts, which owns the server and socket lifecycle.
  /** Resolves with the reason once the server has actually closed. */
  stop(reason: string): Promise<string>;
  /** Defers shutdown by `delay` ms, so a reload doesn't end the session. */
  scheduleShutdown(reason: string, delay: number): void;
  cancelShutdown(): void;
}

export interface ContextOptions {
  config: Config;
  target: string;
  onScanProgress?: ProgressCallback | null;
}

/**
 * Builds the shared context. The returned object is missing the three
 * lifecycle methods until `index.ts` attaches them, which is why it's typed as
 * the full `ServerContext` only once that has happened.
 */
export async function createContext({
  config,
  target,
  onScanProgress,
}: ContextOptions): Promise<ServerContext> {
  // Notes are expensive to build (an ffprobe per file), so they're cached and
  // rebuilt only when something actually changes them.
  let notes = await buildNotes(target, { onProgress: onScanProgress });
  const currentConfig = config;
  let job: Job | null = null; // at most one long-running job at a time

  const clients = new Set<ReadableStreamDefaultController<Uint8Array>>(); // open SSE streams
  const encoder = new TextEncoder();

  function broadcast(event: string, data?: unknown): void {
    const payload = encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`);
    for (const client of clients) {
      try {
        client.enqueue(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  async function refreshNotes(): Promise<void> {
    // No progress reporting here: rebuilds happen while the page is up, where
    // status belongs in the page log, not drawn over the terminal.
    notes = await buildNotes(target);
    broadcast("notes", { count: notes.length });
  }

  function noteFor(rel: string): Note | null {
    return notes.find((n) => n.rel === rel) || null;
  }

  /** Resolves a target-relative path, refusing anything that escapes it. */
  function resolveInside(rel: string | null | undefined): string | null {
    const cleaned = String(rel ?? "").split("/").filter((s) => s && s !== "." && s !== "..").join(path.sep);
    const full = path.resolve(target, cleaned);
    if (full !== target && !full.startsWith(target + path.sep)) return null;
    return full;
  }

  function sendJson(status: number, data: unknown): Response {
    return Response.json(data, { status, headers: { "Cache-Control": "no-store" } });
  }

  async function readBody(req: Request): Promise<any> {
    const raw = await req.text();
    if (raw.length > 5e6) throw new Error("Request body too large");
    if (!raw) return {};
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error("Malformed JSON body");
    }
  }

  // Both probes are PATH lookups, so they're cheap enough to redo per request -
  // which also means the page notices an install done in another terminal as
  // soon as it refreshes, with nothing to invalidate.
  async function dependencyStatus(): Promise<{ ffmpeg: boolean; whisper: boolean; llama: boolean }> {
    const [ffmpeg, whisper] = await checkDependencies(["ffmpeg", "whisper"]);
    // llama.cpp is optional, so unlike ffmpeg/whisper this never gates
    // anything on its own - callers decide what "not installed" means for
    // them (the summarize route 412s; everything else ignores it).
    const llama = await isLlamaInstalled();
    return { ffmpeg: ffmpeg.found, whisper: whisper.found, llama };
  }

  // Mirrors dependencyStatus's llama check but also requires at least one
  // valid model - the deck's Summarize action and Settings' model picker
  // both need "genuinely usable right now", not just "the binary exists".
  async function summarizationStatus(): Promise<{ available: boolean; models: string[] }> {
    const llama = await isLlamaInstalled();
    if (!llama) return { available: false, models: [] };
    const entries = await listLlamaModels();
    const models = entries.filter((m) => m.valid).map((m) => m.filename);
    return { available: models.length > 0, models };
  }

  // Whether each model is already downloaded, so the picker can say so rather
  // than the user finding out only once a transcribe job starts downloading
  // a gigabyte in the background. Cheap: resolveModel only stats + reads a
  // 4-byte header per candidate path, no network.
  async function modelAvailability(): Promise<Record<string, boolean>> {
    const availability: Record<string, boolean> = {};
    for (const m of MODELS) availability[m] = (await resolveModel(m)) !== null;
    return availability;
  }

  async function stateResponse(): Promise<StateResponse> {
    const deps = await dependencyStatus();
    return {
      notes,
      config: {
        target,
        rootLabel: path.basename(target) || "voice notes",
        autoTranslate: currentConfig.autoTranslate ?? null,
        defaultModel: currentConfig.defaultModel || "turbo",
        transcribeLanguage: currentConfig.transcribeLanguage || "auto",
        summaryModel: currentConfig.summaryModel ?? null,
        // Guides auto-detect rather than overriding it - see
        // lib/config.ts:crossLanguage. Sent through the same defaulting
        // helper the transcribe path uses, so the dialog and the job can't
        // disagree about what an older config means.
        crossLanguage: crossLanguageState(currentConfig),
        openWhenDone: currentConfig.openWhenDone !== false,
        rememberDeletions: currentConfig.rememberDeletions !== false,
        theme: themeOf(currentConfig),
        sources: currentConfig.sources || [],
        mediaExtensions: Array.from(MEDIA_EXTENSIONS).sort(),
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
      themes: THEMES,
      ffmpeg: deps.ffmpeg,
      whisper: deps.whisper,
      summarization: await summarizationStatus(),
      job,
    };
  }

  /* --------------------------------- jobs -------------------------------- */

  function startJob(kind: string, title: string, total: number): Job {
    job = { id: crypto.randomUUID(), kind, title, total, done: 0, running: true, error: null, lines: [] };
    broadcast("job", job);
    return job;
  }

  function jobLog(line: string): void {
    if (!job) return;
    job.lines.push(line);
    if (job.lines.length > 200) job.lines.shift();
    broadcast("job", job);
  }

  function jobProgress(done: number, title?: string): void {
    if (!job) return;
    job.done = done;
    if (title) job.title = title;
    broadcast("job", job);
  }

  async function endJob(error?: unknown): Promise<void> {
    if (!job) return;
    job.running = false;
    job.error = error ? String((error as Error)?.message || error) : null;
    broadcast("job", job);
    await refreshNotes();
  }

  function guardJob(): Response | null {
    if (job && job.running) return sendJson(409, { error: `Busy: ${job.title}` });
    return null;
  }

  /* ------------------------- shared file mutation ------------------------ */

  /**
   * Deletes an audio file plus any transcript sidecars. Returns the file count
   * and, when the recording itself was really there, the `{ rel, size }` the
   * deletion ledger needs - read before the delete, since it can't be after.
   * Callers record the entries themselves so a batch is one ledger write.
   */
  async function removeRecording(rel: string): Promise<RemovalResult> {
    const audio = resolveInside(rel);
    if (!audio) throw new Error("Path outside the target folder");

    let size: number | null = null;
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
    for (const file of [audio, ...TRANSCRIPT_EXTS.map((ext) => base + ext), base + SUMMARY_EXT]) {
      if (await fs.pathExists(file)) {
        await fs.remove(file);
        removed++;
      }
    }
    return { removed, entry: existed ? { rel, size } : null };
  }

  /** Writes a batch of deletions to the ledger, honouring the config switch. */
  function remember(entries: { rel: string; size: number | null }[], via: string): Promise<number> {
    return recordDeletions(
      target,
      entries.map((entry): DeletionItem => ({ ...entry, via })),
      { enabled: currentConfig.rememberDeletions !== false }
    );
  }

  // The three lifecycle methods are attached by index.ts once the http.Server
  // exists; until then calling one is a programming error, not a runtime path.
  const notAttached = (name: string) => () => {
    throw new Error(`ctx.${name} was called before index.ts attached it`);
  };

  return {
    target,
    get notes() {
      return notes;
    },
    set notes(v: Note[]) {
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
    log: (msg: string) => console.log(chalk.dim(msg)),
    broadcast,
    sendJson,
    readBody,
    noteFor,
    resolveInside,
    refreshNotes,
    dependencyStatus,
    modelAvailability,
    summarizationStatus,
    stateResponse,
    startJob,
    jobLog,
    jobProgress,
    endJob,
    guardJob,
    removeRecording,
    remember,
    stop: notAttached("stop"),
    scheduleShutdown: notAttached("scheduleShutdown"),
    cancelShutdown: notAttached("cancelShutdown"),
  };
}
