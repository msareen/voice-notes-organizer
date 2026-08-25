import { accelState, crossLanguageState } from "../../../lib/whisper.ts";
import { sourceDestFolder } from "../../../lib/sync.ts";
import { openPath } from "../../../lib/open.ts";
import { THEME_IDS } from "../../../lib/themes.ts";
import { isLanguageChoice, normalizeLanguageMap } from "../../../lib/languages.ts";
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
  theme?: string;
  openWhenDone?: unknown;
  rememberDeletions?: unknown;
  useGpu?: unknown;
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
    if ("theme" in body && (THEME_IDS as readonly string[]).includes(body.theme!)) {
      config.theme = body.theme as ThemeId;
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

  return { settings, sources, exploreSourceDest };
}
