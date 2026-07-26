import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { URL } from "node:url";
import fs from "fs-extra";
import chalk from "chalk";
import { saveConfig, configFilePath } from "../lib/config.js";
import { buildNotes, readTranscript, findTranscript, TRANSCRIPT_EXTS } from "../lib/notes.js";
import { renderPage } from "./page.js";
import { parseCues, serializeCues } from "../lib/vtt.js";
import { openPath, revealInFolder } from "../lib/open.js";
import { detectVolumes } from "../lib/volumes.js";
import { syncVolume, findAudioFiles } from "../lib/sync.js";
import { transcribeFile } from "../lib/whisper.js";
import { checkDependencies } from "../lib/setup.js";
import { recordDeletions } from "../lib/ledger.js";
import { getDurationSeconds } from "../lib/media.js";

const MIME = {
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".ogg": "audio/ogg",
  ".oga": "audio/ogg",
  ".opus": "audio/ogg",
  ".wma": "audio/x-ms-wma",
  ".aiff": "audio/aiff",
  ".amr": "audio/amr",
  ".3gp": "audio/3gpp",
};

const MODELS = ["turbo", "tiny", "base", "small", "medium", "large"];

// Resolved against this module, not the cwd, since vno is usually installed
// globally and run from wherever the user happens to be.
const ASSET_DIR = new URL("./assets/", import.meta.url);
const ASSETS = {
  "app.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
};

/**
 * Starts the local viewer/control server. Resolves with { url, stop, closed }:
 * `closed` settles when the server shuts down, which happens when the browser
 * tab goes away, the page's Quit button is used, or `stop()` is called.
 */
export async function startServer({ config, port = 0, host = "127.0.0.1", onScanProgress = null } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const target = path.resolve(config.target);

  // Notes are expensive to build (an ffprobe per file), so they're cached and
  // rebuilt only when something actually changes them.
  let notes = await buildNotes(target, { onProgress: onScanProgress });
  let currentConfig = config;

  const clients = new Set(); // open SSE responses
  const sockets = new Set(); // every live socket, so shutdown can't hang
  let job = null; // at most one long-running job at a time
  let lastSeen = Date.now();
  let sawBrowser = false;
  let byeTimer = null;
  let stopping = false;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => sendJson(res, 500, { error: String(err.message || err) }));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  /* ------------------------------ plumbing ------------------------------ */

  function broadcast(event, data) {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data ?? {})}\n\n`;
    for (const client of clients) {
      try {
        client.write(payload);
      } catch {
        clients.delete(client);
      }
    }
  }

  async function refreshNotes() {
    // No progress reporting here: rebuilds happen while the page is up, where
    // status belongs in the page log, not drawn over the terminal.
    notes = await buildNotes(target);
    broadcast("notes", { count: notes.length });
  }

  function noteFor(rel) {
    return notes.find((n) => n.rel === rel) || null;
  }

  /** Resolves a target-relative path, refusing anything that escapes it. */
  function resolveInside(rel) {
    const cleaned = String(rel ?? "").split("/").filter((s) => s && s !== "." && s !== "..").join(path.sep);
    const full = path.resolve(target, cleaned);
    if (full !== target && !full.startsWith(target + path.sep)) return null;
    return full;
  }

  function sendJson(res, status, data) {
    const payload = JSON.stringify(data);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Content-Length": Buffer.byteLength(payload),
    });
    res.end(payload);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", (chunk) => {
        raw += chunk;
        if (raw.length > 5e6) reject(new Error("Request body too large"));
      });
      req.on("end", () => {
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error("Malformed JSON body"));
        }
      });
      req.on("error", reject);
    });
  }

  /* --------------------------- request handling -------------------------- */

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const route = url.pathname;

    // Only ever talk to a loopback client, and never to a page from another
    // origin - these endpoints delete files and launch programs.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      return sendJson(res, 403, { error: "Cross-origin request refused" });
    }

    if (route === "/") {
      if (url.searchParams.get("t") !== token) {
        res.writeHead(403, { "Content-Type": "text/plain" });
        return res.end("Invalid or missing session token. Open the URL vno printed in your terminal.");
      }
      const html = renderPage({ rootLabel: path.basename(target) || "voice notes", token });
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(html);
    }

    if (route === "/favicon.ico") {
      res.writeHead(204);
      return res.end();
    }

    // The page's stylesheet and client script. Deliberately ahead of the token
    // gate: they hold no secrets (the token is inlined into the HTML), and
    // gating them would mean putting the token in an asset URL, which is worse.
    // An allowlist rather than path juggling, so traversal isn't a question.
    if (route.startsWith("/assets/")) return serveAsset(res, route.slice(8));

    // Everything below is token-gated. sendBeacon can't set headers, so a
    // token in the JSON body counts too.
    const body = req.method === "GET" || req.method === "HEAD" ? {} : await readBody(req);
    const supplied = req.headers["x-vno-token"] || url.searchParams.get("t") || body.token;
    if (supplied !== token) return sendJson(res, 403, { error: "Invalid session token" });

    lastSeen = Date.now();
    sawBrowser = true;

    if (route.startsWith("/media/")) return serveMedia(req, res, route);
    if (route === "/api/events") return serveEvents(req, res);

    switch (route + " " + req.method) {
      case "/api/state GET":
        return sendJson(res, 200, await stateResponse());

      case "/api/ping POST":
        res.writeHead(204);
        return res.end();

      case "/api/bye POST":
        res.writeHead(204);
        res.end();
        // The Quit button means it: stop now. A pagehide beacon only nudges
        // the normal deferred shutdown, so a reload or a sibling tab is safe.
        if (body.quit) setTimeout(() => stop("quit from the browser"), 200);
        else scheduleShutdown("browser closed", 2500);
        return;

      case "/api/settings POST":
        return sendJson(res, 200, { config: await patchSettings(body) });

      case "/api/reveal POST":
        return reveal(res, body);

      case "/api/transcript PUT":
        return saveTranscript(res, body);

      case "/api/notes/delete POST":
        return deleteNote(res, body);

      case "/api/transcribe POST":
        return startTranscribe(res, body);

      case "/api/volumes GET":
        return sendJson(res, 200, { volumes: await listVolumes() });

      case "/api/browse GET":
        return browse(res, url.searchParams);

      case "/api/import POST":
        return startImport(res, body);

      case "/api/cleanup/scan GET":
        return scanShort(res, url.searchParams);

      case "/api/cleanup POST":
        return runCleanupJob(res, body);

      default:
        return sendJson(res, 404, { error: `No route for ${req.method} ${route}` });
    }
  }

  // Both probes are PATH lookups, so they're cheap enough to redo per request -
  // which also means the page notices an install done in another terminal as
  // soon as it refreshes, with nothing to invalidate.
  async function dependencyStatus() {
    const [ffmpeg, whisper] = await checkDependencies(["ffmpeg", "whisper"]);
    return { ffmpeg: ffmpeg.found, whisper: whisper.found };
  }

  async function stateResponse() {
    return {
      notes,
      config: {
        target,
        rootLabel: path.basename(target) || "voice notes",
        autoTranslate: currentConfig.autoTranslate ?? null,
        defaultModel: currentConfig.defaultModel || "turbo",
        openWhenDone: currentConfig.openWhenDone !== false,
        rememberDeletions: currentConfig.rememberDeletions !== false,
        configPath: configFilePath(),
      },
      models: MODELS,
      ...(await dependencyStatus()),
      job,
    };
  }

  /* ------------------------------- assets ------------------------------- */

  async function serveAsset(res, name) {
    const type = ASSETS[name];
    if (!type) return sendJson(res, 404, { error: `No asset named ${name}` });

    // Read per request rather than at startup, so editing app.css or app.js
    // only needs a browser reload, not a server restart.
    const body = await fs.readFile(new URL(name, ASSET_DIR));
    res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-store" });
    res.end(body);
  }

  /* ------------------------------- media -------------------------------- */

  function serveMedia(req, res, route) {
    const rel = decodeURIComponent(route.slice("/media/".length));
    const full = resolveInside(rel);
    if (!full) return sendJson(res, 400, { error: "Path outside the target folder" });

    let stat;
    try {
      stat = fs.statSync(full);
    } catch {
      return sendJson(res, 404, { error: "Not found" });
    }

    const type = MIME[path.extname(full).toLowerCase()] || "application/octet-stream";
    const range = req.headers.range;

    // Range support is what makes seeking (and Safari playback) work.
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

  /* ---------------------------- server-sent events ----------------------- */

  function serveEvents(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    clients.add(res);
    cancelShutdown();
    if (job) res.write(`event: job\ndata: ${JSON.stringify(job)}\n\n`);
    req.on("close", () => {
      clients.delete(res);
      // The open event stream is the reliable "a tab is watching" signal:
      // unlike a heartbeat it isn't throttled when the tab is backgrounded,
      // and it drops the instant the tab or browser goes away.
      if (clients.size === 0) scheduleShutdown("browser closed", 5000);
    });
  }

  /* ------------------------------ settings ------------------------------ */

  async function patchSettings(patch) {
    if ("autoTranslate" in patch) currentConfig.autoTranslate = patch.autoTranslate;
    if ("defaultModel" in patch && MODELS.includes(patch.defaultModel)) {
      currentConfig.defaultModel = patch.defaultModel;
    }
    if ("openWhenDone" in patch) currentConfig.openWhenDone = Boolean(patch.openWhenDone);
    if ("rememberDeletions" in patch) currentConfig.rememberDeletions = Boolean(patch.rememberDeletions);
    await saveConfig(currentConfig);
    console.log(chalk.dim("Settings updated from the browser."));
    return (await stateResponse()).config;
  }

  /* ------------------------- per-note file actions ----------------------- */

  function reveal(res, body) {
    const rel = body.rel;
    if (rel) {
      const full = resolveInside(rel);
      if (!full) return sendJson(res, 400, { error: "Path outside the target folder" });
      revealInFolder(full);
      return sendJson(res, 200, { opened: rel });
    }
    const dir = resolveInside(body.dir || "");
    if (!dir) return sendJson(res, 400, { error: "Path outside the target folder" });
    openPath(dir);
    return sendJson(res, 200, { opened: body.dir || "." });
  }

  async function saveTranscript(res, body) {
    const note = noteFor(body.rel);
    if (!note) return sendJson(res, 404, { error: "Unknown note" });
    const audio = resolveInside(body.rel);
    if (!audio) return sendJson(res, 400, { error: "Path outside the target folder" });
    const base = audio.slice(0, -path.extname(audio).length);

    if (Array.isArray(body.cues)) {
      // Timed transcript: only the text is editable, the original timings are
      // read back off disk and written out unchanged.
      const existing = await findTranscript(audio);
      if (!existing || existing.ext === ".txt") {
        return sendJson(res, 409, { error: "No timed transcript to update" });
      }
      const cues = parseCues(await fs.readFile(existing.path, "utf8"));
      if (cues.length !== body.cues.length) {
        return sendJson(res, 409, { error: "Transcript changed on disk - reload and try again" });
      }
      const merged = cues.map((cue, i) => ({ ...cue, text: String(body.cues[i] ?? "").replace(/\s+/g, " ").trim() }));
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
    console.log(chalk.dim(`Transcript saved from the browser: ${body.rel}`));
    return sendJson(res, 200, { note });
  }

  async function deleteNote(res, body) {
    const note = noteFor(body.rel);
    if (!note) return sendJson(res, 404, { error: "Unknown note" });
    const { removed, entry } = await removeRecording(body.rel);
    await remember(entry ? [entry] : [], "delete");
    notes = notes.filter((n) => n.rel !== body.rel);
    broadcast("notes", { count: notes.length });
    console.log(chalk.dim(`Deleted from the browser: ${body.rel}`));
    return sendJson(res, 200, { removed });
  }

  /**
   * Deletes an audio file plus any transcript sidecars. Returns the file count
   * and, when the recording itself was really there, the `{ rel, size }` the
   * deletion ledger needs - read before the delete, since it can't be after.
   * Callers record the entries themselves so a batch is one ledger write.
   */
  async function removeRecording(rel) {
    const audio = resolveInside(rel);
    if (!audio) throw new Error("Path outside the target folder");

    let size = null;
    let existed = false;
    try {
      const stat = await fs.stat(audio);
      existed = stat.isFile();
      size = stat.size;
    } catch {
      // already gone, or unreadable - the sidecars are still worth clearing
    }

    const base = audio.slice(0, -path.extname(audio).length);
    let removed = 0;
    for (const file of [audio, ...TRANSCRIPT_EXTS.map((ext) => base + ext)]) {
      if (await fs.pathExists(file)) {
        await fs.remove(file);
        removed++;
      }
    }
    return { removed, entry: existed ? { rel, size } : null };
  }

  /** Writes a batch of deletions to the ledger, honouring the config switch. */
  function remember(entries, via) {
    return recordDeletions(
      target,
      entries.map((entry) => ({ ...entry, via })),
      { enabled: currentConfig.rememberDeletions !== false }
    );
  }

  /* --------------------------------- jobs -------------------------------- */

  function startJob(kind, title, total) {
    job = { id: crypto.randomUUID(), kind, title, total, done: 0, running: true, error: null, lines: [] };
    broadcast("job", job);
    return job;
  }

  function jobLog(line) {
    if (!job) return;
    job.lines.push(line);
    if (job.lines.length > 200) job.lines.shift();
    broadcast("job", job);
  }

  function jobProgress(done, title) {
    if (!job) return;
    job.done = done;
    if (title) job.title = title;
    broadcast("job", job);
  }

  async function endJob(error) {
    if (!job) return;
    job.running = false;
    job.error = error ? String(error.message || error) : null;
    broadcast("job", job);
    await refreshNotes();
  }

  function guardJob(res) {
    if (job && job.running) {
      sendJson(res, 409, { error: `Busy: ${job.title}` });
      return true;
    }
    return false;
  }

  /* ------------------------------ transcribe ----------------------------- */

  async function startTranscribe(res, body) {
    if (guardJob(res)) return;
    // The browser can't run an installer, so the page points at the CLI, which
    // can: `vno setup` offers the install for whichever half is missing.
    const deps = await dependencyStatus();
    if (!deps.whisper || !deps.ffmpeg) {
      const missing = [!deps.ffmpeg && "ffmpeg", !deps.whisper && "whisper"].filter(Boolean);
      return sendJson(res, 412, {
        error: `${missing.join(" and ")} ${missing.length > 1 ? "aren't" : "isn't"} on your PATH. Run \`vno setup\` in a terminal to install ${missing.length > 1 ? "them" : "it"}.`,
      });
    }

    const rels = (Array.isArray(body.rels) ? body.rels : []).filter((rel) => noteFor(rel));
    if (rels.length === 0) return sendJson(res, 400, { error: "No valid files selected" });

    const model = MODELS.includes(body.model) ? body.model : currentConfig.defaultModel || "turbo";
    const translate = Boolean(body.translate);

    startJob("transcribe", `${translate ? "Translating" : "Transcribing"} ${rels.length} file(s)`, rels.length);
    sendJson(res, 202, { started: true });

    (async () => {
      const verb = translate ? "Translating" : "Transcribing";
      let done = 0;
      for (const rel of rels) {
        const full = resolveInside(rel);
        jobProgress(done, `${verb} ${path.basename(rel)} (${done + 1}/${rels.length})`);
        jobLog(`[${done + 1}/${rels.length}] ${verb} ${rel}`);
        console.log(chalk.cyan(`\n[${done + 1}/${rels.length}] ${verb} ${rel} (from the browser)...`));
        try {
          await transcribeFile(full, { model, translate, onOutput: (line) => jobLog(line) });
          done++;
          jobLog(`Saved ${rel.replace(/\.[^.]+$/, ".vtt")}`);
        } catch (err) {
          jobLog(`FAILED ${rel}: ${err.message}`);
          console.log(chalk.red(`Failed to transcribe ${rel}: ${err.message}`));
        }
        jobProgress(done);
      }
      jobProgress(done, `${translate ? "Translated" : "Transcribed"} ${done}/${rels.length} file(s)`);
      await endJob(null);
    })().catch((err) => endJob(err));
  }

  /* -------------------------------- import ------------------------------- */

  async function listVolumes() {
    const detected = await detectVolumes();
    const found = detected.map((v) => ({
      id: v.id,
      name: v.name,
      mountPath: v.mountPath,
      sizeBytes: v.sizeBytes ?? null,
      isManualSource: false,
      known: currentConfig.knownMounts?.[v.id] || null,
    }));

    for (const sourcePath of currentConfig.sources || []) {
      if (!(await fs.pathExists(sourcePath))) continue;
      found.push({
        id: `source:${sourcePath.toLowerCase()}`,
        name: path.basename(sourcePath) || "source",
        mountPath: sourcePath,
        sizeBytes: null,
        isManualSource: true,
        known: null,
      });
    }
    return found;
  }

  async function volumeById(id) {
    return (await listVolumes()).find((v) => v.id === id) || null;
  }

  async function browse(res, params) {
    const volume = await volumeById(params.get("volume"));
    if (!volume) return sendJson(res, 404, { error: "Unknown volume" });
    const sub = (params.get("sub") || "").split("/").filter((s) => s && s !== "." && s !== "..");
    const root = path.resolve(volume.mountPath);
    const current = path.resolve(root, sub.join(path.sep));
    if (current !== root && !current.startsWith(root + path.sep)) {
      return sendJson(res, 400, { error: "Path outside the volume" });
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
    return sendJson(res, 200, { root, current, sub: sub.join("/"), folders });
  }

  async function startImport(res, body) {
    if (guardJob(res)) return;
    const requests = Array.isArray(body.volumes) ? body.volumes : [];
    if (requests.length === 0) return sendJson(res, 400, { error: "No volumes selected" });

    const all = await listVolumes();
    const picked = requests
      .map((r) => ({ request: r, volume: all.find((v) => v.id === r.id) }))
      .filter((p) => p.volume);
    if (picked.length === 0) return sendJson(res, 400, { error: "Selected volumes are no longer connected" });

    const translate = Boolean(body.translate);
    startJob("import", `Importing from ${picked.length} volume(s)`, picked.length);
    sendJson(res, 202, { started: true });

    (async () => {
      let done = 0;
      const imported = [];
      for (const { request, volume } of picked) {
        const subdir = (request.subdir || "").trim();
        jobProgress(done, `Importing "${volume.name}"`);
        jobLog(`Syncing "${volume.name}"${subdir ? " / " + subdir : ""}...`);
        const effective = {
          name: volume.name,
          destName: volume.name,
          mountPath: subdir ? path.join(volume.mountPath, subdir) : volume.mountPath,
        };
        try {
          const result = await syncVolume(effective, target, {
            rememberDeletions: currentConfig.rememberDeletions !== false,
          });
          imported.push(...result.copiedFiles);
          jobLog(
            `"${volume.name}": ${result.copied} copied, ${result.skipped} already up to date` +
              (result.suppressed > 0 ? `, ${result.suppressed} previously deleted (left alone)` : "")
          );
          if (!volume.isManualSource && request.remember !== false) {
            currentConfig.knownMounts[volume.id] = {
              name: volume.name,
              autoImport: true,
              sourceSubdir: subdir || null,
              lastSynced: new Date().toISOString(),
              lastResult: { copied: result.copied, skipped: result.skipped, total: result.total },
            };
            await saveConfig(currentConfig);
          }
        } catch (err) {
          jobLog(`FAILED "${volume.name}": ${err.message}`);
        }
        done++;
        jobProgress(done);
      }

      await refreshNotes();

      if (translate && imported.length > 0) {
        const deps = await dependencyStatus();
        if (!deps.whisper || !deps.ffmpeg) {
          jobLog("Skipping translation - whisper/ffmpeg isn't on your PATH. Run `vno setup`.");
        } else {
          const model = currentConfig.defaultModel || "turbo";
          job.total = picked.length + imported.length;
          let t = 0;
          for (const file of imported) {
            const rel = path.relative(target, file).split(path.sep).join("/");
            jobProgress(picked.length + t, `Translating ${path.basename(file)} (${t + 1}/${imported.length})`);
            jobLog(`[${t + 1}/${imported.length}] Translating ${rel}`);
            try {
              await transcribeFile(file, { model, translate: true, onOutput: (line) => jobLog(line) });
              jobLog(`Saved ${rel.replace(/\.[^.]+$/, ".vtt")}`);
            } catch (err) {
              jobLog(`FAILED ${rel}: ${err.message}`);
            }
            t++;
            jobProgress(picked.length + t);
          }
        }
      }

      jobProgress(job.total, `Imported ${imported.length} new note(s)`);
      await endJob(null);
    })().catch((err) => endJob(err));
  }

  /* -------------------------------- cleanup ------------------------------ */

  async function scanShort(res, params) {
    const threshold = Math.max(0, parseFloat(params.get("threshold")) || 3);
    const files = await findAudioFiles(target);
    const short = [];
    for (const file of files) {
      const duration = await getDurationSeconds(file);
      if (duration !== null && duration < threshold) {
        short.push({
          rel: path.relative(target, file).split(path.sep).join("/"),
          name: path.basename(file),
          durationSec: duration,
        });
      }
    }
    return sendJson(res, 200, { threshold, short, scanned: files.length });
  }

  async function runCleanupJob(res, body) {
    const rels = (Array.isArray(body.rels) ? body.rels : []).filter((rel) => noteFor(rel));
    if (rels.length === 0) return sendJson(res, 400, { error: "Nothing selected" });
    let removed = 0;
    const deleted = [];
    for (const rel of rels) {
      try {
        const result = await removeRecording(rel);
        removed += result.removed;
        if (result.entry) deleted.push(result.entry);
      } catch {
        // skip files that vanished or are locked; the count reflects reality
      }
    }
    await remember(deleted, "cleanup");
    await refreshNotes();
    console.log(chalk.dim(`Cleanup from the browser: removed ${removed} file(s).`));
    return sendJson(res, 200, { removed, deleted: rels.length });
  }

  /* ------------------------------- lifecycle ----------------------------- */

  /**
   * Shutdown is deferred rather than immediate so a reload (which drops the
   * event stream for a second) doesn't end the session, and so a transcription
   * already in flight finishes instead of leaving a half-written file.
   */
  function scheduleShutdown(reason, delay) {
    clearTimeout(byeTimer);
    byeTimer = setTimeout(() => {
      if (clients.size > 0) return; // a tab came back
      if (job && job.running) {
        console.log(chalk.dim("Browser closed - finishing the running job before exiting..."));
        return scheduleShutdown(reason, 2000);
      }
      stop(reason);
    }, delay);
  }

  function cancelShutdown() {
    clearTimeout(byeTimer);
    byeTimer = null;
  }

  // Backstop for a wedged connection that never closes (proxy, sleeping
  // laptop). Deliberately long: background tabs throttle their heartbeat.
  const watchdog = setInterval(() => {
    if (!sawBrowser || (job && job.running) || clients.size > 0) return;
    if (Date.now() - lastSeen > 120000) stop("browser stopped responding");
  }, 10000);

  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function stop(reason) {
    if (stopping) return closed;
    stopping = true;
    clearInterval(watchdog);
    clearTimeout(byeTimer);
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // client already gone
      }
    }
    clients.clear();
    server.close(() => resolveClosed(reason || "stopped"));
    for (const socket of sockets) socket.destroy();
    return closed;
  }

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const url = `http://${host}:${address.port}/?t=${token}`;

  return { url, port: address.port, token, stop, closed };
}
