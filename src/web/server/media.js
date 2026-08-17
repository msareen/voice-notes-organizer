import path from "node:path";
import fs from "fs-extra";
import { MIME } from "./constants.js";

/** Streams an audio file, with range support for seeking and Safari playback. */
export function serveMedia(ctx, req, res, route) {
  const rel = decodeURIComponent(route.slice("/media/".length));
  const full = ctx.resolveInside(rel);
  if (!full) return ctx.sendJson(res, 400, { error: "Path outside the target folder" });

  // Nothing special is needed for a truncated-index Samsung .m4a here: the
  // repair (lib/special-case-handling.js) replaces the recording in place, so
  // by the time the page can ask for it, the file under `rel` is the playable
  // one. That's the whole reason the repair swaps rather than writing a sibling.
  let stat;
  try {
    stat = fs.statSync(full);
  } catch {
    return ctx.sendJson(res, 404, { error: "Not found" });
  }

  const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : stat.size - 1;
      if (start >= stat.size || end >= stat.size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Length": end - start + 1,
        "Content-Range": `bytes ${start}-${end}/${stat.size}`,
        "Accept-Ranges": "bytes",
      });
      return fs.createReadStream(full, { start, end }).pipe(res);
    }
  }

  res.writeHead(200, {
    "Content-Type": type,
    "Content-Length": stat.size,
    "Accept-Ranges": "bytes",
  });
  fs.createReadStream(full).pipe(res);
}
