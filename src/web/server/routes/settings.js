import { accelState } from "../../../lib/whisper.js";
import { sourceDestFolder } from "../../../lib/sync.js";
import { openPath } from "../../../lib/open.js";
import { THEME_IDS } from "../../../lib/themes.js";
import { MODELS, LANGUAGES } from "../constants.js";

/** POST /api/settings, POST /api/sources, POST /api/sources/explore. */
export function createSettingsRoutes(ctx) {
  async function settings(res, body) {
    const config = ctx.config;
    if ("autoTranslate" in body) config.autoTranslate = body.autoTranslate;
    if ("defaultModel" in body && MODELS.includes(body.defaultModel)) {
      config.defaultModel = body.defaultModel;
    }
    if ("transcribeLanguage" in body && LANGUAGES.includes(body.transcribeLanguage)) {
      config.transcribeLanguage = body.transcribeLanguage;
    }
    if ("theme" in body && THEME_IDS.includes(body.theme)) config.theme = body.theme;
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
    ctx.sendJson(res, 200, { config: (await ctx.stateResponse()).config });
  }

  // `sources` is array-shaped, so it's replaced wholesale here rather than
  // through the flat `if (key in body)` scalar guards above.
  async function sources(res, body) {
    const list = Array.isArray(body.sources) ? body.sources : [];
    for (const s of list) {
      if (!s || typeof s.path !== "string" || !s.path.trim()) {
        return ctx.sendJson(res, 400, { error: "Every source needs a folder path" });
      }
    }
    ctx.config.sources = list.map((s) => ({
      path: s.path.trim(),
      pattern: (s.pattern || "*").trim() || "*",
      deleteAfterImport: Boolean(s.deleteAfterImport),
      recursive: Boolean(s.recursive),
      mapTo: typeof s.mapTo === "string" && s.mapTo.trim() ? s.mapTo.trim().replace(/\\/g, "/") : null,
    }));
    await ctx.saveConfig();
    ctx.log("Source folders updated from the browser.");
    ctx.sendJson(res, 200, { config: (await ctx.stateResponse()).config });
  }

  // Opens the folder a source's files currently live in (or will, on the
  // next sync) - not confined via ctx.resolveInside like /api/reveal, since
  // a source with no `mapTo` lands outside `target` for the input (the
  // source's own `path`) but the *computed destination* is always inside
  // `target` (sourceDestFolder mirrors syncVolume's own destRoot rule), so
  // it's safe to open directly.
  async function exploreSourceDest(res, body) {
    const srcPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!srcPath) return ctx.sendJson(res, 400, { error: "Missing source path" });
    const mapTo = typeof body.mapTo === "string" && body.mapTo.trim() ? body.mapTo.trim() : null;
    const dest = sourceDestFolder({ path: srcPath, mapTo }, ctx.target);
    openPath(dest);
    ctx.sendJson(res, 200, { opened: dest });
  }

  return { settings, sources, exploreSourceDest };
}
