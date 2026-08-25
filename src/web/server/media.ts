import path from "node:path";
import { MIME } from "./constants.ts";
import type { ServerContext } from "./context.ts";

/** Streams an audio file, with range support for seeking and Safari playback. */
export async function serveMedia(ctx: ServerContext, req: Request, route: string): Promise<Response> {
  const rel = decodeURIComponent(route.slice("/media/".length));
  const full = ctx.resolveInside(rel);
  if (!full) return ctx.sendJson(400, { error: "Path outside the target folder" });

  // Nothing special is needed for a truncated-index Samsung .m4a here: the
  // repair (lib/import/special-case-handling.ts) replaces the recording in place, so
  // by the time the page can ask for it, the file under `rel` is the playable
  // one. That's the whole reason the repair swaps rather than writing a sibling.
  const file = Bun.file(full);
  if (!(await file.exists())) return ctx.sendJson(404, { error: "Not found" });
  const size = file.size;

  const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
  const range = req.headers.get("range");

  if (range) {
    const match = /bytes=(\d*)-(\d*)/.exec(range);
    if (match) {
      const start = match[1] ? parseInt(match[1], 10) : 0;
      const end = match[2] ? parseInt(match[2], 10) : size - 1;
      if (start >= size || end >= size || start > end) {
        return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } });
      }
      return new Response(file.slice(start, end + 1), {
        status: 206,
        headers: {
          "Content-Type": type,
          "Content-Length": String(end - start + 1),
          "Content-Range": `bytes ${start}-${end}/${size}`,
          "Accept-Ranges": "bytes",
        },
      });
    }
  }

  return new Response(file, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(size),
      "Accept-Ranges": "bytes",
    },
  });
}
