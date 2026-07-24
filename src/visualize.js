import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { findAudioFiles } from "./sync.js";
import { parseCues } from "./vtt.js";
import { getDurationSeconds, recordedDate } from "./media.js";

export const INDEX_FILE = "index.html";

// Preference order for a note's transcript: timed formats first (they unlock
// the follow-along highlight), plain text last (shown, but not highlighted).
const TRANSCRIPT_EXTS = [".vtt", ".srt", ".txt"];

const stripExt = (p) => p.slice(0, -path.extname(p).length);

/** Turns a filesystem-relative path into a relative URL usable in href/src. */
function toRelUrl(relPath) {
  return relPath
    .split(path.sep)
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function findTranscript(audioPath) {
  const base = stripExt(audioPath);
  for (const ext of TRANSCRIPT_EXTS) {
    const candidate = base + ext;
    if (await fs.pathExists(candidate)) return { path: candidate, ext };
  }
  return null;
}

const pad2 = (n) => String(n).padStart(2, "0");

/** Builds the per-note data model the generated page renders from. */
async function buildNotes(target) {
  const audioFiles = await findAudioFiles(target);

  const notes = [];
  for (const audioPath of audioFiles) {
    const rel = path.relative(target, audioPath);
    const dirRaw = path.dirname(rel);
    // Folder the note lives in, relative to target, normalised to forward
    // slashes ("" for files sitting directly in the target root).
    const dir = dirRaw === "." ? "" : dirRaw.split(path.sep).join("/");
    const transcript = await findTranscript(audioPath);

    let cues = [];
    let text = "";
    if (transcript) {
      const raw = await fs.readFile(transcript.path, "utf8");
      if (transcript.ext === ".txt") {
        text = raw.trim();
      } else {
        cues = parseCues(raw);
        text = cues.map((c) => c.text).join("\n");
      }
    }

    let size = null;
    try {
      size = (await fs.stat(audioPath)).size;
    } catch {
      // size stays null; the page shows a dash
    }

    // Recording date/time is pre-formatted here (it comes from the recorder's
    // wall-clock filename) so the browser doesn't shift it by time zone.
    const date = await recordedDate(audioPath);
    const durationSec = await getDurationSeconds(audioPath);

    notes.push({
      title: rel.split(path.sep).join(" / "),
      dir, // folder for sidebar grouping ("" = target root)
      name: path.basename(audioPath),
      src: toRelUrl(rel),
      cues, // [] when there's no timed transcript
      text, // shown when there are no cues
      hasTranscript: Boolean(transcript),
      size, // bytes, or null
      durationSec, // seconds, or null
      dateMs: date ? date.getTime() : null, // for sorting only
      dateStr: date ? `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}` : "",
      timeStr: date ? `${pad2(date.getHours())}:${pad2(date.getMinutes())}` : "",
    });
  }

  // Newest recording first; files with no determinable date sort to the end.
  notes.sort((a, b) => (b.dateMs ?? -Infinity) - (a.dateMs ?? -Infinity));
  return notes;
}

export async function runVisualize({ quiet = false, open = false } = {}) {
  const config = await loadConfig();

  if (!(await fs.pathExists(config.target))) {
    if (!quiet) {
      console.log(chalk.yellow(`Target folder does not exist yet: ${config.target}`));
      console.log(chalk.dim("Run the import command first to sync some voice notes."));
    }
    return null;
  }

  const notes = await buildNotes(config.target);

  if (notes.length === 0) {
    if (!quiet) console.log(chalk.dim("No audio files found - nothing to visualize."));
    return null;
  }

  const html = renderHtml(notes, config.target);
  const outPath = path.join(config.target, INDEX_FILE);
  await fs.writeFile(outPath, html, "utf8");

  const withTiming = notes.filter((n) => n.cues.length > 0).length;
  if (quiet) {
    console.log(chalk.dim(`Updated ${INDEX_FILE} (${notes.length} note(s)).`));
  } else {
    console.log(chalk.green(`Wrote ${outPath}`));
    console.log(
      chalk.dim(
        `${notes.length} note(s), ${withTiming} with follow-along timing. Open it in a browser to listen.`
      )
    );
  }

  if (open) await openInBrowser(outPath);
  return outPath;
}

async function openInBrowser(filePath) {
  const { spawn } = await import("node:child_process");
  const opener =
    process.platform === "win32"
      ? { cmd: "cmd", args: ["/c", "start", "", filePath] }
      : process.platform === "darwin"
        ? { cmd: "open", args: [filePath] }
        : { cmd: "xdg-open", args: [filePath] };
  try {
    spawn(opener.cmd, opener.args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch {
    // best-effort; the path was already printed for the user to open manually
  }
}

/* --------------------------------------------------------------------------
 * HTML generation. The page is fully self-contained (inline CSS + JS); audio
 * and transcript data are embedded, and audio is referenced by relative URL
 * so it streams from disk rather than bloating the file.
 * ------------------------------------------------------------------------ */

function renderHtml(notes, target) {
  const data = JSON.stringify(notes)
    // Keep the embedded JSON from prematurely closing the <script> and from
    // being mangled by an HTML parser.
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");

  const rootLabel = path.basename(target) || "voice notes";
  const folderName = escapeHtml(rootLabel);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Voice Notes · ${folderName}</title>
<style>
:root {
  --bg: #141110; --panel: #1b1613; --panel-2: #221b16; --line: #332a20;
  --ink: #f4ede1; --dim: #a2917c; --faint: #6f6154;
  --amber: #ff9e3d; --amber-soft: rgba(255,158,61,.13); --amber-line: rgba(255,158,61,.42);
  --rec: #ff5252; --signal: #69c97e;
  --mono: ui-monospace, "Cascadia Mono", "Segoe UI Mono", "SF Mono", Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 15px/1.55 var(--sans); -webkit-font-smoothing: antialiased;
}
::selection { background: var(--amber); color: #1a1200; }
.shell { display: flex; flex-direction: column; height: 100vh; }

/* ---- Top console bar ---- */
.topbar {
  flex: none; display: flex; align-items: center; gap: 14px;
  padding: 13px clamp(16px, 4vw, 36px);
  background: linear-gradient(180deg, #201a15, #1b1613);
  border-bottom: 1px solid var(--line);
}
.rec {
  width: 9px; height: 9px; border-radius: 50%; background: var(--rec); flex: none;
  box-shadow: 0 0 8px rgba(255,82,82,.7); animation: rec 1.8s ease-in-out infinite;
}
.wordmark {
  font-family: var(--mono); font-weight: 600; font-size: .9rem;
  letter-spacing: .28em; text-transform: uppercase; color: var(--ink);
}
.folder {
  font-family: var(--mono); font-size: .72rem; color: var(--dim);
  border: 1px solid var(--line); border-radius: 5px; padding: 3px 8px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 38vw;
}
.spacer { flex: 1 1 auto; }
.readout { display: flex; gap: 22px; font-family: var(--mono); }
.readout .stat { text-align: right; line-height: 1.15; }
.readout .stat b { display: block; font-size: .95rem; font-weight: 600; color: var(--amber); }
.readout .stat span {
  font-size: .58rem; letter-spacing: .18em; text-transform: uppercase; color: var(--faint);
}

.app { display: flex; flex: 1 1 auto; min-height: 0; overflow: hidden; }

/* ---- Left pane: takes list ---- */
.sidebar {
  width: clamp(300px, 32vw, 420px); flex: none; display: flex; flex-direction: column;
  border-right: 1px solid var(--line); background: var(--panel); min-height: 0;
}
.side-head { padding: 14px 16px; border-bottom: 1px solid var(--line); }
.side-label {
  font-family: var(--mono); font-size: .62rem; letter-spacing: .2em;
  text-transform: uppercase; color: var(--faint); margin: 0 0 9px;
}
.side-head input {
  width: 100%; padding: 9px 12px; border: 1px solid var(--line); border-radius: 7px;
  background: var(--bg); color: var(--ink); font: .82rem var(--mono);
  outline: none; transition: border-color .12s, box-shadow .12s;
}
.side-head input::placeholder { color: var(--faint); }
.side-head input:focus { border-color: var(--amber-line); box-shadow: 0 0 0 3px var(--amber-soft); }
.filelist { flex: 1 1 auto; overflow-y: auto; min-height: 0; }

/* Draggable divider between the takes list and the deck */
.divider {
  flex: none; width: 7px; cursor: col-resize; background: transparent;
  position: relative; z-index: 2;
}
.divider::after {
  content: ""; position: absolute; top: 0; bottom: 0; left: 50%; width: 1px;
  transform: translateX(-50%); background: var(--line); transition: background .12s, width .12s;
}
.divider:hover::after, .divider.dragging::after,
.divider:focus-visible::after { background: var(--amber); width: 2px; }
.divider:focus-visible { outline: none; }
body.resizing { cursor: col-resize; user-select: none; }

.row {
  display: grid; grid-template-columns: 10px 1fr auto; align-items: center; gap: 12px;
  padding: 11px 15px 11px 12px; border-bottom: 1px solid var(--line); cursor: pointer;
  border-left: 2px solid transparent; transition: background .1s;
}
.row:hover { background: var(--panel-2); }
.row:focus-visible { outline: none; background: var(--panel-2); border-left-color: var(--amber-line); }
.row.active { background: var(--panel-2); border-left-color: var(--amber); }
.led { width: 8px; height: 8px; border-radius: 50%; background: transparent; border: 1.5px solid var(--faint); }
.led.on { background: var(--signal); border-color: var(--signal); box-shadow: 0 0 6px rgba(105,201,126,.55); }
.row-main { min-width: 0; }
.row-name {
  font-size: .88rem; font-weight: 600; color: var(--ink);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row.active .row-name { color: var(--amber); }
.row-sub {
  font-family: var(--mono); font-size: .7rem; color: var(--dim); margin-top: 3px;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row-right { text-align: right; font-family: var(--mono); line-height: 1.25; }
.row-dur { font-size: .8rem; color: var(--ink); }
.row-size { font-size: .64rem; color: var(--faint); }

/* ---- Folder group headers (collapsible) ---- */
.group-head {
  display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
  padding: 9px 15px 9px 11px; background: var(--panel-2);
  border: none; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line);
  color: var(--dim); font-family: var(--mono); font-size: .68rem;
  letter-spacing: .1em; text-transform: uppercase; cursor: pointer;
  position: sticky; top: 0; z-index: 1;
}
.group-head:hover { color: var(--ink); }
.group-head:focus-visible { outline: none; color: var(--amber); }
.group-head .chev { flex: none; color: var(--faint); transition: transform .12s; }
.group-head.collapsed .chev { transform: rotate(-90deg); }
.group-head .g-name { flex: 1 1 auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.group-head .g-count {
  flex: none; color: var(--faint); font-size: .62rem;
  border: 1px solid var(--line); border-radius: 4px; padding: 1px 6px;
}
.group-body.collapsed { display: none; }

/* ---- Right pane: playback deck ---- */
.detail { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; }
.placeholder { margin: auto; text-align: center; color: var(--dim); padding: 32px; }
.placeholder .big {
  font-family: var(--mono); font-size: .7rem; letter-spacing: .2em;
  text-transform: uppercase; color: var(--faint);
}
.detail-body {
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  padding: 22px clamp(16px, 4vw, 44px);
}
.eyebrow {
  display: flex; align-items: center; font-family: var(--mono); font-size: .64rem;
  letter-spacing: .22em; text-transform: uppercase; color: var(--amber); margin: 0 0 12px;
}
.eq { display: inline-flex; align-items: flex-end; gap: 2px; height: 11px; margin-left: 10px; }
.eq i {
  width: 2px; height: 100%; background: var(--amber); border-radius: 1px;
  transform-origin: bottom; transform: scaleY(.28);
  animation: eq 1s ease-in-out infinite; animation-play-state: paused;
}
.playing .eq i { animation-play-state: running; }
.eq i:nth-child(2) { animation-delay: .18s; }
.eq i:nth-child(3) { animation-delay: .36s; }
.eq i:nth-child(4) { animation-delay: .09s; }
.eq i:nth-child(5) { animation-delay: .27s; }
.deck-title { font-size: 1.35rem; font-weight: 700; letter-spacing: -.01em; margin: 0; word-break: break-word; }
.deck-path { font-family: var(--mono); font-size: .72rem; color: var(--dim); margin: 4px 0 0; word-break: break-all; }
.readout-line { display: flex; flex-wrap: wrap; gap: 6px 8px; margin: 14px 0 16px; }
.chip {
  font-family: var(--mono); font-size: .7rem; color: var(--dim);
  background: var(--bg); border: 1px solid var(--line); border-radius: 5px; padding: 3px 9px;
}
.chip b { color: var(--amber); font-weight: 600; }
.detail audio { width: 100%; margin-bottom: 16px; }
.transcript {
  flex: 1 1 auto; overflow-y: auto; min-height: 0; border-top: 1px solid var(--line);
  padding-top: 12px; font-size: .95rem;
}
.cue {
  display: grid; grid-template-columns: 52px 1fr; gap: 10px; padding: 4px 8px; margin: 1px 0;
  border-radius: 6px; cursor: pointer; color: var(--dim); transition: background .1s, color .1s;
}
.cue .t { font-family: var(--mono); font-size: .72rem; color: var(--faint); padding-top: 2px; }
.cue:hover { background: var(--panel-2); }
.cue.active { background: var(--amber-soft); color: var(--ink); }
.cue.active .t { color: var(--amber); }
.plain { white-space: pre-wrap; color: var(--ink); }
.empty { color: var(--dim); font-style: italic; }
.hidden { display: none !important; }

@keyframes rec { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
@keyframes eq { 0%, 100% { transform: scaleY(.22); } 50% { transform: scaleY(1); } }
@media (prefers-reduced-motion: reduce) {
  .rec { animation: none; }
  .eq i { animation: none; transform: scaleY(.6); }
}
@media (max-width: 720px) {
  .app { flex-direction: column; }
  .sidebar { width: 100% !important; height: 44vh; border-right: none; border-bottom: 1px solid var(--line); }
  .detail { height: 56vh; }
  .divider { display: none; }
  .readout { display: none; }
}
</style>
</head>
<body>
<div class="shell">
  <header class="topbar">
    <span class="rec" aria-hidden="true"></span>
    <span class="wordmark">Voice Notes</span>
    <span class="folder">${folderName}</span>
    <span class="spacer"></span>
    <div class="readout">
      <div class="stat"><b id="statTakes">—</b><span>Takes</span></div>
      <div class="stat"><b id="statTotal">—</b><span>Total</span></div>
    </div>
  </header>
  <div class="app">
    <aside class="sidebar">
      <div class="side-head">
        <p class="side-label"><span id="shown"></span></p>
        <input id="q" type="search" placeholder="filter takes…" aria-label="Filter takes" />
      </div>
      <div class="filelist" id="list" role="listbox" aria-label="Takes"></div>
    </aside>
    <div class="divider" id="divider" role="separator" aria-orientation="vertical"
         tabindex="0" aria-label="Resize the takes list" title="Drag to resize"></div>
    <main class="detail" id="detail">
      <div class="placeholder" id="placeholder"><div class="big">Select a take to play</div></div>
      <div class="detail-body hidden" id="detailBody"></div>
    </main>
  </div>
</div>

<script id="data" type="application/json">${data}</script>
<script>
(function () {
  const NOTES = JSON.parse(document.getElementById("data").textContent);
  const FOLDER_ROOT = ${JSON.stringify(rootLabel)};
  const list = document.getElementById("list");
  const shown = document.getElementById("shown");
  const q = document.getElementById("q");
  const placeholder = document.getElementById("placeholder");
  const body = document.getElementById("detailBody");
  const detail = document.getElementById("detail");
  const sidebar = document.querySelector(".sidebar");
  const divider = document.getElementById("divider");

  // ---- Draggable divider: resize the takes list ----
  (function () {
    const MIN = 240, MAX_FRAC = 0.7, STEP = 24, KEY = "vno-sidebar-w";
    function setWidth(px) {
      const max = Math.max(MIN, window.innerWidth * MAX_FRAC);
      px = Math.max(MIN, Math.min(max, px));
      sidebar.style.width = px + "px";
      try { localStorage.setItem(KEY, String(px)); } catch (e) {}
    }
    const saved = (() => { try { return parseFloat(localStorage.getItem(KEY)); } catch (e) { return NaN; } })();
    if (saved > 0) setWidth(saved);

    let dragging = false;
    divider.addEventListener("pointerdown", (e) => {
      dragging = true;
      divider.classList.add("dragging");
      document.body.classList.add("resizing");
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    divider.addEventListener("pointermove", (e) => {
      if (!dragging) return;
      setWidth(e.clientX - sidebar.getBoundingClientRect().left);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove("dragging");
      document.body.classList.remove("resizing");
      try { divider.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    divider.addEventListener("pointerup", endDrag);
    divider.addEventListener("pointercancel", endDrag);
    divider.addEventListener("keydown", (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setWidth(sidebar.getBoundingClientRect().width + (e.key === "ArrowRight" ? STEP : -STEP));
    });
    divider.addEventListener("dblclick", () => {
      sidebar.style.width = "";
      try { localStorage.removeItem(KEY); } catch (e) {}
    });
  })();

  function fmt(t) {
    t = Math.max(0, t | 0);
    const m = (t / 60) | 0, s = t % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fmtDur(sec) {
    if (sec == null) return "--";
    sec = Math.round(sec);
    const h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
    const p = (n) => (n < 10 ? "0" : "") + n;
    return h > 0 ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
  }
  function fmtSize(b) {
    if (b == null) return "--";
    const u = ["B", "KB", "MB", "GB"]; let i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
  }
  function extOf(name) {
    const d = name.lastIndexOf(".");
    return d >= 0 ? name.slice(d + 1).toUpperCase() : "AUDIO";
  }

  let selectedIndex = -1;

  // ---- Top-bar readout: total takes and combined runtime ----
  let totalSec = 0;
  NOTES.forEach((n) => { if (n.durationSec != null) totalSec += n.durationSec; });
  document.getElementById("statTakes").textContent = NOTES.length;
  document.getElementById("statTotal").textContent = fmtDur(totalSec);

  // ---- Build the left takes list, grouped by folder ----
  // Collapsed-folder state persists across visits, keyed by folder path.
  const COLLAPSE_KEY = "vno-collapsed";
  let collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (e) {}
  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (e) {}
  }

  const rows = new Array(NOTES.length);
  const groups = [];
  const groupByKey = new Map();

  // NOTES is already newest-first, so first-seen order puts the group holding
  // the newest take first, and each group's rows stay newest-first too.
  NOTES.forEach((note, i) => {
    const row = document.createElement("div");
    row.className = "row";
    row.tabIndex = 0;
    row.setAttribute("role", "option");

    const led = document.createElement("span");
    led.className = "led" + (note.hasTranscript ? " on" : "");
    led.title = note.hasTranscript ? "Transcript available" : "No transcript yet";
    row.appendChild(led);

    const main = document.createElement("div");
    main.className = "row-main";
    const name = document.createElement("div");
    name.className = "row-name";
    name.textContent = note.name;
    main.appendChild(name);
    const sub = document.createElement("div");
    sub.className = "row-sub";
    sub.textContent = note.dateStr ? note.dateStr + "  " + note.timeStr : "no date";
    main.appendChild(sub);
    row.appendChild(main);

    const right = document.createElement("div");
    right.className = "row-right";
    const dur = document.createElement("div");
    dur.className = "row-dur";
    dur.textContent = fmtDur(note.durationSec);
    const size = document.createElement("div");
    size.className = "row-size";
    size.textContent = fmtSize(note.size);
    right.appendChild(dur);
    right.appendChild(size);
    row.appendChild(right);

    row._haystack = (note.title + " " + (note.name || "") + " " + (note.text || "")).toLowerCase();
    row.addEventListener("click", () => select(i));
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(i); }
    });

    const key = note.dir || "";
    let g = groupByKey.get(key);
    if (!g) { g = { key, rows: [], header: null, body: null }; groupByKey.set(key, g); groups.push(g); }
    g.rows.push(row);
    row._group = g;
    rows[i] = row;
  });

  // With a single folder there's nothing to group under, so skip the headers
  // and render a plain flat list (the original behaviour).
  const showGroups = groups.length > 1;

  function applyCollapsed(g) {
    const c = !!collapsed[g.key];
    if (g.header) {
      g.header.classList.toggle("collapsed", c);
      g.header.setAttribute("aria-expanded", String(!c));
    }
    if (g.body) g.body.classList.toggle("collapsed", c);
  }

  groups.forEach((g) => {
    if (showGroups) {
      const header = document.createElement("button");
      header.type = "button";
      header.className = "group-head";
      const chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "▾";
      header.appendChild(chev);
      const gname = document.createElement("span");
      gname.className = "g-name";
      gname.textContent = g.key === "" ? FOLDER_ROOT : g.key;
      header.appendChild(gname);
      const gcount = document.createElement("span");
      gcount.className = "g-count";
      gcount.textContent = g.rows.length;
      header.appendChild(gcount);
      header.addEventListener("click", () => {
        collapsed[g.key] = !collapsed[g.key];
        saveCollapsed();
        applyCollapsed(g);
      });
      list.appendChild(header);
      g.header = header;
    }
    const wrap = document.createElement("div");
    wrap.className = "group-body";
    wrap.setAttribute("role", "group");
    g.rows.forEach((r) => wrap.appendChild(r));
    list.appendChild(wrap);
    g.body = wrap;
    applyCollapsed(g);
  });

  // A row counts as navigable only when it's neither filtered out nor tucked
  // inside a collapsed folder.
  function rowVisible(r) {
    return !r.classList.contains("hidden") &&
      !(r._group.body && r._group.body.classList.contains("collapsed"));
  }

  // Arrow-key navigation moves through the currently visible takes.
  list.addEventListener("keydown", (e) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const vis = rows.filter(rowVisible);
    if (!vis.length) return;
    let pos = vis.indexOf(document.activeElement);
    if (pos === -1) pos = vis.indexOf(rows[selectedIndex]);
    pos = Math.max(0, Math.min(vis.length - 1, pos + (e.key === "ArrowDown" ? 1 : -1)));
    const target = vis[pos];
    target.focus();
    select(rows.indexOf(target));
  });

  function chip(label, value) {
    const c = document.createElement("span");
    c.className = "chip";
    c.appendChild(document.createTextNode(label + " "));
    const b = document.createElement("b");
    b.textContent = value;
    c.appendChild(b);
    return c;
  }

  // ---- Render the right playback deck for a note ----
  function select(i) {
    const note = NOTES[i];
    selectedIndex = i;
    rows.forEach((r, k) => {
      const on = k === i;
      r.classList.toggle("active", on);
      r.setAttribute("aria-selected", on ? "true" : "false");
    });

    detail.classList.remove("playing");
    body.textContent = "";

    const eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.appendChild(document.createTextNode("Now Playing"));
    const eq = document.createElement("span");
    eq.className = "eq";
    for (let b = 0; b < 5; b++) eq.appendChild(document.createElement("i"));
    eyebrow.appendChild(eq);
    body.appendChild(eyebrow);

    const h = document.createElement("h2");
    h.className = "deck-title";
    h.textContent = note.name;
    body.appendChild(h);
    if (note.title && note.title !== note.name) {
      const p = document.createElement("div");
      p.className = "deck-path";
      p.textContent = note.title;
      body.appendChild(p);
    }

    const readout = document.createElement("div");
    readout.className = "readout-line";
    if (note.dateStr) readout.appendChild(chip("REC", note.dateStr + " " + note.timeStr));
    readout.appendChild(chip("LEN", fmtDur(note.durationSec)));
    readout.appendChild(chip("SIZE", fmtSize(note.size)));
    readout.appendChild(chip("FMT", extOf(note.name)));
    body.appendChild(readout);

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = note.src;
    audio.addEventListener("play", () => detail.classList.add("playing"));
    audio.addEventListener("pause", () => detail.classList.remove("playing"));
    audio.addEventListener("ended", () => detail.classList.remove("playing"));
    body.appendChild(audio);

    const transcript = document.createElement("div");
    transcript.className = "transcript";

    if (note.cues && note.cues.length) {
      const cueEls = [];
      note.cues.forEach((cue) => {
        const el = document.createElement("div");
        el.className = "cue";
        const t = document.createElement("span");
        t.className = "t";
        t.textContent = fmt(cue.start);
        const tx = document.createElement("span");
        tx.textContent = cue.text;
        el.appendChild(t);
        el.appendChild(tx);
        el.addEventListener("click", () => { audio.currentTime = cue.start; audio.play(); });
        transcript.appendChild(el);
        cueEls.push(el);
      });
      let activeIdx = -1;
      audio.addEventListener("timeupdate", () => {
        const t = audio.currentTime;
        let idx = -1;
        for (let k = 0; k < note.cues.length; k++) {
          if (t >= note.cues[k].start && t < note.cues[k].end) { idx = k; break; }
          if (t >= note.cues[k].start) idx = k; // fall back to last-started cue
        }
        if (idx === activeIdx) return;
        if (activeIdx >= 0) cueEls[activeIdx].classList.remove("active");
        activeIdx = idx;
        if (idx >= 0) { cueEls[idx].classList.add("active"); cueEls[idx].scrollIntoView({ block: "nearest" }); }
      });
    } else if (note.text) {
      const p = document.createElement("div");
      p.className = "plain";
      p.textContent = note.text;
      transcript.appendChild(p);
    } else {
      const p = document.createElement("div");
      p.className = "empty";
      p.textContent = note.hasTranscript ? "(empty transcript)" : "No transcript yet — run \\"vno transcribe\\".";
      transcript.appendChild(p);
    }
    body.appendChild(transcript);

    placeholder.classList.add("hidden");
    body.classList.remove("hidden");
  }

  // ---- Filter box ----
  function applyFilter() {
    const term = q.value.trim().toLowerCase();
    let visible = 0;
    rows.forEach((row) => {
      const match = !term || row._haystack.indexOf(term) !== -1;
      row.classList.toggle("hidden", !match);
      if (match) visible++;
    });
    // Drop headers for folders with no surviving rows; while a search is active
    // force every remaining folder open so matches aren't hidden by collapse.
    groups.forEach((g) => {
      const anyMatch = g.rows.some((r) => !r.classList.contains("hidden"));
      if (g.header) g.header.classList.toggle("hidden", !anyMatch);
      if (g.body) g.body.classList.toggle("collapsed", term ? false : !!collapsed[g.key]);
    });
    shown.textContent = visible + " / " + rows.length + " takes";
  }
  q.addEventListener("input", applyFilter);
  applyFilter();

  // Open the first take by default so the deck isn't empty.
  if (NOTES.length) select(0);
})();
</script>
</body>
</html>
`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
