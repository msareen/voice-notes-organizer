import path from "node:path";
import fs from "fs-extra";
import { readTranscript, findTranscript } from "../../../lib/notes.ts";
import { refreshNote } from "../../../lib/notes.ts";
import { parseCues, serializeCues } from "../../../lib/vtt.ts";
import { openPath, revealInFolder } from "../../../lib/open.ts";
import type { ServerResponse } from "node:http";
import type { ServerContext } from "../context.ts";

/** What the deck's Explore action posts: a note, or a folder. */
interface RevealBody {
  rel?: string;
  dir?: string;
}

/**
 * The editor sends text only. `cues` (an array of strings, one per cue) is the
 * timed form; `text` is the plain one.
 */
interface TranscriptBody {
  rel: string;
  cues?: unknown;
  text?: unknown;
}

/** POST /api/reveal, PUT /api/transcript, POST /api/notes/refresh, POST /api/notes/delete. */
export function createNotesRoutes(ctx: ServerContext) {
  function reveal(res: ServerResponse, body: RevealBody): void {
    const rel = body.rel;
    if (rel) {
      const full = ctx.resolveInside(rel);
      if (!full) return ctx.sendJson(res, 400, { error: "Path outside the target folder" });
      revealInFolder(full);
      return ctx.sendJson(res, 200, { opened: rel });
    }
    const dir = ctx.resolveInside(body.dir || "");
    if (!dir) return ctx.sendJson(res, 400, { error: "Path outside the target folder" });
    openPath(dir);
    return ctx.sendJson(res, 200, { opened: body.dir || "." });
  }

  async function saveTranscript(res: ServerResponse, body: TranscriptBody): Promise<void> {
    const note = ctx.noteFor(body.rel);
    if (!note) return ctx.sendJson(res, 404, { error: "Unknown note" });
    const audio = ctx.resolveInside(body.rel);
    if (!audio) return ctx.sendJson(res, 400, { error: "Path outside the target folder" });
    const base = audio.slice(0, -path.extname(audio).length);

    if (Array.isArray(body.cues)) {
      // Timed transcript: only the text is editable, the original timings are
      // read back off disk and written out unchanged.
      const incoming = body.cues as unknown[];
      const existing = await findTranscript(audio);
      if (!existing || existing.ext === ".txt") {
        return ctx.sendJson(res, 409, { error: "No timed transcript to update" });
      }
      const cues = parseCues(await fs.readFile(existing.path, "utf8"));
      if (cues.length !== incoming.length) {
        return ctx.sendJson(res, 409, { error: "Transcript changed on disk - reload and try again" });
      }
      const merged = cues.map((cue, i) => ({ ...cue, text: String(incoming[i] ?? "").replace(/\s+/g, " ").trim() }));
      const out = existing.ext === ".vtt" ? existing.path : base + ".vtt";
      await fs.writeFile(out, serializeCues(merged.filter((c) => c.text)), "utf8");
    } else {
      const text = String(body.text ?? "").trim();
      const existing = await findTranscript(audio);
      const out = existing && existing.ext === ".txt" ? existing.path : base + ".txt";
      if (!text && existing) await fs.remove(existing.path);
      else await fs.writeFile(out, text + "\n", "utf8");
    }

    Object.assign(note, await readTranscript(audio));
    ctx.log(`Transcript saved from the browser: ${body.rel}`);
    return ctx.sendJson(res, 200, { note });
  }

  /**
   * The startup scan trusts a cached duration keyed by size+mtime (fast on a
   * big library - see lib/notes.ts:buildNotes), which can go stale if a file
   * was replaced without vno noticing. Selecting a note in the browser calls
   * this to recheck just that one file - a single ffprobe, not a full rescan -
   * and patches the shared notes array in place via the same object
   * reference noteFor hands out elsewhere.
   */
  async function refresh(res: ServerResponse, body: { rel: string }): Promise<void> {
    const note = ctx.noteFor(body.rel);
    if (!note) return ctx.sendJson(res, 404, { error: "Unknown note" });
    const audio = ctx.resolveInside(body.rel);
    if (!audio) return ctx.sendJson(res, 400, { error: "Path outside the target folder" });
    Object.assign(note, await refreshNote(ctx.target, audio));
    return ctx.sendJson(res, 200, { note });
  }

  async function deleteNote(res: ServerResponse, body: { rel: string }): Promise<void> {
    const note = ctx.noteFor(body.rel);
    if (!note) return ctx.sendJson(res, 404, { error: "Unknown note" });
    const { removed, entry } = await ctx.removeRecording(body.rel);
    await ctx.remember(entry ? [entry] : [], "delete");
    ctx.notes = ctx.notes.filter((n) => n.rel !== body.rel);
    ctx.broadcast("notes", { count: ctx.notes.length });
    ctx.log(`Deleted from the browser: ${body.rel}`);
    return ctx.sendJson(res, 200, { removed });
  }

  return { reveal, saveTranscript, refresh, deleteNote };
}
