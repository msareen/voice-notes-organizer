// Serves the client's static files (app.css, app.ts and the assets/js/*
// module tree) straight off disk, confined to the assets folder.
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "fs-extra";
import { ASSET_DIR, ASSET_MIME } from "./constants.ts";
import type { ServerResponse } from "node:http";

// path.resolve strips the trailing separator fileURLToPath leaves on a
// directory URL - needed so the `full === ASSET_ROOT` / `startsWith(ASSET_ROOT
// + path.sep)` confinement check below doesn't double up the separator.
const ASSET_ROOT = path.resolve(fileURLToPath(ASSET_DIR));

/**
 * The browser modules are TypeScript, and they're compiled here rather than by
 * a build step, which is what preserves the property this project cares about:
 * edit a file, reload the tab, see the change. Bun's transpiler is a type
 * *stripper* - it rewrites nothing else, so `import "./deck.ts"` survives
 * verbatim and the browser comes straight back here for that module. Browsers
 * key off Content-Type, not the extension, so a `.ts` URL served as JavaScript
 * is exactly what a native ES module loader wants.
 *
 * One instance, reused: it holds no per-file state.
 */
const transpiler = new Bun.Transpiler({ loader: "ts", target: "browser" });

type SendJson = (res: ServerResponse, status: number, data: unknown) => void;

/**
 * The page's stylesheet and client modules. An allowlist by extension plus
 * path confinement rather than a fixed filename list, so splitting app.ts into
 * more files doesn't need a server change. Read (and transpiled) per request
 * rather than cached, so editing an asset only needs a browser reload, not a
 * server restart.
 */
export async function serveAsset(res: ServerResponse, sendJson: SendJson, relPath: string): Promise<void> {
  const cleaned = relPath.split("/").filter((s) => s && s !== "." && s !== "..").join(path.sep);
  const full = path.resolve(ASSET_ROOT, cleaned);
  if (full !== ASSET_ROOT && !full.startsWith(ASSET_ROOT + path.sep)) {
    return sendJson(res, 400, { error: "Path outside the assets folder" });
  }
  const ext = path.extname(full).toLowerCase();
  const type = ASSET_MIME[ext];
  if (!type) return sendJson(res, 404, { error: `No asset at ${relPath}` });

  let body: Buffer;
  try {
    body = await fs.readFile(full);
  } catch {
    return sendJson(res, 404, { error: `No asset at ${relPath}` });
  }

  let payload: Buffer | string = body;
  if (ext === ".ts") {
    try {
      payload = transpiler.transformSync(body.toString("utf8"));
    } catch (err) {
      // A syntax error in a client module would otherwise reach the browser as
      // a blank page with an opaque parse failure. Fail loudly instead, with
      // the message on both the server console and the network response.
      const message = err instanceof Error ? err.message : String(err);
      return sendJson(res, 500, { error: `Couldn't compile ${relPath}: ${message}` });
    }
  }

  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
  res.end(payload);
}
