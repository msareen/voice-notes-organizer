import path from "node:path";
import { findAudioFiles } from "../../../lib/sync.js";
import { getDurationSeconds } from "../../../lib/media.js";

/** GET /api/cleanup/scan, POST /api/cleanup. */
export function createCleanupRoutes(ctx) {
  async function scan(res, params) {
    const threshold = Math.max(0, parseFloat(params.get("threshold")) || 3);
    const files = await findAudioFiles(ctx.target);
    const short = [];
    for (const file of files) {
      const duration = await getDurationSeconds(file);
      if (duration !== null && duration < threshold) {
        short.push({
          rel: path.relative(ctx.target, file).split(path.sep).join("/"),
          name: path.basename(file),
          durationSec: duration,
        });
      }
    }
    return ctx.sendJson(res, 200, { threshold, short, scanned: files.length });
  }

  async function run(res, body) {
    const rels = (Array.isArray(body.rels) ? body.rels : []).filter((rel) => ctx.noteFor(rel));
    if (rels.length === 0) return ctx.sendJson(res, 400, { error: "Nothing selected" });
    let removed = 0;
    const deleted = [];
    for (const rel of rels) {
      try {
        const result = await ctx.removeRecording(rel);
        removed += result.removed;
        if (result.entry) deleted.push(result.entry);
      } catch {
        // skip files that vanished or are locked; the count reflects reality
      }
    }
    await ctx.remember(deleted, "cleanup");
    await ctx.refreshNotes();
    ctx.log(`Cleanup from the browser: removed ${removed} file(s).`);
    return ctx.sendJson(res, 200, { removed, deleted: rels.length });
  }

  return { scan, run };
}
