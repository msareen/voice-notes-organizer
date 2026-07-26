import path from "node:path";
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
 * A single-line progress bar for the per-file work that would otherwise leave
 * the terminal silent: the ffprobe pass behind `visualize` and `transcribe`'s
 * picker, `cleanup`'s duration scan, and `import`'s copy.
 *
 * Deliberately not `ora`: these are counts, not spinners, and ora's own redraw
 * timer fights with ours. Nothing is drawn when stdout isn't a TTY, so piped
 * or redirected output doesn't collect escape codes.
 *
 * `report` takes the events `lib/` emits, so it can be handed straight to any
 * of them as `onProgress`:
 *   { phase: "scan", dir, found }               walking, no total known yet
 *   { phase: "work", done, total, dir, name }   countable, draws the bar
 *   { phase: "log", message, level }            a line that outlives the bar
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

    // The walk has no total to count towards, so it reports what it has found
    // so far and where it is instead of a bar.
    if (event.phase === "scan") {
      const found = event.found ? ` ${event.found} found` : "";
      const where = event.dir ? `  ${event.dir}` : "";
      return truncate(`${label} ${chalk.dim(`scanning...${found}${where}`)}`, width);
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

  /**
   * Prints a line that outlives the bar. The bar is erased first - otherwise
   * the message lands appended to a half-drawn bar - and redrawn underneath.
   * Unlike the bar itself this prints without a TTY, since these are the
   * failures and notices a piped run still needs to see.
   */
  function logLine(message, level) {
    const text =
      level === "error" ? chalk.red(message) : level === "warn" ? chalk.yellow(message) : chalk.dim(message);
    if (tty) write(CLEAR_LINE);
    write(text + "\n");
    draw(true);
  }

  return {
    /**
     * Feed a progress event. Safe to call at any rate, and never throws, so a
     * caller can hand this straight to a `lib/` function as `onProgress`.
     */
    report(event) {
      try {
        if (!event) return;
        if (event.phase === "log") return logLine(event.message, event.level);
        current = event;
        // Phase changes and the final tick must land however fast they arrive.
        draw(event.phase === "scan" || (event.total > 0 && event.done >= event.total));
      } catch {
        // drawing is decoration; never let it break the work being reported on
      }
    },
    /** Print a line above the bar, keeping the bar on screen below it. */
    log(message, level) {
      logLine(message, level);
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

/**
 * The `{ dir, name }` half of a "work" event for a file: its folder relative to
 * `root`, forward-slashed the way the bar shows it. Saves every caller looping
 * over files from rebuilding the same two lines.
 */
export function locationOf(file, root) {
  const rel = path.relative(root, path.dirname(file));
  return {
    dir: rel && rel !== "." ? rel.split(path.sep).join("/") : "",
    name: path.basename(file),
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
