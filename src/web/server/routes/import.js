import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import fs from "fs-extra";
import chalk from "chalk";
import { detectVolumes } from "../../../lib/volumes.js";
import { syncVolume, findAudioFiles, AUDIO_EXTENSIONS, resolveFlatDest } from "../../../lib/sync.js";
import { refreshNote } from "../../../lib/notes.js";
import { loadDeletionMatcher } from "../../../lib/ledger.js";
import { createWhisperRunner } from "./transcribe.js";

const DROPPED_DIR_NAME = "Dropped";
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // generous for a single recording

/** GET /api/volumes, GET /api/browse, GET /api/browse-fs, POST /api/import, POST /api/upload. */
export function createImportRoutes(ctx) {
  const whisperRunner = createWhisperRunner(ctx);

  async function listVolumes() {
    const detected = await detectVolumes();
    const found = detected.map((v) => ({
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
        known: null,
      });
    }
    return found;
  }

  async function volumeById(id) {
    return (await listVolumes()).find((v) => v.id === id) || null;
  }

  async function volumes(res) {
    ctx.sendJson(res, 200, { volumes: await listVolumes() });
  }

  async function browse(res, params) {
    const volume = await volumeById(params.get("volume"));
    if (!volume) return ctx.sendJson(res, 404, { error: "Unknown volume" });
    const sub = (params.get("sub") || "").split("/").filter((s) => s && s !== "." && s !== "..");
    const root = path.resolve(volume.mountPath);
    const current = path.resolve(root, sub.join(path.sep));
    if (current !== root && !current.startsWith(root + path.sep)) {
      return ctx.sendJson(res, 400, { error: "Path outside the volume" });
    }

    let folders = [];
    try {
      folders = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      // unreadable directory - report it as empty rather than failing outright
    }
    return ctx.sendJson(res, 200, { root, current, sub: sub.join("/"), folders });
  }

  // Unlike browse() above, this isn't confined to a detected volume - source
  // folders can be anywhere on disk, and a browser can't hand back a real
  // filesystem path from its own directory picker, so the tree walk happens
  // here instead. No path given means "list drives/roots".
  async function browseFs(res, params) {
    const raw = params.get("path");
    if (!raw) {
      return ctx.sendJson(res, 200, { current: null, parent: null, folders: await fsRoots(), sep: path.sep });
    }
    const current = path.resolve(raw);
    let folders;
    try {
      folders = (await fs.readdir(current, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort((a, b) => a.localeCompare(b));
    } catch {
      return ctx.sendJson(res, 400, { error: "Can't read that folder" });
    }
    const up = path.dirname(current);
    return ctx.sendJson(res, 200, { current, parent: up !== current ? up : null, folders, sep: path.sep });
  }

  async function fsRoots() {
    if (os.platform() !== "win32") return ["/"];
    const roots = [];
    for (const code of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") {
      const drive = `${code}:\\`;
      if (await fs.pathExists(drive)) roots.push(drive);
    }
    return roots;
  }

  async function startImport(res, body) {
    if (ctx.guardJob(res)) return;
    const requests = Array.isArray(body.volumes) ? body.volumes : [];
    if (requests.length === 0) return ctx.sendJson(res, 400, { error: "No volumes selected" });

    const all = await listVolumes();
    const picked = requests
      .map((r) => ({ request: r, volume: all.find((v) => v.id === r.id) }))
      .filter((p) => p.volume);
    if (picked.length === 0) return ctx.sendJson(res, 400, { error: "Selected volumes are no longer connected" });

    const translate = Boolean(body.translate);
    ctx.startJob("import", `Importing from ${picked.length} volume(s)`, picked.length);
    ctx.sendJson(res, 202, { started: true });

    (async () => {
      let done = 0;
      const imported = [];
      for (const { request, volume } of picked) {
        const subdir = (request.subdir || "").trim();
        ctx.jobProgress(done, `Importing "${volume.name}"`);
        ctx.jobLog(`Syncing "${volume.name}"${subdir ? " / " + subdir : ""}...`);
        const effective = {
          name: volume.name,
          destName: volume.name,
          mountPath: subdir ? path.join(volume.mountPath, subdir) : volume.mountPath,
          pattern: volume.pattern,
          deleteAfterImport: volume.deleteAfterImport,
          recursive: volume.recursive,
        };
        // syncVolume reports rather than prints, so the copy shows up in the
        // page's log and title instead of the terminal it can't see. One
        // broadcast per file would flood the SSE stream on a full card, so
        // only the log lines and a twice-a-second tick get through.
        let lastTick = 0;
        const onProgress = (event) => {
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
          ctx.jobLog(`FAILED "${volume.name}": ${err.message}`);
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
          ctx.job.total = picked.length + imported.length;
          let t = 0;
          for (const file of imported) {
            const rel = path.relative(ctx.target, file).split(path.sep).join("/");
            ctx.jobProgress(picked.length + t, `Translating ${path.basename(file)} (${t + 1}/${imported.length})`);
            ctx.jobLog(`[${t + 1}/${imported.length}] Translating ${rel}`);
            try {
              await runWhisper(file);
              ctx.jobLog(`Saved ${rel.replace(/\.[^.]+$/, ".vtt")}`);
            } catch (err) {
              ctx.jobLog(`FAILED ${rel}: ${err.message}`);
            }
            t++;
            ctx.jobProgress(picked.length + t);
          }
        }
      }

      ctx.jobProgress(ctx.job.total, `Imported ${imported.length} new note(s)`);
      await ctx.endJob(null);
    })().catch((err) => ctx.endJob(err));
  }

  /**
   * Drag-and-drop import: the browser POSTs one raw file per request (no
   * multipart, no job system - this isn't a job, just a copy). Streamed
   * straight to a temp file so a large recording never sits in memory, then
   * handed through the same flat-destination dedup syncVolume uses so a
   * file dropped twice doesn't duplicate. Lands in target/Dropped/,
   * alongside the per-device folders regular import creates.
   */
  async function upload(req, res, params, token) {
    const supplied = req.headers["x-vno-token"] || params.get("t");
    if (supplied !== token) {
      req.resume();
      return ctx.sendJson(res, 403, { error: "Invalid session token" });
    }

    const name = path.basename(String(params.get("name") || "")).trim();
    const ext = path.extname(name).toLowerCase();
    if (!name || !AUDIO_EXTENSIONS.has(ext)) {
      req.resume();
      return ctx.sendJson(res, 400, { error: `Unsupported file type: ${name || "(no name)"}` });
    }

    const destRoot = path.join(ctx.target, DROPPED_DIR_NAME);
    await fs.ensureDir(destRoot);
    const tmp = path.join(destRoot, `.upload-${crypto.randomBytes(8).toString("hex")}.tmp`);

    let bytes = 0;
    let failed = null;
    await new Promise((resolve) => {
      const out = fs.createWriteStream(tmp);
      req.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_UPLOAD_BYTES) {
          failed = failed || new Error("File too large");
          req.destroy();
        }
      });
      req.on("aborted", () => { failed = failed || new Error("Upload interrupted"); });
      req.on("error", (err) => { failed = failed || err; });
      out.on("error", (err) => { failed = failed || err; });
      out.on("close", resolve);
      req.pipe(out);
    });

    if (failed || bytes === 0) {
      await fs.remove(tmp).catch(() => {});
      return ctx.sendJson(res, 400, { error: failed ? failed.message : "Empty upload" });
    }

    try {
      const isDeleted = await loadDeletionMatcher(ctx.target, { enabled: ctx.config.rememberDeletions !== false });
      const { dest, skip, wasDeletedBefore } = await resolveFlatDest(destRoot, name, bytes, isDeleted);
      if (skip) {
        await fs.remove(tmp);
        return ctx.sendJson(res, 200, { skipped: true, reason: wasDeletedBefore ? "previously deleted" : "already imported" });
      }
      await fs.move(tmp, dest, { overwrite: false });

      const rel = path.relative(ctx.target, dest).split(path.sep).join("/");
      const note = await refreshNote(ctx.target, dest);
      ctx.notes = ctx.notes.filter((n) => n.rel !== rel);
      ctx.notes.push(note);
      ctx.notes.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));
      ctx.broadcast("notes", { count: ctx.notes.length });
      console.log(chalk.dim(`Imported via drag-and-drop: ${rel}`));
      return ctx.sendJson(res, 200, { rel, name: path.basename(dest) });
    } catch (err) {
      await fs.remove(tmp).catch(() => {});
      return ctx.sendJson(res, 500, { error: err.message });
    }
  }

  return { volumes, browse, browseFs, startImport, upload };
}
