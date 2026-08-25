// Bootstraps the Bun.serve HTTP server: builds the shared context, wires each
// route module into the routes table below, and owns the process/lifecycle
// (shutdown deferral, the disconnect watchdog).
import path from "node:path";
import chalk from "chalk";
import { renderPage, renderManifest } from "../page.ts";
import { themeOf } from "../../lib/shared/themes.ts";
import { getSessionToken } from "../../lib/sessionToken.ts";
import { createContext } from "./context.ts";
import { serveAsset } from "./assets.ts";
import { serveMedia } from "./media.ts";
import { serveEvents } from "./events.ts";
import { createStateRoutes } from "./routes/state.ts";
import { createSettingsRoutes } from "./routes/settings.ts";
import { createNotesRoutes } from "./routes/notes.ts";
import { createTranscribeRoutes } from "./routes/transcribe.ts";
import { createSummarizeRoutes } from "./routes/summarize.ts";
import { createImportRoutes, MAX_UPLOAD_BYTES } from "./routes/import.ts";
import { createCleanupRoutes } from "./routes/cleanup.ts";
import type { Config, ProgressCallback } from "../../types.ts";

export interface StartServerOptions {
  config: Config;
  /** 0 asks the OS for a free port. */
  port?: number;
  host?: string;
  onScanProgress?: ProgressCallback | null;
}

/** What `startServer` hands back; `cli/visualize.ts` blocks on `closed`. */
export interface ServerHandle {
  url: string;
  port: number;
  token: string;
  /** Resolves with the reason once the server has actually closed. */
  stop(reason: string): Promise<string>;
  closed: Promise<string>;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Starts the local viewer/control server. Resolves with { url, stop, closed }:
 * `closed` settles when the server shuts down, which happens when the browser
 * tab goes away, the page's Quit button is used, or `stop()` is called.
 */
export async function startServer({
  config,
  port = 0,
  host = "127.0.0.1",
  onScanProgress = null,
}: StartServerOptions): Promise<ServerHandle> {
  const token = await getSessionToken();
  const target = path.resolve(config.target);

  const ctx = await createContext({ config, target, onScanProgress });

  const stateRoutes = createStateRoutes(ctx);
  const settingsRoutes = createSettingsRoutes(ctx);
  const notesRoutes = createNotesRoutes(ctx);
  const transcribeRoutes = createTranscribeRoutes(ctx);
  const summarizeRoutes = createSummarizeRoutes(ctx);
  const importRoutes = createImportRoutes(ctx);
  const cleanupRoutes = createCleanupRoutes(ctx);

  let lastSeen = Date.now();
  let sawBrowser = false;
  let byeTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  /* --------------------------- request handling -------------------------- */

  /**
   * Wraps every token-gated route: the origin check, the token gate (query,
   * header, or JSON body - sendBeacon can't set headers, so the body counts
   * too), and the "a browser is actively using this" tracking the shutdown
   * watchdog reads. `logic` gets the already-parsed body for non-GET/HEAD
   * requests, matching what the route modules expect.
   */
  function withAuth(
    logic: (req: Request, body: any, server: Bun.Server<undefined>) => Response | Promise<Response>
  ): (req: Request, server: Bun.Server<undefined>) => Promise<Response> {
    return async (req: Request, server: Bun.Server<undefined>): Promise<Response> => {
      const url = new URL(req.url);

      // Only ever talk to a loopback client, and never to a page from another
      // origin - these endpoints delete files and launch programs.
      const origin = req.headers.get("origin");
      if (origin && origin !== `http://${req.headers.get("host")}`) {
        return ctx.sendJson(403, { error: "Cross-origin request refused" });
      }

      const body = req.method === "GET" || req.method === "HEAD" ? {} : await ctx.readBody(req);
      const supplied = req.headers.get("x-vno-token") || url.searchParams.get("t") || body.token;
      if (supplied !== token) return ctx.sendJson(403, { error: "Invalid session token" });

      lastSeen = Date.now();
      sawBrowser = true;

      return logic(req, body, server);
    };
  }

  const server = Bun.serve({
    port,
    hostname: host,
    // /api/upload needs to exceed Bun's 128MB default; a little headroom over
    // MAX_UPLOAD_BYTES so the route's own "File too large" message is the one
    // that fires, not a generic rejection from Bun underneath it.
    maxRequestBodySize: MAX_UPLOAD_BYTES + 10 * 1024 * 1024,
    // Unlike node:http (no default request timeout), Bun.serve drops an idle
    // connection after 10s by default. /api/cleanup/scan awaits an uncached
    // ffprobe per recording before responding at all - no bytes flow on the
    // wire in the meantime - so a real library can outlast the default and
    // get its connection dropped mid-scan. 255 is Bun's own maximum; the SSE
    // route disables its timeout entirely instead (see serveEvents) since
    // even 255s isn't "however long the tab stays open".
    idleTimeout: 255,
    error(err) {
      return ctx.sendJson(500, { error: errorMessage(err) });
    },
    routes: {
      "/": (req) => {
        const url = new URL(req.url);
        if (url.searchParams.get("t") !== token) {
          return new Response("Invalid or missing session token. Open the URL vno printed in your terminal.", {
            status: 403,
            headers: { "Content-Type": "text/plain" },
          });
        }
        const html = renderPage({
          rootLabel: path.basename(target) || "voice notes",
          token,
          theme: themeOf(ctx.config),
        });
        return new Response(html, {
          status: 200,
          headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" },
        });
      },

      "/favicon.ico": () => new Response(null, { status: 204 }),

      // The page's stylesheet and client modules. Deliberately ahead of the
      // token gate: they hold no secrets (the token is inlined into the HTML),
      // and gating them would mean putting the token in an asset URL, which is
      // worse.
      "/assets/*": (req) => serveAsset(new URL(req.url).pathname.slice("/assets/".length)),

      // The PWA manifest and service worker. Served at the root path (not
      // under /assets/) so the worker's default scope covers the whole origin
      // - a script registered from /assets/sw.js could only control
      // /assets/*. The manifest is generated per request (like the page)
      // because its start_url has to carry the current token - an installed
      // PWA's fixed shortcut has no other way to get one, since it can't be
      // prompted for it the way a fresh `vno v` run's printed URL can.
      "/manifest.webmanifest": () =>
        new Response(renderManifest({ token }), {
          headers: { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-store" },
        }),
      "/sw.js": () => serveAsset("sw.ts"),

      // Dropped-file uploads stream raw bytes, not JSON, and can be well past
      // readBody's 5MB cap - it's its own route with its own token check off
      // the query string (fetch can't set a header on a body-carrying request
      // without a CORS preflight round trip here), so it doesn't go through
      // withAuth's JSON body parse.
      "/api/upload": {
        POST: (req) => importRoutes.upload(req, new URL(req.url).searchParams, token),
      },

      "/media/*": { GET: withAuth((req) => serveMedia(ctx, req, new URL(req.url).pathname)) },
      "/api/events": { GET: withAuth((req, body, server) => serveEvents(ctx, req, server)) },

      "/api/state": { GET: withAuth(() => stateRoutes.state()) },
      "/api/ping": { POST: withAuth(() => stateRoutes.ping()) },
      "/api/bye": { POST: withAuth((req, body) => stateRoutes.bye(body)) },

      "/api/settings": { POST: withAuth((req, body) => settingsRoutes.settings(body)) },
      "/api/sources": { POST: withAuth((req, body) => settingsRoutes.sources(body)) },
      "/api/sources/explore": { POST: withAuth((req, body) => settingsRoutes.exploreSourceDest(body)) },

      "/api/reveal": { POST: withAuth((req, body) => notesRoutes.reveal(body)) },
      "/api/transcript": { PUT: withAuth((req, body) => notesRoutes.saveTranscript(body)) },
      "/api/notes/delete": { POST: withAuth((req, body) => notesRoutes.deleteNote(body)) },
      "/api/notes/refresh": { POST: withAuth((req, body) => notesRoutes.refresh(body)) },

      "/api/transcribe": { POST: withAuth((req, body) => transcribeRoutes.transcribe(body)) },

      "/api/summarize": { POST: withAuth((req, body) => summarizeRoutes.summarize(body)) },
      "/api/summary": { PUT: withAuth((req, body) => summarizeRoutes.saveSummary(body)) },

      "/api/volumes": { GET: withAuth(() => importRoutes.volumes()) },
      "/api/browse": { GET: withAuth((req) => importRoutes.browse(new URL(req.url).searchParams)) },
      "/api/browse-target": { GET: withAuth((req) => importRoutes.browseTarget(new URL(req.url).searchParams)) },
      "/api/browse-fs": { GET: withAuth((req) => importRoutes.browseFs(new URL(req.url).searchParams)) },
      "/api/import": { POST: withAuth((req, body) => importRoutes.startImport(body)) },

      "/api/cleanup/scan": { GET: withAuth((req) => cleanupRoutes.scan(new URL(req.url).searchParams)) },
      "/api/cleanup": { POST: withAuth((req, body) => cleanupRoutes.run(body)) },
    },
    fetch(req) {
      const url = new URL(req.url);
      return ctx.sendJson(404, { error: `No route for ${req.method} ${url.pathname}` });
    },
  });

  /* ------------------------------- lifecycle ----------------------------- */

  /**
   * Shutdown is deferred rather than immediate so a reload (which drops the
   * event stream for a second) doesn't end the session, and so a transcription
   * already in flight finishes instead of leaving a half-written file.
   */
  function scheduleShutdown(reason: string, delay: number): void {
    if (byeTimer) clearTimeout(byeTimer);
    byeTimer = setTimeout(() => {
      if (ctx.clients.size > 0) return; // a tab came back
      if (ctx.job && ctx.job.running) {
        console.log(chalk.dim("Browser closed - finishing the running job before exiting..."));
        return scheduleShutdown(reason, 2000);
      }
      stop(reason);
    }, delay);
  }

  function cancelShutdown(): void {
    if (byeTimer) clearTimeout(byeTimer);
    byeTimer = null;
  }

  let resolveClosed!: (reason: string) => void;
  const closed = new Promise<string>((resolve) => {
    resolveClosed = resolve;
  });

  function stop(reason: string): Promise<string> {
    if (stopping) return closed;
    stopping = true;
    clearInterval(watchdog);
    if (byeTimer) clearTimeout(byeTimer);
    for (const client of ctx.clients) {
      try {
        client.close();
      } catch {
        // client already gone
      }
    }
    ctx.clients.clear();
    server.stop(true).then(() => resolveClosed(reason || "stopped"));
    return closed;
  }

  ctx.stop = stop;
  ctx.scheduleShutdown = scheduleShutdown;
  ctx.cancelShutdown = cancelShutdown;

  // Backstop for a wedged connection that never closes (proxy, sleeping
  // laptop). Deliberately long: background tabs throttle their heartbeat.
  // Bun.serve binds synchronously - reaching this point means the bind
  // already succeeded, so unlike the old listen-then-callback dance there's
  // no failed-bind path that could leak this interval.
  const watchdog: ReturnType<typeof setInterval> = setInterval(() => {
    if (!sawBrowser || (ctx.job && ctx.job.running) || ctx.clients.size > 0) return;
    if (Date.now() - lastSeen > 120000) stop("browser stopped responding");
  }, 10000);

  const url = `http://${host}:${server.port}/?t=${token}`;

  return { url, port: server.port!, token, stop, closed };
}
