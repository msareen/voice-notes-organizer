import fs from "fs-extra";
import chalk from "chalk";
import { loadConfig } from "../lib/config.ts";
import { startServer } from "../web/server/index.ts";
import { openPath, findInstalledPwaShortcut } from "../lib/open.ts";
import { createProgressBar } from "./progress.ts";
import { getSessionToken } from "../lib/sessionToken.ts";
import type { ServerHandle } from "../web/server/index.ts";

// Fixed so the URL is stable across runs (bookmarks, browser history, and an
// installed PWA's start_url, which is baked in at install time and can't be
// updated to chase a fallback port) instead of changing every launch.
// `--port 0` still asks for an OS-assigned free port explicitly, which is
// why the already-running check below skips it.
//
// This is only the fallback: `config.port` overrides it, because a machine
// can be unable to bind the default at all, and no amount of retrying fixes it.
// Windows reserves whole TCP ranges for Hyper-V/WSL2's dynamic allocator
// (`netsh interface ipv4 show excludedportrange protocol=tcp`), and a bind
// inside one fails as EADDRINUSE with nothing actually listening - so the
// "is a vno already running?" check below finds nobody and correctly reports
// it as squatted. Changing the port is the only fix, and it has to persist,
// or every launch needs the flag again.
// 9477 rather than 8477: Windows reserves 8385-8484 on some machines (the
// Hyper-V range above), which makes the old default unbindable there with no
// way to tell it apart from a real conflict. 9477 sits clear of both that and
// the ephemeral range.
export const DEFAULT_PORT = 9477;
const HOST = "127.0.0.1"; // matches startServer's own default

/** Node tags a bind failure with `code`, which is the only part worth branching on. */
function errorCode(err: unknown): string | undefined {
  return typeof (err as { code?: unknown })?.code === "string"
    ? (err as { code: string }).code
    : undefined;
}

/**
 * A port collision on the fixed default is almost always a `vno v` that's
 * already running - the common case is opening a second tab, not picking a
 * new port. Confirmed with a request carrying the same persisted token
 * (lib/sessionToken.ts) rather than assumed from the error alone, so
 * something unrelated squatting the port still gets reported as busy.
 */
async function findRunningInstance(port: number): Promise<string | null> {
  const token = await getSessionToken();
  const url = `http://${HOST}:${port}/?t=${token}`;
  try {
    // `Connection: close` matters here: fetch's default keep-alive socket
    // would otherwise stay open (and keep this one-shot CLI process alive)
    // well past the point the answer's already in hand.
    const res = await fetch(`http://${HOST}:${port}/api/state?t=${token}`, {
      headers: { Connection: "close" },
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    // A 200 alone isn't proof it's vno - anything else squatting the port
    // could happen to answer every request with 200. Confirm the shape of
    // /api/state's actual response instead of trusting the status code alone.
    const body = (await res.json()) as { config?: { target?: unknown } } | null;
    return body && body.config && typeof body.config.target === "string" ? url : null;
  } catch {
    return null;
  }
}

/**
 * Opens the viewer for a human to look at: the installed PWA's own window if
 * one's been installed, a plain browser tab otherwise. Launching the app
 * window instead of a tab is the whole point of installing it - and its
 * start_url already carries the current persisted token, so it lands on a
 * working session exactly like a fresh tab would.
 */
async function openViewer(url: string): Promise<void> {
  const shortcut = await findInstalledPwaShortcut();
  openPath(shortcut || url);
}

export interface VisualizeOptions {
  open?: boolean;
  /** `--port`. Left null, `config.port` decides, falling back to DEFAULT_PORT. */
  port?: number | null;
  quiet?: boolean;
}

/**
 * Launches the local viewer: a small HTTP server on loopback that serves the
 * two-pane player and an API for everything the CLI can do (import,
 * transcribe, cleanup, settings, transcript edits, revealing files).
 *
 * It blocks until the server stops - which happens when the browser tab is
 * closed, the page's Quit button is used, or Ctrl+C is pressed - so closing
 * the browser ends the CLI session.
 */
export async function runVisualize({
  open = true,
  port = null,
  quiet = false,
}: VisualizeOptions = {}): Promise<string | null> {
  const config = await loadConfig();

  // `??` rather than `||` so an explicit `--port 0` (ask the OS for a free
  // one) isn't mistaken for "unset" and replaced by the configured port.
  const resolvedPort = port ?? config.port ?? DEFAULT_PORT;

  // The folder may not exist yet on a first run; create it so the viewer can
  // be used to import into it.
  await fs.ensureDir(config.target);

  // Building the note model costs an ffprobe per recording, so a large library
  // leaves the terminal silent for a long time before the browser opens. The
  // bar is transient - cleared the moment the server is up.
  const bar = createProgressBar(chalk.dim("Reading recordings"));

  let server: ServerHandle;
  try {
    server = await startServer({ config, port: resolvedPort, host: HOST, onScanProgress: bar.report });
  } catch (err) {
    if (errorCode(err) !== "EADDRINUSE" || resolvedPort === 0) throw err;

    const runningUrl = await findRunningInstance(resolvedPort);
    if (!runningUrl) {
      console.log(chalk.red(`Port ${resolvedPort} is already in use by something else.`));
      console.log(chalk.dim("Pick a free one with --port, or set it permanently in `vno setting` → Viewer port."));
      return null;
    }

    if (quiet) {
      console.log(chalk.dim(`Already running at ${runningUrl}`));
    } else {
      console.log(chalk.green(`vno is already running at ${chalk.bold(runningUrl)}`));
    }
    if (open) await openViewer(runningUrl);
    return runningUrl;
  } finally {
    bar.stop();
  }

  if (quiet) {
    console.log(chalk.dim(`Viewer running at ${server.url}`));
  } else {
    console.log(chalk.green(`Voice notes viewer running at ${chalk.bold(server.url)}`));
    console.log(chalk.dim(`Serving ${config.target}`));
    console.log(chalk.dim("Closing the browser tab (or Ctrl+C) stops this server."));
  }

  if (open) await openViewer(server.url);

  const onSigint = () => server.stop("interrupted");
  process.once("SIGINT", onSigint);
  const reason = await server.closed;
  process.off("SIGINT", onSigint);

  console.log(chalk.dim(`\nViewer stopped (${reason}).`));
  return server.url;
}
