// Shared, static values for the web server: MIME tables and the small
// route/model lists that both the API and its route modules need.
export const MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
  ".amr": "audio/amr",
  ".3gp": "audio/3gpp",
};

export const MODELS = ["turbo", "tiny", "base", "small", "medium", "large"];
// Re-exported from lib/ rather than listed here: `vno setting` offers the
// same languages in the terminal, and this used to be a three-entry subset
// the CLI disagreed with - the route rejected codes the wizard accepted.
// "auto" lets whisper.cpp detect per file; a pinned code overrides it, and
// config.crossLanguage guides it without pinning.
export { WHISPER_LANGUAGES as LANGUAGES } from "../../lib/languages.js";

// Extensions served out of assets/, resolved against this module rather than
// the cwd, since vno is usually installed globally and run from wherever the
// user happens to be. An allowlist by extension (not by filename) so the
// app.js split across assets/js/*.js doesn't need a new entry per file.
export const ASSET_MIME = {
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
};

export const ASSET_DIR = new URL("../assets/", import.meta.url);
