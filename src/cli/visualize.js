import fs from "fs-extra";
import chalk from "chalk";
import { loadConfig } from "../lib/config.js";
import { startServer } from "../web/server.js";
import { openPath } from "../lib/open.js";

/**
 * Launches the local viewer: a small HTTP server on loopback that serves the
 * two-pane player and an API for everything the CLI can do (import,
 * transcribe, cleanup, settings, transcript edits, revealing files).
 *
 * It blocks until the server stops - which happens when the browser tab is
 * closed, the page's Quit button is used, or Ctrl+C is pressed - so closing
 * the browser ends the CLI session.
 */
export async function runVisualize({ open = true, port = 0, quiet = false } = {}) {
  const config = await loadConfig();

  // The folder may not exist yet on a first run; create it so the viewer can
  // be used to import into it.
  await fs.ensureDir(config.target);

  let server;
  try {
    server = await startServer({ config, port });
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.log(chalk.red(`Port ${port} is already in use. Pick another with --port, or omit it to auto-pick.`));
      return null;
    }
    throw err;
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
