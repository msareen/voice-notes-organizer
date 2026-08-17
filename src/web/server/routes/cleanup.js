import path from "node:path";
import fs from "fs-extra";
import { findAudioFiles } from "../../../lib/sync.js";
import { getDurationSeconds } from "../../../lib/media.js";
import { listOriginalBackups, isOriginalBackup } from "../../../lib/special-case-handling.js";

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

    // Only looked for when asked: it's a stat per recording, and the dialog
    // doesn't show the group unless the box is ticked anyway.
    const originals = [];
    if (params.get("originals") === "1") {
      for (const { backup, recording, size } of await listOriginalBackups(files)) {
        originals.push({
          rel: path.relative(ctx.target, backup).split(path.sep).join("/"),
          name: path.basename(backup),
          recordingName: path.basename(recording),
          size,
        });
      }
    }

    return ctx.sendJson(res, 200, { threshold, short, originals, scanned: files.length });
  }

  async function run(res, body) {
    const rels = (Array.isArray(body.rels) ? body.rels : []).filter((rel) => ctx.noteFor(rel));
    // Backups aren't notes, so they can't be validated the same way. The guard
    // is the naming rule instead, re-checked here rather than trusted from the
    // client: this branch must not be able to delete a recording.
    const originalRels = (Array.isArray(body.originals) ? body.originals : []).filter((rel) =>
      isOriginalBackup(path.basename(rel))
    );
    if (rels.length === 0 && originalRels.length === 0) {
      return ctx.sendJson(res, 400, { error: "Nothing selected" });
    }

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
    // Recordings only: a pre-repair original was never imported under its own
    // name, and the recording it came from is still there, so remembering it
    // would suppress a future import of a file nobody deleted.
    await ctx.remember(deleted, "cleanup");

    let removedOriginals = 0;
    for (const rel of originalRels) {
      const full = ctx.resolveInside(rel);
      if (!full) continue;
      try {
        // Checked first because fs.remove resolves happily on a path that was
        // never there - without this the count would report deletions that
        // didn't happen.
        if (!(await fs.pathExists(full))) continue;
        await fs.remove(full);
        removedOriginals++;
      } catch {
        // same as above: locked or already gone
      }
    }

    await ctx.refreshNotes();
    ctx.log(
      `Cleanup from the browser: removed ${removed} file(s)` +
        (removedOriginals ? `, ${removedOriginals} pre-repair original(s)` : "") +
        "."
    );
    return ctx.sendJson(res, 200, {
      removed,
      removedOriginals,
      deleted: rels.length + originalRels.length,
    });
  }

  return { scan, run };
}
