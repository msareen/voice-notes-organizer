/**
 * Decode settings -> whisper.cpp flags, and the escalation ladder the
 * "adaptive" mode climbs.
 *
 * The problem this exists for: whisper the model falls into repetition loops
 * and invents text over silence, and how often it does that depends on the
 * machine. The same recording can be clean on a CUDA box and a wall of
 * repeated sentences on Apple Silicon. So there's no one right set of flags
 * to hardcode - what there is, is an ordering of increasingly conservative
 * (and increasingly slow) ones to try until the output stops looking broken.
 *
 * Note what whisper.cpp does *not* have: no repetition penalty, no
 * no-repeat-ngram-size. The equivalents other whisper front-ends reach for
 * simply aren't exposed by the CLI, so the anti-loop rungs below are built
 * out of what is: `-mc 0` (stop carrying decoded text between 30s windows,
 * so a loop can't propagate), a tighter `-et` (retry a high-entropy window at
 * a higher temperature sooner), `-sns` (suppress the non-speech tokens
 * phantom text grows out of), and `-nfa` (drop flash attention, whose Metal
 * kernel is the usual suspect for Mac-only garbage).
 *
 * Deciding *whether* a transcript is broken is detect-hallucination.ts's job; this
 * module only says what to try next.
 */
import type { Config, DecodeMode, DecodeSettings, ManualDecode } from "../../types.ts";

/** One rung of the ladder: a name for the log, and what to change. */
export interface DecodeProfile {
  /** Short label, printed as the run escalates so the log says what fixed it. */
  name: string;
  /** Flags for this rung. */
  knobs: ManualDecode;
  /**
   * Model to use instead of the one the caller asked for, or null to keep it.
   * A rung that names a model is skipped when it isn't downloaded - a
   * transcription job is no place to start a multi-gigabyte fetch.
   */
  model?: string | null;
}

/** What transcribeFile is handed: which mode, and the flags that go with it. */
export interface DecodePlan {
  mode: DecodeMode;
  /** The first (often only) pass's flags. Empty-equivalent for "auto"/"adaptive". */
  knobs: ManualDecode;
}

/** Every field off, i.e. exactly whisper.cpp's own defaults. */
export function neutralKnobs(): ManualDecode {
  return {
    vad: false,
    vadThreshold: null,
    carryContext: null,
    entropyThold: null,
    logprobThold: null,
    noSpeechThold: null,
    beamSize: null,
    bestOf: null,
    temperatureInc: null,
    flashAttn: null,
    suppressNst: false,
  };
}

/** What the decode helpers accept: a whole config, or just the block. */
type DecodeConfigLike = { decode?: Partial<DecodeSettings> | null } | null | undefined;

const MODES: DecodeMode[] = ["auto", "adaptive", "manual"];

export function isDecodeMode(value: unknown): value is DecodeMode {
  return typeof value === "string" && (MODES as string[]).includes(value);
}

/**
 * The `decode` block, defaulted, for a config that predates the setting -
 * the `accelState`/`crossLanguageState` of decoding, and there for the same
 * reason: a hand-edited or older config.json must still come back with every
 * field present.
 */
export function decodeState(config: DecodeConfigLike): DecodeSettings {
  const raw = config?.decode || {};
  return {
    mode: isDecodeMode(raw.mode) ? raw.mode : "adaptive",
    manual: { ...neutralKnobs(), ...(raw.manual || {}) },
  };
}

/**
 * Coerces an untrusted `manual` block - what the browser Settings dialog
 * posts, or what someone left in a hand-edited config.json - into a usable
 * one. Unparseable and out-of-range values become `null` (leave whisper.cpp
 * alone) rather than being rejected: a bad number in one field must not cost
 * the user the other ten.
 *
 * The bounds are sanity rails, not tuning advice. They exist because these
 * values reach a spawned process's argv, and a beam size of 10,000 is a
 * machine that stops responding rather than an error message.
 */
export function sanitizeManualDecode(raw: unknown): ManualDecode {
  const input = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const num = (key: string, min: number, max: number): number | null => {
    const value = input[key];
    if (value === null || value === undefined || value === "") return null;
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < min || parsed > max) return null;
    return parsed;
  };
  const int = (key: string, min: number, max: number): number | null => {
    const parsed = num(key, min, max);
    return parsed === null ? null : Math.round(parsed);
  };
  // Three-state, so `undefined` (field absent) and `null` (explicitly "leave
  // it to whisper.cpp") both have to survive as null rather than becoming false.
  const tri = (key: string): boolean | null => {
    const value = input[key];
    if (value === null || value === undefined || value === "") return null;
    return Boolean(value);
  };

  return {
    vad: Boolean(input.vad),
    vadThreshold: num("vadThreshold", 0, 1),
    carryContext: tri("carryContext"),
    entropyThold: num("entropyThold", 0, 10),
    logprobThold: num("logprobThold", -10, 0),
    noSpeechThold: num("noSpeechThold", 0, 1),
    beamSize: int("beamSize", 1, 32),
    bestOf: int("bestOf", 1, 32),
    temperatureInc: num("temperatureInc", 0, 1),
    flashAttn: tri("flashAttn"),
    suppressNst: Boolean(input.suppressNst),
  };
}

/**
 * Everything the decode decision needs, read from config in one place - the
 * `resolveLanguagePlan` of decoding, and for the same reason: the browser has
 * nowhere to ask at job time, so the rule has to live somewhere every caller
 * (import, transcribe, the web job runner) reaches rather than being
 * re-derived at each call site.
 *
 * `override` is a per-run mode pin (`vno t --decode auto`) - it wins outright
 * without being written back to config, since it's a one-off for this run.
 * It's the fastest way to A/B a suspect recording against today's behaviour.
 */
export function resolveDecodePlan(
  config: Partial<Config> | null | undefined,
  override?: string | null
): DecodePlan {
  const settings = decodeState(config);
  const mode = isDecodeMode(override) ? override : settings.mode;
  // Only "manual" reads the stored flags. "auto" and "adaptive" both start
  // from whisper.cpp's defaults - adaptive just doesn't necessarily stop there.
  return { mode, knobs: mode === "manual" ? settings.manual : neutralKnobs() };
}

/**
 * whisper.cpp arguments for one set of knobs. Only fields the user (or a
 * ladder rung) actually set produce a flag - see ManualDecode on why `null`
 * has to mean "say nothing" rather than "pass the default".
 *
 * `vadModelPath` is the resolved ggml-silero-*.bin, or null if it isn't
 * downloaded; without it `--vad` is dropped rather than passed, since
 * whisper.cpp exits on a `--vad` it can't find a model for and a missing
 * optional extra must never cost the user their transcript.
 */
export function decodeArgs(knobs: ManualDecode, vadModelPath: string | null = null): string[] {
  const args: string[] = [];

  if (knobs.vad && vadModelPath) {
    args.push("--vad", "-vm", vadModelPath);
    if (knobs.vadThreshold != null) args.push("-vt", String(knobs.vadThreshold));
  }
  // `-mc 0` for "don't carry it". There's no flag for the positive case:
  // whisper.cpp's own default (-1, keep as much as fits) is what you get by
  // saying nothing, so `true` and `null` are the same argv.
  if (knobs.carryContext === false) args.push("-mc", "0");
  if (knobs.entropyThold != null) args.push("-et", String(knobs.entropyThold));
  if (knobs.logprobThold != null) args.push("-lpt", String(knobs.logprobThold));
  if (knobs.noSpeechThold != null) args.push("-nth", String(knobs.noSpeechThold));
  if (knobs.beamSize != null) args.push("-bs", String(knobs.beamSize));
  if (knobs.bestOf != null) args.push("-bo", String(knobs.bestOf));
  // A step of 0 would make whisper.cpp retry a failed window at the same
  // temperature forever, so it means "don't fall back at all" - which is what
  // `-nf` is for. Anything else is a real step.
  if (knobs.temperatureInc != null) {
    if (knobs.temperatureInc === 0) args.push("-nf");
    else args.push("-tpi", String(knobs.temperatureInc));
  }
  if (knobs.flashAttn === true) args.push("-fa");
  if (knobs.flashAttn === false) args.push("-nfa");
  if (knobs.suppressNst) args.push("-sns");

  return args;
}

/** True when these knobs would change nothing about the run. */
export function isNeutral(knobs: ManualDecode): boolean {
  return decodeArgs(knobs, "/vad").length === 0;
}

/**
 * The anti-loop flag set every escalation rung shares. Kept separate from the
 * rungs so the ladder below reads as "this, plus one more idea each time".
 *
 * `-mc 0` is the load-bearing one. The rest tighten the thresholds that
 * decide when whisper.cpp gives up on a window and retries it hotter, and
 * stop it emitting the non-speech tokens that phantom sentences grow from.
 */
const ANTI_LOOP: ManualDecode = {
  ...neutralKnobs(),
  vad: true,
  vadThreshold: 0.6,
  carryContext: false,
  entropyThold: 2.0,
  suppressNst: true,
};

/**
 * What "adaptive" tries, in order, when the previous rung's transcript looks
 * hallucinated. L0 isn't here because L0 is whatever the caller asked for -
 * for "adaptive" that's whisper.cpp's defaults, i.e. exactly what "auto"
 * does. That's the whole reason adaptive is safe as the default: a recording
 * that transcribes cleanly never reaches this list.
 *
 * Ordered by cost. Rungs 1 and 2 are the same model at roughly the same
 * speed; rung 3 is a different, much larger model and is last for that
 * reason alone.
 *
 * There's deliberately no CPU (`-ng`) rung. It would only ever fire on a file
 * that already survived three retries, and a CPU-only pass on a long
 * recording is slow enough that it should be the user's own decision (the GPU
 * acceleration setting) rather than something a background job takes.
 */
export const LADDER: DecodeProfile[] = [
  // L1 - same model, stop carrying context between windows and tighten the
  // fallback thresholds. Costs almost nothing and fixes most loops.
  { name: "anti-loop", knobs: ANTI_LOOP },

  // L2 - drop flash attention. whisper.cpp v1.9.x turns it on by default and
  // its Metal kernel is the usual suspect when output is broken on a Mac and
  // fine everywhere else. Costs throughput, nothing else.
  { name: "no-flash-attn", knobs: { ...ANTI_LOOP, flashAttn: false } },

  // L3 - fall off turbo. large-v3-turbo is a distillation with a 4-layer
  // decoder against large-v3's 32; escaping a loop is exactly the kind of
  // capacity that gets distilled away. Much slower, and skipped entirely
  // when large-v3 isn't already downloaded.
  { name: "off-turbo", knobs: ANTI_LOOP, model: "large-v3" },
];
