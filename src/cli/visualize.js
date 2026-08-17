import fs from "fs-extra";
import chalk from "chalk";
import { loadConfig } from "../lib/config.js";
import { startServer } from "../web/server/index.js";
import { openPath } from "../lib/open.js";
import { createProgressBar } from "./progress.js";

// Fixed so the URL is stable across runs (bookmarks, browser history) instead
// of changing every launch. `--port 0` still asks for an OS-assigned free
// port explicitly, which is why the fallback-on-busy logic below skips it.
export const DEFAULT_PORT = 8477;

/**
 * Launches the local viewer: a small HTTP server on loopback that serves the
 * two-pane player and an API for everything the CLI can do (import,
 * transcribe, cleanup, settings, transcript edits, revealing files).
 *
 * It blocks until the server stops - which happens when the browser tab is
 * closed, the page's Quit button is used, or Ctrl+C is pressed - so closing
 * the browser ends the CLI session.
 */
export async function runVisualize({ open = true, port = DEFAULT_PORT, quiet = false } = {}) {
  const config = await loadConfig();

  // The folder may not exist yet on a first run; create it so the viewer can
  // be used to import into it.
  await fs.ensureDir(config.target);

  // Building the note model costs an ffprobe per recording, so a large library
  // leaves the terminal silent for a long time before the browser opens. The
  // bar is transient - cleared the moment the server is up.
  const bar = createProgressBar(chalk.dim("Reading recordings"));

  let server;
  try {
    server = await startServer({ config, port, onScanProgress: bar.report });
  } catch (err) {
    if (err.code !== "EADDRINUSE" || port === 0) throw err;

    // The fixed default port is the common case that collides (a previous
    // `vno visualize` still running, something else bound to it) - one retry
    // one port up keeps `vno visualize` working without forcing the user to
    // go hunt for a free port themselves.
    const fallbackPort = port + 1;
    bar.log(`Port ${port} is already in use - trying ${fallbackPort} instead.`, "warn");
    try {
      server = await startServer({ config, port: fallbackPort, onScanProgress: bar.report });
    } catch (err2) {
      if (err2.code === "EADDRINUSE") {
        console.log(chalk.red(`Ports ${port} and ${fallbackPort} are both in use. Pick a free one with --port.`));
        return null;
      }
      throw err2;
    }
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

  if (open) openPath(server.url);

  const onSigint = () => server.stop("interrupted");
  process.once("SIGINT", onSigint);
  const reason = await server.closed;
  process.off("SIGINT", onSigint);

  console.log(chalk.dim(`\nViewer stopped (${reason}).`));
  return server.url;
}
