# Architecture

For working on the code. Nothing here is needed to use the tool.

```bash
git clone https://github.com/msareen/voice-notes-organizer.git
cd voice-notes-organizer
npm install
npm link              # `vno` now runs your working copy from anywhere
node bin/vno.js       # or just run it directly, without linking
```

## Layout

```
bin/vno.js           command definitions and argument parsing (commander)
src/
  cli/               one module per command, plus the terminal prompt helpers
    import.js  transcribe.js  cleanup.js  visualize.js  settings.js
    setup.js   prompt.js  searchableCheckbox.js  progress.js
  lib/               domain logic and OS access, shared by the CLI and the UI
    config.js  notes.js  sync.js  media.js  vtt.js
    volumes.js  whisper.js  whispercpp.js  setup.js  open.js  ledger.js
  web/               the browser UI behind `vno visualize`
    server/          HTTP server: session token, JSON API, SSE job stream
      index.js       bootstraps http.Server, builds ctx, dispatches routes
      context.js     the shared ctx: notes/config/job state + helpers
      assets.js  media.js  events.js
      routes/        one module per route group (state, settings, notes,
                      transcribe, import, cleanup)
    page.js          the HTML shell, and nothing else
    assets/          app.css and app.js (the client entry), plus:
      js/            state.js  dom.js  api.js  format.js  widgets.js
                      list.js  deck.js  jobs.js  actions.js  deps.js  models.js
                      divider.js  dragdrop.js
      js/panels/     settings.js  import.js  transcribe.js  cleanup.js
```

**Dependencies run one way:** `bin/` → `cli/` → `lib/`, with `web/` reaching
into `lib/` alongside `cli/`. Nothing in `lib/` imports from `cli/` or `web/`,
so anything there is safe to reuse from either side.

| Module | Responsibility |
| --- | --- |
| `lib/config.js` | Load / save `~/.vno/config.json`, defaults, corrupt-file recovery |
| `lib/volumes.js` | Per-OS removable-volume detection |
| `lib/sync.js` | Audio file discovery, the flat copy, self-healing old nested imports — reports progress rather than printing it, so the terminal and the page can each render it their own way |
| `lib/whisper.js` | Resolving the installed whisper.cpp binary/model and running a transcription (ffmpeg pre-conversion to WAV, spawning the binary, accel-state helpers) |
| `lib/whispercpp.js` | Installing whisper.cpp itself: `install.json`, per-platform binary acquisition (Homebrew, GitHub release zip, `cmake` source build), model resolution/download/validation |
| `lib/setup.js` | Finding ffmpeg on PATH, per-OS install recipes, running them, re-reading PATH |
| `lib/media.js` | ffprobe durations, filename date parsing, formatting |
| `lib/vtt.js` | Parse and serialize WebVTT cues |
| `lib/notes.js` | Builds the note model both the CLI and the page render from, reporting progress through an optional callback |
| `cli/progress.js` | The terminal progress bar every slow per-file loop draws through |
| `lib/open.js` | Opening a folder / revealing a file, per OS — behind `vno explore`, the UI's Explore button and `/api/reveal` alike |
| `lib/ledger.js` | `~/.vno/deleted.json`: what was deleted, so import won't re-copy it |

## There is no build step

`assets/app.css`, `assets/app.js` and every module under `assets/js/` are read
from disk on **each request**, so a browser reload is enough to see a UI edit
— no restart. Changes to anything in `web/server/` or `lib/` do need a
restart.

The client is plain ES5-flavoured JavaScript loaded as native ES modules
(`<script type="module">`) — no bundler, no framework and no dependencies,
just the browser resolving `import`/`export` directly off disk. Keep it that
way: a new client file just needs an `import` from whichever module uses it,
and `server/assets.js` serves anything under `assets/` by extension, so no
server change is needed either.

The session token is the one thing not in the assets: `page.js` inlines it into
the HTML, so it never travels in an asset URL — which is also why the two asset
routes sit *ahead* of the token gate.

## The local HTTP API

Everything below `/api` requires the session token, supplied as an
`X-VNO-Token` header, a `?t=` query parameter, or a `token` field in the JSON
body (`sendBeacon` can't set headers). Cross-origin requests are refused
outright. See the [UI's security model](ui.md#security-model).

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | The page. Token required as `?t=` |
| `/assets/*` | GET | Static assets (app.css, app.js, assets/js/**). **Not** token-gated, by design |
| `/media/<rel>` | GET | Streams audio, with range-request support |
| `/api/state` | GET | Notes, config, model list, `ffmpeg`/whisper.cpp availability, current job |
| `/api/events` | GET | SSE stream: `job` and `notes` events |
| `/api/ping` | POST | Liveness |
| `/api/bye` | POST | Tab closed (deferred shutdown) or Quit (`{quit:true}`, immediate) |
| `/api/settings` | POST | Patch `autoTranslate`, `defaultModel`, `transcribeLanguage`, `openWhenDone`, `rememberDeletions`, `useGpu` |
| `/api/sources` | POST | Replace `config.sources` wholesale (array-shaped, doesn't fit the scalar `/api/settings` patch) |
| `/api/sources/explore` | POST | Open the folder a source's files currently land in (or will, on next sync) — `mapTo` when set, else `target/<sanitized source basename>/`. Used by the source-removal confirmation dialog |
| `/api/reveal` | POST | Reveal a file, or open a folder |
| `/api/transcript` | PUT | Save an edited transcript (cues or plain text) |
| `/api/notes/delete` | POST | Delete a recording and its sidecars |
| `/api/notes/refresh` | POST | Recheck one note against disk (bypasses the duration cache) |
| `/api/transcribe` | POST | Start a transcription job |
| `/api/volumes` | GET | Detected volumes plus configured sources |
| `/api/browse` | GET | List subfolders of a volume, one level |
| `/api/browse-target` | GET | List subfolders of the target folder, one level — confined to `target`, powers the per-source "Folder in target" (`mapTo`) picker |
| `/api/browse-fs` | GET | List subfolders of any filesystem path, one level (drives/root with no `path`) — powers the source-folder picker, since it isn't confined to a volume |
| `/api/import` | POST | Start an import job |
| `/api/upload` | POST | Drag-and-drop: stream one raw audio file to `Dropped/`. Not a job — token comes off the query string, since it's not a JSON body |
| `/api/cleanup/scan` | GET | Recordings under a duration threshold |
| `/api/cleanup` | POST | Delete the selected ones |

Paths in the API are always **target-relative with forward slashes** (`rel`
doubles as a note's id). The server resolves each one back against the target
folder and rejects anything that escapes it.

## Design notes worth knowing before you change things

- **Notes are cached, twice.** The in-memory model is rebuilt only when
  something actually changes it, then broadcast over SSE. Within a rebuild,
  the slow part (an ffprobe per file for duration) is itself cached on disk
  keyed by size+mtime (`lib/notesCache.js`), so only new or changed files pay
  for it. Selecting a note in the browser triggers `POST /api/notes/refresh`,
  a one-file recheck that bypasses the cache, so a file changed outside vno
  doesn't show stale data until the next full rebuild.
- **One job at a time.** A second start returns `409 Busy`. Jobs stream their
  output line by line to the page's log panel; the last 200 lines are kept.
- **Dependency probing never runs the thing it's checking for.** `lib/setup.js`
  scans `PATH` for ffmpeg (honouring `PATHEXT`, and `lstat` so Windows App
  Execution Aliases resolve); `lib/whispercpp.js:resolveBinary` checks the
  vendored `whisper-cpp/bin/` in both install roots, then PATH. Both are
  directory scans, not executions, which is what makes the check affordable
  at the start of every command and on every `/api/state`, with nothing to
  memoise or invalidate — an install done in another terminal shows up on the
  next refresh. It's also the same resolution `spawn` will do, so it predicts
  the real outcome.
- **`lib/setup.js` decides, `cli/setup.js` asks.** Detection and install
  recipes are pure lib code; every prompt and every "shall I run this?" lives
  in the CLI module, which is what keeps the browser path able to use the
  detection half. The page can't install anything, so it reports and points at
  `vno setup`.
- **Shutdown is deferred, not immediate.** The open SSE stream is the reliable
  "a tab is watching" signal (unlike a heartbeat it isn't throttled in a
  background tab). Losing it schedules a shutdown a few seconds out, so a
  reload doesn't end the session, and a running job is allowed to finish. A
  two-minute watchdog catches wedged connections.
- **Timed transcript saves never touch timings.** The editor sends text only;
  the server re-reads the cues off disk and merges. A cue-count mismatch means
  the file changed underneath, and the save is refused with a `409`.
- **Imports are idempotent** by name + size. See
  [Import & sync](import-and-sync.md#re-running-is-safe).
- **Deletion is confined** to `cleanup`, the UI's cleanup, and per-take delete
  for files inside `target`. Those three are also the only writers to the
  deletion ledger, which is why they're the only deletions import can know
  about. There is one other, narrower exception: a manually configured
  `sources` entry with `deleteAfterImport: true` deletes its own
  already-imported files, but only from the source folder itself, only at
  import time, and it never touches the ledger (it only reads
  `loadDeletionMatcher` to avoid deleting a source file whose imported copy
  was deliberately removed from `target`). See
  [Import & sync → Source folders](import-and-sync.md#source-folders).
- **The ledger must never be load-bearing.** `lib/ledger.js` swallows its own
  read *and* write failures: missing, corrupt and unreadable all resolve to
  "nothing is remembered", and a failed write can't turn a successful delete
  into an error. Suppression is folded into `resolveFlatDest` so it reuses the
  existing name+size key rather than inventing a second notion of sameness.

---

[← Back to the docs index](README.md) · [The browser UI](ui.md) · [CLI reference](cli-reference.md)
