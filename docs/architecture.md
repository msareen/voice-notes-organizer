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
    volumes.js  whisper.js  setup.js  open.js  ledger.js
  web/               the browser UI behind `vno visualize`
    server.js        HTTP server: session token, JSON API, SSE job stream
    page.js          the HTML shell, and nothing else
    assets/          app.css and app.js, served as plain static files
```

**Dependencies run one way:** `bin/` → `cli/` → `lib/`, with `web/` reaching
into `lib/` alongside `cli/`. Nothing in `lib/` imports from `cli/` or `web/`,
so anything there is safe to reuse from either side.

| Module | Responsibility |
| --- | --- |
| `lib/config.js` | Load / save `~/.vno/config.json`, defaults, corrupt-file recovery |
| `lib/volumes.js` | Per-OS removable-volume detection |
| `lib/sync.js` | Audio file discovery, the flat copy, self-healing old nested imports |
| `lib/whisper.js` | Probing for whisper and running a transcription |
| `lib/setup.js` | Finding ffmpeg/whisper/pip on PATH, per-OS install recipes, running them, re-reading PATH |
| `lib/media.js` | ffprobe durations, filename date parsing, formatting |
| `lib/vtt.js` | Parse and serialize WebVTT cues |
| `lib/notes.js` | Builds the note model both the CLI and the page render from, reporting progress through an optional callback |
| `cli/progress.js` | The terminal progress bar `visualize` draws while that model is being built |
| `lib/open.js` | Opening a folder / revealing a file, per OS |
| `lib/ledger.js` | `~/.vno/deleted.json`: what was deleted, so import won't re-copy it |

## There is no build step

`assets/app.css` and `assets/app.js` are read from disk on **each request**, so
a browser reload is enough to see a UI edit — no restart. Changes to
`server.js` or anything in `lib/` do need a restart.

The client script is plain ES5-flavoured JavaScript with no bundler, no
framework and no dependencies. Keep it that way.

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
| `/assets/{app.css,app.js}` | GET | Static assets. **Not** token-gated, by design |
| `/media/<rel>` | GET | Streams audio, with range-request support |
| `/api/state` | GET | Notes, config, model list, `ffmpeg`/`whisper` availability, current job |
| `/api/events` | GET | SSE stream: `job` and `notes` events |
| `/api/ping` | POST | Liveness |
| `/api/bye` | POST | Tab closed (deferred shutdown) or Quit (`{quit:true}`, immediate) |
| `/api/settings` | POST | Patch `autoTranslate`, `defaultModel`, `openWhenDone` |
| `/api/reveal` | POST | Reveal a file, or open a folder |
| `/api/transcript` | PUT | Save an edited transcript (cues or plain text) |
| `/api/notes/delete` | POST | Delete a recording and its sidecars |
| `/api/transcribe` | POST | Start a transcription job |
| `/api/volumes` | GET | Detected volumes plus configured sources |
| `/api/browse` | GET | List subfolders of a volume, one level |
| `/api/import` | POST | Start an import job |
| `/api/cleanup/scan` | GET | Recordings under a duration threshold |
| `/api/cleanup` | POST | Delete the selected ones |

Paths in the API are always **target-relative with forward slashes** (`rel`
doubles as a note's id). The server resolves each one back against the target
folder and rejects anything that escapes it.

## Design notes worth knowing before you change things

- **Notes are cached.** Building the model costs an ffprobe per file, so it's
  rebuilt only when something actually changes it, then broadcast over SSE.
- **One job at a time.** A second start returns `409 Busy`. Jobs stream their
  output line by line to the page's log panel; the last 200 lines are kept.
- **Dependency probing is a PATH lookup, never an execution.** `lib/setup.js`
  scans `PATH` (honouring `PATHEXT`, and `lstat` so Windows App Execution
  Aliases resolve) instead of running `whisper --help`, which boots Python and
  torch and costs whole seconds. That's what makes the check affordable at the
  start of every command and on every `/api/state`, with nothing to memoise or
  invalidate — an install done in another terminal shows up on the next
  refresh. It's also the same resolution `spawn` will do, so it predicts the
  real outcome.
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
- **Deletion is confined** to `cleanup`, the UI's cleanup, and per-take delete.
  Nothing else in the codebase removes a user file — keep it that way. Those
  three are also the only writers to the deletion ledger, which is why they're
  the only deletions import can know about.
- **The ledger must never be load-bearing.** `lib/ledger.js` swallows its own
  read *and* write failures: missing, corrupt and unreadable all resolve to
  "nothing is remembered", and a failed write can't turn a successful delete
  into an error. Suppression is folded into `resolveFlatDest` so it reuses the
  existing name+size key rather than inventing a second notion of sameness.

---

[← Back to the docs index](README.md) · [The browser UI](ui.md) · [CLI reference](cli-reference.md)
