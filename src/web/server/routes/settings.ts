import { accelState, crossLanguageState } from "../../../lib/whisper/whisper.ts";
import { decodeState, isDecodeMode, sanitizeManualDecode } from "../../../lib/whisper/decodeProfile.ts";
import { resolveModelsDir as resolveWhisperModelsDir } from "../../../lib/whisper/whispercpp.ts";
import { resolveModelsDir as resolveLlamaModelsDir } from "../../../lib/llama/llamacpp.ts";
import { sourceDestFolder } from "../../../lib/import/sync.ts";
import { openPath } from "../../../lib/open.ts";
import { THEME_IDS } from "../../../lib/shared/themes.ts";
import { isLanguageChoice, normalizeLanguageMap } from "../../../lib/shared/languages.ts";
import { MODELS } from "../constants.ts";
import type { ServerContext } from "../context.ts";
import type { RawSource, Source, ThemeId } from "../../../types.ts";

/** The settings dialog posts one flat scalar per field it changed. */
interface SettingsBody {
  autoTranslate?: boolean | null;
  defaultModel?: string;
  transcribeLanguage?: string;
  crossLanguageModel?: string | null;
  crossLanguageMap?: unknown;
  summaryModel?: string | null;
  summaryPrompt?: string | null;
  summaryEnabled?: unknown;
  theme?: string;
  openWhenDone?: unknown;
  rememberDeletions?: unknown;
  useGpu?: unknown;
  decodeMode?: unknown;
  decodeManual?: unknown;
}

/** POST /api/settings, POST /api/sources, POST /api/sources/explore. */
export function createSettingsRoutes(ctx: ServerContext) {
  async function settings(body: SettingsBody): Promise<Response> {
    const config = ctx.config;
    if ("autoTranslate" in body) config.autoTranslate = body.autoTranslate ?? null;
    if ("defaultModel" in body && MODELS.includes(body.defaultModel!)) {
      config.defaultModel = body.defaultModel!;
    }
    if ("transcribeLanguage" in body && isLanguageChoice(body.transcribeLanguage)) {
      config.transcribeLanguage = body.transcribeLanguage;
    }
    // Rebuilt from the stored block rather than assigned wholesale, the way
    // `useGpu` is below: the two halves arrive as separate scalars, so a
    // client sending only one can't blank the other.
    if ("crossLanguageModel" in body) {
      const model = MODELS.includes(body.crossLanguageModel!) ? body.crossLanguageModel! : null;
      config.crossLanguage = { ...crossLanguageState(config), model };
    }
    if ("crossLanguageMap" in body) {
      config.crossLanguage = {
        ...crossLanguageState(config),
        map: normalizeLanguageMap(body.crossLanguageMap),
      };
    }
    // Validated against what's actually discovered on disk, not a fixed
    // catalog - a dropped-in .gguf is a legitimate choice too.
    if ("summaryModel" in body) {
      const { models } = await ctx.summarizationStatus();
      config.summaryModel = body.summaryModel && models.includes(body.summaryModel) ? body.summaryModel : null;
    }
    // A whitespace-only override is silently treated as "not set" rather than
    // rejected - it's what you get from typing then deleting, and storing it
    // verbatim would prefix every summarization prompt with blank lines.
    if ("summaryPrompt" in body) {
      const trimmed = typeof body.summaryPrompt === "string" ? body.summaryPrompt.trim() : "";
      config.summaryPrompt = trimmed || null;
    }
    // Hides the deck's Summary tab/action only - never touches summaryModel,
    // summaryPrompt, or any already-generated .summary.txt sidecar, so
    // turning it back on picks up right where it left off.
    if ("summaryEnabled" in body) config.summaryEnabled = Boolean(body.summaryEnabled);
    if ("theme" in body && (THEME_IDS as readonly string[]).includes(body.theme!)) {
      config.theme = body.theme as ThemeId;
    }
    // Split into two scalars for the same reason `crossLanguage` is: the mode
    // select and the flag rows are separate controls, and a client posting
    // one must not blank the other. An unrecognised mode is dropped rather
    // than stored - `decodeState` would silently fall back to "adaptive" on
    // read anyway, and writing junk into config.json helps nobody.
    if ("decodeMode" in body && isDecodeMode(body.decodeMode)) {
      config.decode = { ...decodeState(config), mode: body.decodeMode };
    }
    if ("decodeManual" in body) {
      config.decode = { ...decodeState(config), manual: sanitizeManualDecode(body.decodeManual) };
    }
    if ("openWhenDone" in body) config.openWhenDone = Boolean(body.openWhenDone);
    if ("rememberDeletions" in body) config.rememberDeletions = Boolean(body.rememberDeletions);
    // `useGpu` and not the whole accel block: the installed backend is
    // server-owned, so a client can't claim an accelerator this machine
    // hasn't got.
    if ("useGpu" in body) {
      config.accel = { ...accelState(config), use: Boolean(body.useGpu) };
    }
    await ctx.saveConfig();
    ctx.log("Settings updated from the browser.");
    return ctx.sendJson(200, { config: (await ctx.stateResponse()).config });
  }

  // `sources` is array-shaped, so it's replaced wholesale here rather than
  // through the flat `if (key in body)` scalar guards above.
  async function sources(body: { sources?: unknown }): Promise<Response> {
    const list: RawSource[] = Array.isArray(body.sources) ? body.sources : [];
    for (const s of list) {
      if (!s || typeof s !== "object" || typeof s.path !== "string" || !s.path.trim()) {
        return ctx.sendJson(400, { error: "Every source needs a folder path" });
      }
    }
    ctx.config.sources = (list as Exclude<RawSource, string>[]).map(
      (s): Source => ({
        path: s.path.trim(),
        pattern: (s.pattern || "*").trim() || "*",
        deleteAfterImport: Boolean(s.deleteAfterImport),
        recursive: Boolean(s.recursive),
        mapTo: typeof s.mapTo === "string" && s.mapTo.trim() ? s.mapTo.trim().replace(/\\/g, "/") : null,
      })
    );
    await ctx.saveConfig();
    ctx.log("Source folders updated from the browser.");
    return ctx.sendJson(200, { config: (await ctx.stateResponse()).config });
  }

  // Opens the folder a source's files currently live in (or will, on the
  // next sync) - not confined via ctx.resolveInside like /api/reveal, since
  // a source with no `mapTo` lands outside `target` for the input (the
  // source's own `path`) but the *computed destination* is always inside
  // `target` (sourceDestFolder mirrors syncVolume's own destRoot rule), so
  // it's safe to open directly.
  async function exploreSourceDest(body: { path?: unknown; mapTo?: unknown }): Promise<Response> {
    const srcPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!srcPath) return ctx.sendJson(400, { error: "Missing source path" });
    const mapTo = typeof body.mapTo === "string" && body.mapTo.trim() ? body.mapTo.trim() : null;
    const dest = sourceDestFolder({ path: srcPath, mapTo }, ctx.target);
    openPath(dest);
    return ctx.sendJson(200, { opened: dest });
  }

  // Opens the folder holding the whisper.cpp / llama.cpp model files on
  // disk, so the user can add or remove .bin/.gguf files by hand without
  // hunting for vno's install location themselves.
  async function openModelsDir(body: { engine?: unknown }): Promise<Response> {
    const dir = body.engine === "llama" ? await resolveLlamaModelsDir() : await resolveWhisperModelsDir();
    openPath(dir);
    return ctx.sendJson(200, { opened: dir });
  }

  return { settings, sources, exploreSourceDest, openModelsDir };
}
