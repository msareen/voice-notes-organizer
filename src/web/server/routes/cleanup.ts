import path from "node:path";
import fs from "fs-extra";
import { findMediaFiles } from "../../../lib/sync.ts";
import { getDurationSeconds } from "../../../lib/media.ts";
import { listOriginalBackups, isOriginalBackup } from "../../../lib/special-case-handling.ts";
import type { ServerContext } from "../context.ts";

/** A recording short enough to offer for deletion. */
interface ShortRecording {
  rel: string;
  name: string;
  durationSec: number;
}

/** A pre-repair original, paired with the recording it was made from. */
interface OriginalRow {
  rel: string;
  name: string;
  recordingName: string;
  size: number;
}

/** GET /api/cleanup/scan, POST /api/cleanup. */
export function createCleanupRoutes(ctx: ServerContext) {
  async function scan(params: URLSearchParams): Promise<Response> {
    const threshold = Math.max(0, parseFloat(params.get("threshold") ?? "") || 3);
    const files = await findMediaFiles(ctx.target);
    const short: ShortRecording[] = [];
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
    const originals: OriginalRow[] = [];
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

    return ctx.sendJson(200, { threshold, short, originals, scanned: files.length });
  }

  async function run(body: { rels?: unknown; originals?: unknown }): Promise<Response> {
    const rels: string[] = (Array.isArray(body.rels) ? body.rels : []).filter((rel: string) => ctx.noteFor(rel));
    // Backups aren't notes, so they can't be validated the same way. The guard
    // is the naming rule instead, re-checked here rather than trusted from the
    // client: this branch must not be able to delete a recording.
    const originalRels: string[] = (Array.isArray(body.originals) ? body.originals : []).filter((rel: string) =>
      isOriginalBackup(path.basename(rel))
    );
    if (rels.length === 0 && originalRels.length === 0) {
      return ctx.sendJson(400, { error: "Nothing selected" });
    }

    let removed = 0;
    const deleted: { rel: string; size: number | null }[] = [];
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
    return ctx.sendJson(200, {
      removed,
      removedOriginals,
      deleted: rels.length + originalRels.length,
    });
  }

  return { scan, run };
}
