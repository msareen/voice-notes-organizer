// Serves the client's static files (app.css, app.js and the assets/js/*
// module tree) straight off disk, confined to the assets folder.
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import { ASSET_DIR, ASSET_MIME } from "./constants.js";

// path.resolve strips the trailing separator fileURLToPath leaves on a
// directory URL - needed so the `full === ASSET_ROOT` / `startsWith(ASSET_ROOT
// + path.sep)` confinement check below doesn't double up the separator.
const ASSET_ROOT = path.resolve(fileURLToPath(ASSET_DIR));

/**
 * The page's stylesheet and client script (the latter now several files
 * under assets/js/, loaded as native ES modules). An allowlist by extension
 * plus path confinement rather than a fixed filename list, so splitting
 * app.js into more files doesn't need a server change. Read per request
 * rather than cached, so editing an asset only needs a browser reload, not a
 * server restart.
 */
export async function serveAsset(res, sendJson, relPath) {
  const cleaned = relPath.split("/").filter((s) => s && s !== "." && s !== "..").join(path.sep);
  const full = path.resolve(ASSET_ROOT, cleaned);
  if (full !== ASSET_ROOT && !full.startsWith(ASSET_ROOT + path.sep)) {
    return sendJson(res, 400, { error: "Path outside the assets folder" });
  }
  const type = ASSET_MIME[path.extname(full).toLowerCase()];
  if (!type) return sendJson(res, 404, { error: `No asset at ${relPath}` });

  let body;
  try {
    body = await fs.readFile(full);
  } catch {
    return sendJson(res, 404, { error: `No asset at ${relPath}` });
  }
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(body);
}
