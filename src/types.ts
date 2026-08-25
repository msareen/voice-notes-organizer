/**
 * The domain types shared by every layer: lib/, cli/, web/server/ and the
 * browser modules under web/assets/.
 *
 * Types only, and deliberately no imports — this file must stay loadable by
 * the browser project, which has no Node or Bun globals. Every consumer pulls
 * from it with `import type`, so under `verbatimModuleSyntax` the import is
 * erased and nothing is ever fetched at runtime.
 */

// ---------------------------------------------------------------------------
// Config (~/.vno/config.json) — see lib/config.ts for what each field means.
// ---------------------------------------------------------------------------

/** One manually-configured import source, normalised by `normalizeSources`. */
export interface Source {
  path: string;
  /** "*"/"?" wildcard against the filename; "*" means any audio-extension file. */
  pattern: string;
  deleteAfterImport: boolean;
  recursive: boolean;
  /** Target-relative landing folder, or null for basename-of-path. */
  mapTo: string | null;
}

/** A source as it may appear in a hand-edited config, before normalisation. */
export type RawSource = string | Partial<Source> & { path: string };

/** What `vno import` remembers about a volume it has seen before. */
export interface KnownMount {
  name?: string;
  autoImport?: boolean;
  /** A pinned subfolder of the volume to sync from, relative to its root. */
  sourceSubdir?: string | null;
  lastSynced?: string | null;
  lastResult?: { copied: number; skipped: number; total: number };
}

/** whisper.cpp's accelerator backend, fixed at install time, never probed. */
export interface AccelState {
  backend: AccelBackend | null;
  name: string | null;
  use: boolean | null;
  resolvedAt: string | null;
}

/**
 * "unknown" is a real value, not a placeholder: `registerExternalBinary`
 * records it for a binary the user pointed vno at without saying whether it
 * has GPU support, and `resolveAccel` deliberately treats it as non-CPU so the
 * run tries the accelerator and falls back on failure.
 */
export type AccelBackend = "cpu" | "cuda" | "metal" | "vulkan" | "unknown";

/**
 * Guides whisper.cpp's auto-detect rather than overriding it. Only consulted
 * when `transcribeLanguage` is "auto".
 */
export interface CrossLanguage {
  /** Model for the fast `-dl` detection pass, or null to skip it. */
  model: string | null;
  /** Rewrites what that pass returns, e.g. `{ ur: "hi" }`. */
  map: Record<string, string>;
}

export interface Config {
  target: string;
  sources: Source[];
  knownMounts: Record<string, KnownMount>;
  /** null = never asked, so import offers once and remembers the answer. */
  autoTranslate: boolean | null;
  defaultModel: string;
  /** ISO-639-1 code, or "auto" to detect per file. */
  transcribeLanguage: string;
  crossLanguage: CrossLanguage;
  rememberDeletions: boolean;
  openWhenDone: boolean;
  /** Port the viewer serves on. See cli/visualize.ts:DEFAULT_PORT for why it's fixed rather than picked per run. */
  port: number;
  theme: ThemeId;
  accel: AccelState;
  /** The llama.cpp model to summarize with, by alias/filename - null until configured. Summarization is entirely optional; see lib/llamacpp.ts. */
  summaryModel: string | null;
  /** llama.cpp's accelerator backend, fixed at install time, mirroring `accel` above. */
  llamaAccel: AccelState;
  /** Replaces lib/llama.ts's default instruction wholesale when set - null (or whitespace-only) means "use the built-in one". */
  summaryPrompt: string | null;
  /**
   * Manual override for where the llama.cpp binary lives - set when PATH
   * lookup right after a fresh `winget`/`brew` install isn't reliable in the
   * same shell session. Checked before PATH; null means "trust PATH".
   */
  llamaCliPath: string | null;
}

// ---------------------------------------------------------------------------
// Themes — ids only. Palettes live in web/assets/app.css.
// ---------------------------------------------------------------------------

export type ThemeId = "auto" | "tape" | "dusk" | "moss" | "daylight" | "contrast";

export interface Theme {
  id: ThemeId;
  label: string;
  blurb: string;
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/** One timed transcript cue. `start`/`end` are seconds. */
export interface Cue {
  start: number;
  end: number;
  text: string;
}

export type TranscriptExt = ".vtt" | ".srt" | ".txt";

export interface TranscriptRead {
  cues: Cue[];
  /** The whole transcript as text; shown when there are no cues. */
  text: string;
  hasTranscript: boolean;
  transcriptExt: TranscriptExt | null;
}

// ---------------------------------------------------------------------------
// Notes — the per-recording model the page renders from.
// ---------------------------------------------------------------------------

export interface Note {
  /** Target-relative, forward-slash path. The note id in every API call. */
  rel: string;
  title: string;
  /** Folder relative to target, "" for the target root. */
  dir: string;
  name: string;
  /** URL for the media route. */
  src: string;
  cues: Cue[];
  text: string;
  hasTranscript: boolean;
  transcriptExt: TranscriptExt | null;
  /** From the <name>.summary.txt sidecar, if one exists. Optional feature — see lib/llama.ts. */
  summary: string | null;
  hasSummary: boolean;
  size: number | null;
  mtimeMs: number | null;
  durationSec: number | null;
  /** For sorting only. */
  dateMs: number | null;
  dateStr: string;
  timeStr: string;
}

/** The one field worth caching on disk — it costs an ffprobe spawn. */
export interface NotesCacheEntry {
  size: number | null;
  mtimeMs: number | null;
  durationSec: number | null;
}

export type NotesCache = Record<string, NotesCacheEntry>;

// ---------------------------------------------------------------------------
// Progress reporting — lib/ reports, callers render. See CLAUDE.md's
// "Long per-file work reports, it doesn't print."
// ---------------------------------------------------------------------------

/** Walking the tree; no total known yet. */
export interface ScanProgress {
  phase: "scan";
  dir: string;
  found: number;
}

/** Per-file work against a known total. */
export interface WorkProgress {
  phase: "work";
  done: number;
  total: number;
  dir: string;
  name: string;
}

export interface LogProgress {
  phase: "log";
  message: string;
  level?: "info" | "warn" | "error";
}

export type ProgressReport = ScanProgress | WorkProgress | LogProgress;

export type ProgressCallback = (event: ProgressReport) => void;

export interface ProgressOptions {
  onProgress?: ProgressCallback | null;
}

// ---------------------------------------------------------------------------
// Volumes
// ---------------------------------------------------------------------------

/** A detected removable volume. See lib/volumes.ts. */
export interface Volume {
  /** Human-readable label. */
  name: string;
  /** Absolute path to the mount root. */
  mountPath: string;
  /** Stable-ish identifier used as the config.knownMounts key. */
  id: string;
  sizeBytes?: number | null;
}

/**
 * What `syncVolume` actually takes: a detected volume, or a manually
 * configured source dressed as one. Every field past `Volume`'s is only ever
 * set on a configured source — see lib/sync.ts:syncVolume for what each does.
 */
export interface SyncSource extends Volume {
  /** Overrides `name` when choosing the destination folder. */
  destName?: string;
  pattern?: string;
  recursive?: boolean;
  mapTo?: string | null;
  deleteAfterImport?: boolean;
}

// ---------------------------------------------------------------------------
// The server/browser contract: the one running job, and /api/state's payload.
// ---------------------------------------------------------------------------

/** The single long-running job. `guardJob` refuses a second one with 409. */
export interface Job {
  id: string;
  /** "transcribe" | "import" | "cleanup" | "summarize", ... - not an enum, callers pick their own label. */
  kind: string;
  title: string;
  total: number;
  done: number;
  running: boolean;
  error: string | null;
  lines: string[];
}

/**
 * The config the page is allowed to see. Deliberately not the whole `Config`:
 * it's a curated projection built by `context.ts:stateResponse`, and a new
 * setting has to be added there as well as to the dialog — the dialog can't
 * show what state doesn't send.
 */
export interface StateConfig {
  target: string;
  rootLabel: string;
  autoTranslate: boolean | null;
  defaultModel: string;
  transcribeLanguage: string;
  crossLanguage: CrossLanguage;
  summaryModel: string | null;
  summaryPrompt: string | null;
  openWhenDone: boolean;
  rememberDeletions: boolean;
  theme: ThemeId;
  sources: Source[];
  mediaExtensions: string[];
  /** Only `use` is the browser's to change; the backend is fixed at install time. */
  gpu: {
    checked: boolean;
    available: boolean;
    name: string | null;
    use: boolean | null;
    active: boolean;
  };
  configPath: string;
}

/** Everything `GET /api/state` returns, and what the page renders from. */
export interface StateResponse {
  notes: Note[];
  config: StateConfig;
  models: string[];
  modelAvailability: Record<string, boolean>;
  languages: readonly { code: string; label: string }[];
  themes: readonly Theme[];
  ffmpeg: boolean;
  whisper: boolean;
  /** Optional: whether summarization (llama.cpp + at least one valid model) is usable right now. */
  summarization: { available: boolean; models: string[]; defaultPrompt: string };
  job: Job | null;
}

export interface SyncResult {
  destRoot: string;
  copied: number;
  /** Already present with a matching size. */
  skipped: number;
  /** Left alone because the deletion ledger remembers them. */
  suppressed: number;
  /** Removed from the source, only ever with `deleteAfterImport`. */
  deleted: number;
  total: number;
  copiedFiles: string[];
}
