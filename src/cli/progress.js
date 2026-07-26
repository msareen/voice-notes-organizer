import chalk from "chalk";

const BAR_WIDTH = 24;
const FRAME_MS = 80; // redraw ceiling; ffprobe returns fast enough to flicker without it

const ESC_CHAR = String.fromCharCode(27);
const ESC = ESC_CHAR + "[";
const CLEAR_LINE = `\r${ESC}2K`;
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const RESET = `${ESC}0m`;

// Same test ora uses: legacy conhost can't draw block characters, but Windows
// Terminal, VS Code and every non-Windows terminal can.
const UNICODE =
  process.platform !== "win32" || Boolean(process.env.WT_SESSION) || process.env.TERM_PROGRAM === "vscode";
const FULL = UNICODE ? "█" : "#";
const EMPTY = UNICODE ? "░" : "-";

/**
 * A single-line, determinate progress bar for countable work - currently the
 * ffprobe pass that builds the note model before the viewer opens, which is
 * otherwise a long silence on a large library.
 *
 * Deliberately not `ora`: this is a count, not a spinner, and ora's own redraw
 * timer fights with ours. Nothing is drawn when stdout isn't a TTY, so piped
 * or redirected output doesn't collect escape codes.
 *
 * `report` takes the event shape `buildNotes` emits, so it can be handed
 * straight to it as `onProgress`.
 */
export function createProgressBar(label) {
  const tty = Boolean(process.stdout.isTTY);
  let cursorHidden = false;
  let lastDrawAt = 0;
  let current = null; // last event, so a forced redraw has something to draw

  const write = (s) => process.stdout.write(s);

  // Ctrl+C during the scan would otherwise leave the terminal with no cursor.
  const onExit = () => showCursor();
  function hideCursor() {
    if (cursorHidden) return;
    cursorHidden = true;
    process.once("exit", onExit);
    write(HIDE_CURSOR);
  }
  function showCursor() {
    if (!cursorHidden) return;
    cursorHidden = false;
    process.off("exit", onExit);
    write(SHOW_CURSOR);
  }

  function render(event) {
    const width = (process.stdout.columns || 80) - 1;

    if (event.phase === "scan") {
      return truncate(`${label} ${chalk.dim("scanning for recordings...")}`, width);
    }

    const { done = 0, total = 0, dir = "", name = "" } = event;
    const ratio = total > 0 ? Math.min(1, done / total) : 0;
    const filled = Math.round(ratio * BAR_WIDTH);
    const bar = chalk.cyan(FULL.repeat(filled)) + chalk.dim(EMPTY.repeat(BAR_WIDTH - filled));
    const count = `${String(done).padStart(String(total).length, " ")}/${total}`;
    // The folder, not the file: it changes slowly enough to actually read, and
    // it's what tells you which part of the library is being chewed through.
    const where = dir || (name ? "." : "");
    const line = `${label} [${bar}] ${count}${where ? chalk.dim("  " + where) : ""}`;
    return truncate(line, width);
  }

  function draw(force) {
    if (!tty || !current) return;
    const now = Date.now();
    if (!force && now - lastDrawAt < FRAME_MS) return;
    lastDrawAt = now;
    hideCursor();
    write(CLEAR_LINE + render(current));
  }

  return {
    /** Feed a `buildNotes` progress event. Safe to call at any rate. */
    report(event) {
      current = event;
      // Phase changes and the final tick must land however fast they arrive.
      draw(event.phase === "scan" || (event.total > 0 && event.done >= event.total));
    },
    /** Erase the bar and hand the line back. Idempotent. */
    stop() {
      current = null;
      if (!tty) return;
      write(CLEAR_LINE);
      showCursor();
    },
  };
}

/** Trims to `width` visible columns, ignoring the ANSI codes chalk inserted. */
function truncate(line, width) {
  if (width <= 0) return "";
  let visible = 0;
  let out = "";
  for (let i = 0; i < line.length; i++) {
    if (line[i] === ESC_CHAR) {
      const end = line.indexOf("m", i);
      if (end !== -1) {
        out += line.slice(i, end + 1);
        i = end;
        continue;
      }
    }
    if (visible >= width) return out + RESET;
    out += line[i];
    visible++;
  }
  return out;
}
