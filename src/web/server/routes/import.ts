import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { detectVolumes } from "../../../lib/import/volumes.ts";
import { syncVolume, MEDIA_EXTENSIONS, resolveFlatDest } from "../../../lib/import/sync.ts";
import { refreshNote } from "../../../lib/notes/notes.ts";
import { loadDeletionMatcher } from "../../../lib/notes/ledger.ts";
import { createWhisperRunner } from "./transcribe.ts";
import type { ServerContext } from "../context.ts";
import type { KnownMount, ProgressReport, SyncSource } from "../../../types.ts";

const DROPPED_DIR_NAME = "Dropped";
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // generous for a single recording

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** A volume as the Import dialog sees it: detected, or a configured source. */
interface ListedVolume {
  id: string;
  name: string;
  mountPath: string;
  sizeBytes: number | null;
  isManualSource: boolean;
  pattern?: string;
  deleteAfterImport?: boolean;
  recursive?: boolean;
  mapTo?: string | null;
  known: KnownMount | null;
}

/** One row of the Import dialog's selection. */
interface ImportRequest {
  id: string;
  subdir?: string;
  /** false opts out of writing this volume into config.knownMounts. */
  remember?: boolean;
}

/** GET /api/volumes, GET /api/browse, GET /api/browse-target, GET /api/browse-fs, POST /api/import, POST /api/upload. */
export function createImportRoutes(ctx: ServerContext) {
  const whisperRunner = createWhisperRunner(ctx);

  async function listVolumes(): Promise<ListedVolume[]> {
    const detected = await detectVolumes();
    const found: ListedVolume[] = detected.map((v) => ({
      id: v.id,
      name: v.name,
      mountPath: v.mountPath,
      sizeBytes: v.sizeBytes ?? null,
      isManualSource: false,
      known: ctx.config.knownMounts?.[v.id] || null,
    }));

    for (const source of ctx.config.sources || []) {
      if (!(await fs.pathExists(source.path))) continue;
      found.push({
        id: `source:${source.path.toLowerCase()}`,
        name: path.basename(source.path) || "source",
        mountPath: source.path,
        sizeBytes: null,
        isManualSource: true,
        pattern: source.pattern,
        deleteAfterImport: source.deleteAfterImport,
        recursive: source.recursive,
        mapTo: source.mapTo,
        known: null,
      });
    }
    return found;
  }

  async function volumeById(id: string | null): Promise<ListedVolume | null> {
    return (await listVolumes()).find((v) => v.id === id) || null;
  }

  async function volumes(): Promise<Response> {
    return ctx.sendJson(200, { volumes: await listVolumes() });
  }

  async function browse(params: URLSearchParams): Promise<Response> {
    const volume = await volumeById(params.get("volume"));
    if (!volume) return ctx.sendJson(404, { error: "Unknown volume" });
    const sub = (params.get("sub") || "").split("/").filter((s) => s && s !== "." && s !== "..");
    const root = path.resolve(volume.mountPath);
    const current = path.resolve(root, sub.join(path.sep));
    if (current !== root && !current.startsWith(root + path.sep)) {
      return ctx.sendJson(400, { error: "Path outside the volume" });
    }

    let folders: string[] = [];
    try {
      folders = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // unreadable directory - report it as empty rather than failing outright
    }
    return ctx.sendJson(200, { root, current, sub: sub.join("/"), folders });
  }

  // Unlike browse() above, this isn't confined to a detected volume - source
  // folders can be anywhere on disk, and a browser can't hand back a real
  // filesystem path from its own directory picker, so the tree walk happens
  // here instead. No path given means "list drives/roots".
  async function browseFs(params: URLSearchParams): Promise<Response> {
    const raw = params.get("path");
    if (!raw) {
      return ctx.sendJson(200, { current: null, parent: null, folders: await fsRoots(), sep: path.sep });
    }
    const current = path.resolve(raw);
    let folders: string[];
    try {
      folders = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return ctx.sendJson(400, { error: "Can't read that folder" });
    }
    const up = path.dirname(current);
    return ctx.sendJson(200, { current, parent: up !== current ? up : null, folders, sep: path.sep });
  }

  // Confined browser for picking a source's mapping folder - unlike browse()
  // above (rooted at a volume/source's mountPath) this is rooted at the
  // import target itself, and unlike browseFs() (unconfined, for picking a
  // source folder anywhere on disk) it can never leave that root. A mapping
  // folder may not exist yet (it's a destination, not something being
  // scanned), so an unreadable/missing `current` just reports no subfolders
  // instead of erroring - the root (`target`) always exists.
  async function browseTarget(params: URLSearchParams): Promise<Response> {
    const root = path.resolve(ctx.target);
    const sub = (params.get("sub") || "").split("/").filter((s) => s && s !== "." && s !== "..");
    const current = path.resolve(root, sub.join(path.sep));
    if (current !== root && !current.startsWith(root + path.sep)) {
      return ctx.sendJson(400, { error: "Path outside the target folder" });
    }

    let folders: string[] = [];
    try {
      folders = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // doesn't exist yet or unreadable - report it as empty rather than failing
    }
    return ctx.sendJson(200, { root, current, sub: sub.join("/"), folders });
  }

  async function fsRoots(): Promise<string[]> {
    if (os.platform() !== "win32") return ["/"];
    const roots: string[] = [];
    for (const code of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${code}:\\`;
      if (await fs.pathExists(drive)) roots.push(drive);
    }
    return roots;
  }

  async function startImport(body: { volumes?: unknown; translate?: unknown }): Promise<Response> {
    const busy = ctx.guardJob();
    if (busy) return busy;
    const requests: ImportRequest[] = Array.isArray(body.volumes) ? body.volumes : [];
    if (requests.length === 0) return ctx.sendJson(400, { error: "No volumes selected" });

    const all = await listVolumes();
    const picked = requests
      .map((r) => ({ request: r, volume: all.find((v) => v.id === r.id) }))
      .filter((p): p is { request: ImportRequest; volume: ListedVolume } => Boolean(p.volume));
    if (picked.length === 0) return ctx.sendJson(400, { error: "Selected volumes are no longer connected" });

    const translate = Boolean(body.translate);
    const job = ctx.startJob("import", `Importing from ${picked.length} volume(s)`, picked.length);

    (async () => {
      let done = 0;
      const imported: string[] = [];
      for (const { request, volume } of picked) {
        const subdir = (request.subdir || "").trim();
        ctx.jobProgress(done, `Importing "${volume.name}"`);
        ctx.jobLog(`Syncing "${volume.name}"${subdir ? " / " + subdir : ""}...`);
        const effective: SyncSource = {
          id: volume.id,
          name: volume.name,
          destName: volume.name,
          mountPath: subdir ? path.join(volume.mountPath, subdir) : volume.mountPath,
          pattern: volume.pattern,
          deleteAfterImport: volume.deleteAfterImport,
          recursive: volume.recursive,
          mapTo: volume.mapTo,
        };
        // syncVolume reports rather than prints, so the copy shows up in the
        // page's log and title instead of the terminal it can't see. One
        // broadcast per file would flood the SSE stream on a full card, so
        // only the log lines and a twice-a-second tick get through.
        let lastTick = 0;
        const onProgress = (event: ProgressReport) => {
          if (event.phase === "log") return ctx.jobLog(event.message);
          if (event.phase !== "work" || !event.total) return;
          const now = Date.now();
          if (now - lastTick < 500 && event.done < event.total) return;
          lastTick = now;
          ctx.jobProgress(done, `Importing "${volume.name}" (${event.done}/${event.total})`);
        };

        try {
          const result = await syncVolume(effective, ctx.target, {
            rememberDeletions: ctx.config.rememberDeletions !== false,
            onProgress,
          });
          imported.push(...result.copiedFiles);
          ctx.jobLog(
            `"${volume.name}": ${result.copied} copied, ${result.skipped} already up to date` +
              (result.suppressed > 0 ? `, ${result.suppressed} previously deleted (left alone)` : "") +
              (result.deleted > 0 ? `, ${result.deleted} removed from source` : "")
          );
          if (!volume.isManualSource && request.remember !== false) {
            ctx.config.knownMounts[volume.id] = {
              name: volume.name,
              autoImport: true,
              sourceSubdir: subdir || null,
              lastSynced: new Date().toISOString(),
              lastResult: { copied: result.copied, skipped: result.skipped, total: result.total },
            };
            await ctx.saveConfig();
          }
        } catch (err) {
          ctx.jobLog(`FAILED "${volume.name}": ${errorMessage(err)}`);
        }
        done++;
        ctx.jobProgress(done);
      }

      await ctx.refreshNotes();

      if (translate && imported.length > 0) {
        const deps = await ctx.dependencyStatus();
        if (!deps.whisper || !deps.ffmpeg) {
          ctx.jobLog("Skipping translation - whisper/ffmpeg isn't on your PATH. Run `vno setup`.");
        } else {
          const model = ctx.config.defaultModel || "turbo";
          const runWhisper = whisperRunner({ model, translate: true });
          job.total = picked.length + imported.length;
          let t = 0;
          for (const file of imported) {
            const rel = path.relative(ctx.target, file).split(path.sep).join("/");
            ctx.jobProgress(picked.length + t, `Translating ${path.basename(file)} (${t + 1}/${imported.length})`);
            ctx.jobLog(`[${t + 1}/${imported.length}] Translating ${rel}`);
            try {
              await runWhisper(file);
              ctx.jobLog(`Saved ${rel.replace(/\.[^.]+$/, ".vtt")}`);
            } catch (err) {
              ctx.jobLog(`FAILED ${rel}: ${errorMessage(err)}`);
            }
            t++;
            ctx.jobProgress(picked.length + t);
          }
        }
      }

      ctx.jobProgress(job.total, `Imported ${imported.length} new note(s)`);
      await ctx.endJob(null);
    })().catch((err) => ctx.endJob(err));

    return ctx.sendJson(202, { started: true });
  }

  /**
   * Drag-and-drop import: the browser POSTs one raw file per request (no
   * multipart, no job system - this isn't a job, just a copy). Streamed
   * straight to a temp file so a large recording never sits in memory, then
   * handed through the same flat-destination dedup syncVolume uses so a
   * file dropped twice doesn't duplicate. Lands in target/Dropped/,
   * alongside the per-device folders regular import creates.
   */
  async function upload(req: Request, params: URLSearchParams, token: string): Promise<Response> {
    const supplied = req.headers.get("x-vno-token") || params.get("t");
    if (supplied !== token) return ctx.sendJson(403, { error: "Invalid session token" });

    const name = path.basename(String(params.get("name") || "")).trim();
    const ext = path.extname(name).toLowerCase();
    if (!name || !MEDIA_EXTENSIONS.has(ext)) {
      return ctx.sendJson(400, { error: `Unsupported file type: ${name || "(no name)"}` });
    }

    const destRoot = path.join(ctx.target, DROPPED_DIR_NAME);
    await fs.ensureDir(destRoot);
    const tmp = path.join(destRoot, `.upload-${crypto.randomBytes(8).toString("hex")}.tmp`);

    let bytes = 0;
    let failed: Error | null = null;
    const sink = Bun.file(tmp).writer();
    if (req.body) {
      try {
        for await (const chunk of req.body as ReadableStream<Uint8Array>) {
          bytes += chunk.byteLength;
          if (bytes > MAX_UPLOAD_BYTES) {
            failed = new Error("File too large");
            break;
          }
          await sink.write(chunk);
        }
      } catch (err) {
        failed = failed || new Error(errorMessage(err));
      }
    }
    await sink.end();

    if (failed || bytes === 0) {
      await fs.remove(tmp).catch(() => {});
      return ctx.sendJson(400, { error: failed ? failed.message : "Empty upload" });
    }

    try {
      const isDeleted = await loadDeletionMatcher(ctx.target, { enabled: ctx.config.rememberDeletions !== false });
      const { dest, skip, wasDeletedBefore } = await resolveFlatDest(destRoot, name, bytes, isDeleted);
      if (skip) {
        await fs.remove(tmp);
        return ctx.sendJson(200, { skipped: true, reason: wasDeletedBefore ? "previously deleted" : "already imported" });
      }
      await fs.move(tmp, dest, { overwrite: false });

      const rel = path.relative(ctx.target, dest).split(path.sep).join("/");
      const note = await refreshNote(ctx.target, dest);
      ctx.notes = ctx.notes.filter((n) => n.rel !== rel);
      ctx.notes.push(note);
      ctx.notes.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));
      ctx.broadcast("notes", { count: ctx.notes.length });
      console.log(chalk.dim(`Imported via drag-and-drop: ${rel}`));
      return ctx.sendJson(200, { rel, name: path.basename(dest) });
    } catch (err) {
      await fs.remove(tmp).catch(() => {});
      return ctx.sendJson(500, { error: errorMessage(err) });
    }
  }

  return { volumes, browse, browseTarget, browseFs, startImport, upload };
}
