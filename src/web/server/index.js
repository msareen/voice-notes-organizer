// Bootstraps the http.Server: builds the shared context, wires each route
// module into the request dispatch table below, and owns the process/socket
// lifecycle (shutdown deferral, the disconnect watchdog).
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import { URL } from "node:url";
import chalk from "chalk";
import { renderPage } from "../page.js";
import { createContext } from "./context.js";
import { serveAsset } from "./assets.js";
import { serveMedia } from "./media.js";
import { serveEvents } from "./events.js";
import { createStateRoutes } from "./routes/state.js";
import { createSettingsRoutes } from "./routes/settings.js";
import { createNotesRoutes } from "./routes/notes.js";
import { createTranscribeRoutes } from "./routes/transcribe.js";
import { createImportRoutes } from "./routes/import.js";
import { createCleanupRoutes } from "./routes/cleanup.js";

/**
 * Starts the local viewer/control server. Resolves with { url, stop, closed }:
 * `closed` settles when the server shuts down, which happens when the browser
 * tab goes away, the page's Quit button is used, or `stop()` is called.
 */
export async function startServer({ config, port = 0, host = "127.0.0.1", onScanProgress = null } = {}) {
  const token = crypto.randomBytes(24).toString("hex");
  const target = path.resolve(config.target);

  const ctx = await createContext({ config, target, onScanProgress });

  const stateRoutes = createStateRoutes(ctx);
  const settingsRoutes = createSettingsRoutes(ctx);
  const notesRoutes = createNotesRoutes(ctx);
  const transcribeRoutes = createTranscribeRoutes(ctx);
  const importRoutes = createImportRoutes(ctx);
  const cleanupRoutes = createCleanupRoutes(ctx);

  const sockets = new Set(); // every live socket, so shutdown can't hang
  let lastSeen = Date.now();
  let sawBrowser = false;
  let byeTimer = null;
  let stopping = false;

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => ctx.sendJson(res, 500, { error: String(err.message || err) }));
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  /* --------------------------- request handling -------------------------- */

  async function handle(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
    const route = url.pathname;

    // Only ever talk to a loopback client, and never to a page from another
    // origin - these endpoints delete files and launch programs.
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}`) {
      return ctx.sendJson(res, 403, { error: "Cross-origin request refused" });
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
    if (route.startsWith("/assets/")) return serveAsset(res, ctx.sendJson, route.slice(8));

    // Dropped-file uploads stream raw bytes, not JSON, and can be well past
    // readBody's 5MB cap - handled before the generic body read below, with
    // its own token check off the query string (fetch can't set a header on
    // a body-carrying request without a CORS preflight round trip here).
    if (route === "/api/upload" && req.method === "POST") {
      return importRoutes.upload(req, res, url.searchParams, token);
    }

    // Everything below is token-gated. sendBeacon can't set headers, so a
    // token in the JSON body counts too.
    const body = req.method === "GET" || req.method === "HEAD" ? {} : await ctx.readBody(req);
    const supplied = req.headers["x-vno-token"] || url.searchParams.get("t") || body.token;
    if (supplied !== token) return ctx.sendJson(res, 403, { error: "Invalid session token" });

    lastSeen = Date.now();
    sawBrowser = true;

    if (route.startsWith("/media/")) return serveMedia(ctx, req, res, route);
    if (route === "/api/events") return serveEvents(ctx, req, res);

    switch (route + " " + req.method) {
      case "/api/state GET":
        return stateRoutes.state(res);
      case "/api/ping POST":
        return stateRoutes.ping(res);
      case "/api/bye POST":
        return stateRoutes.bye(res, body);

      case "/api/settings POST":
        return settingsRoutes.settings(res, body);
      case "/api/sources POST":
        return settingsRoutes.sources(res, body);
      case "/api/sources/explore POST":
        return settingsRoutes.exploreSourceDest(res, body);

      case "/api/reveal POST":
        return notesRoutes.reveal(res, body);
      case "/api/transcript PUT":
        return notesRoutes.saveTranscript(res, body);
      case "/api/notes/delete POST":
        return notesRoutes.deleteNote(res, body);
      case "/api/notes/refresh POST":
        return notesRoutes.refresh(res, body);

      case "/api/transcribe POST":
        return transcribeRoutes.transcribe(res, body);

      case "/api/volumes GET":
        return importRoutes.volumes(res);
      case "/api/browse GET":
        return importRoutes.browse(res, url.searchParams);
      case "/api/browse-target GET":
        return importRoutes.browseTarget(res, url.searchParams);
      case "/api/browse-fs GET":
        return importRoutes.browseFs(res, url.searchParams);
      case "/api/import POST":
        return importRoutes.startImport(res, body);

      case "/api/cleanup/scan GET":
        return cleanupRoutes.scan(res, url.searchParams);
      case "/api/cleanup POST":
        return cleanupRoutes.run(res, body);

      default:
        return ctx.sendJson(res, 404, { error: `No route for ${req.method} ${route}` });
    }
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
      if (ctx.clients.size > 0) return; // a tab came back
      if (ctx.job && ctx.job.running) {
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

  let resolveClosed;
  const closed = new Promise((resolve) => {
    resolveClosed = resolve;
  });

  function stop(reason) {
    if (stopping) return closed;
    stopping = true;
    clearInterval(watchdog);
    clearTimeout(byeTimer);
    for (const client of ctx.clients) {
      try {
        client.end();
      } catch {
        // client already gone
      }
    }
    ctx.clients.clear();
    server.close(() => resolveClosed(reason || "stopped"));
    for (const socket of sockets) socket.destroy();
    return closed;
  }

  ctx.stop = stop;
  ctx.scheduleShutdown = scheduleShutdown;
  ctx.cancelShutdown = cancelShutdown;

  // Backstop for a wedged connection that never closes (proxy, sleeping
  // laptop). Deliberately long: background tabs throttle their heartbeat.
  const watchdog = setInterval(() => {
    if (!sawBrowser || (ctx.job && ctx.job.running) || ctx.clients.size > 0) return;
    if (Date.now() - lastSeen > 120000) stop("browser stopped responding");
  }, 10000);

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const url = `http://${host}:${address.port}/?t=${token}`;

  return { url, port: address.port, token, stop, closed };
}
