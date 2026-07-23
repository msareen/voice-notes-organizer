import fs from "fs-extra";
import path from "node:path";
import chalk from "chalk";
import { loadConfig } from "./config.js";
import { findAudioFiles } from "./sync.js";
import { parseCues } from "./vtt.js";

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

/** Builds the per-note data model the generated page renders from. */
async function buildNotes(target) {
  const audioFiles = (await findAudioFiles(target)).sort((a, b) =>
    a.localeCompare(b)
  );

  const notes = [];
  for (const audioPath of audioFiles) {
    const rel = path.relative(target, audioPath);
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

    notes.push({
      title: rel.split(path.sep).join(" / "),
      src: toRelUrl(rel),
      cues, // [] when there's no timed transcript
      text, // shown when there are no cues
      hasTranscript: Boolean(transcript),
    });
  }
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

  const folderName = escapeHtml(path.basename(target) || "voice notes");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Voice notes — ${folderName}</title>
<style>
:root {
  --bg: #f7f7f8; --panel: #ffffff; --border: #e3e3e8; --text: #1b1b1f;
  --muted: #6b6b76; --accent: #3b6cff; --accent-soft: #e8effe; --shadow: rgba(0,0,0,.06);
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17171a; --panel: #1f1f24; --border: #303038; --text: #ececf1;
    --muted: #9a9aa6; --accent: #6f92ff; --accent-soft: #24304f; --shadow: rgba(0,0,0,.35);
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
}
header {
  padding: 24px clamp(16px, 5vw, 48px) 8px; max-width: 900px; margin: 0 auto;
}
h1 { margin: 0 0 4px; font-size: 1.4rem; }
.sub { color: var(--muted); font-size: .85rem; }
.filter {
  margin: 16px auto 0; max-width: 900px; padding: 0 clamp(16px, 5vw, 48px);
}
.filter input {
  width: 100%; padding: 10px 12px; border: 1px solid var(--border);
  border-radius: 10px; background: var(--panel); color: var(--text); font-size: .95rem;
}
main { max-width: 900px; margin: 0 auto; padding: 8px clamp(16px, 5vw, 48px) 64px; }
.note {
  background: var(--panel); border: 1px solid var(--border); border-radius: 14px;
  padding: 16px; margin: 16px 0; box-shadow: 0 1px 3px var(--shadow);
}
.note h2 {
  margin: 0 0 10px; font-size: .98rem; font-weight: 600; word-break: break-word;
}
audio { width: 100%; margin-bottom: 12px; }
.transcript {
  max-height: 260px; overflow-y: auto; border-top: 1px solid var(--border);
  padding-top: 10px; font-size: .95rem;
}
.cue {
  display: block; padding: 3px 6px; margin: 1px 0; border-radius: 6px;
  cursor: pointer; color: var(--muted); transition: background .1s, color .1s;
}
.cue:hover { background: var(--accent-soft); }
.cue.active { background: var(--accent-soft); color: var(--text); font-weight: 600; }
.plain { white-space: pre-wrap; color: var(--text); }
.empty { color: var(--muted); font-style: italic; }
.count { color: var(--muted); font-size: .8rem; }
.hidden { display: none; }
footer { text-align: center; color: var(--muted); font-size: .78rem; padding: 24px; }
</style>
</head>
<body>
<header>
  <h1>Voice notes</h1>
  <div class="sub">${folderName} — <span id="shown"></span></div>
</header>
<div class="filter"><input id="q" type="search" placeholder="Filter by name or transcript text…" aria-label="Filter notes" /></div>
<main id="list"></main>
<footer>Generated by voice-note-organizer · click a line to jump the audio to it</footer>

<script id="data" type="application/json">${data}</script>
<script>
(function () {
  const NOTES = JSON.parse(document.getElementById("data").textContent);
  const list = document.getElementById("list");
  const shown = document.getElementById("shown");
  const q = document.getElementById("q");

  function fmt(t) {
    t = Math.max(0, t | 0);
    const m = (t / 60) | 0, s = t % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  const cards = NOTES.map((note, i) => {
    const card = document.createElement("section");
    card.className = "note";

    const h = document.createElement("h2");
    h.textContent = note.title;
    card.appendChild(h);

    const audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "none";
    audio.src = note.src;
    card.appendChild(audio);

    const transcript = document.createElement("div");
    transcript.className = "transcript";
    let cueEls = [];

    if (note.cues && note.cues.length) {
      note.cues.forEach((cue) => {
        const el = document.createElement("span");
        el.className = "cue";
        el.textContent = "[" + fmt(cue.start) + "] " + cue.text;
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
        if (idx >= 0) {
          const el = cueEls[idx];
          el.classList.add("active");
          el.scrollIntoView({ block: "nearest" });
        }
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
    card.appendChild(transcript);

    // Precomputed haystack for the filter box.
    card._haystack = (note.title + " " + (note.text || "")).toLowerCase();
    list.appendChild(card);
    return card;
  });

  function applyFilter() {
    const term = q.value.trim().toLowerCase();
    let visible = 0;
    cards.forEach((card) => {
      const match = !term || card._haystack.indexOf(term) !== -1;
      card.classList.toggle("hidden", !match);
      if (match) visible++;
    });
    shown.textContent = visible + " of " + cards.length + " note" + (cards.length === 1 ? "" : "s");
  }
  q.addEventListener("input", applyFilter);
  applyFilter();
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
