# Architecture

For working on the code. Nothing here is needed to use the tool.

```bash
git clone https://github.com/msareen/voice-notes-organizer.git
cd voice-notes-organizer
bun install
bun link              # `vno` now runs your working copy from anywhere
bun bin/vno.ts        # or just run it directly, without linking
bun run typecheck     # tsc over all three projects; compiles nothing
```

## Layout

```
bin/vno.ts           command definitions and argument parsing (commander)
src/
  types.ts           the domain types every layer shares (no imports, so the
                      browser project can pull from it too)
  cli/               one module per command, plus the terminal prompt helpers
    import.ts  transcribe.ts  summarize.ts  cleanup.ts  visualize.ts  settings.ts
    setup.ts   prompt.ts  searchableCheckbox.ts  progress.ts
  lib/               domain logic and OS access, shared by the CLI and the UI
    config.ts  notes.ts  sync.ts  media.ts  vtt.ts  themes.ts
    volumes.ts  whisper.ts  whispercpp.ts  llama.ts  llamacpp.ts
    engineInstall.ts  setup.ts  open.ts  ledger.ts
    special-case-handling.ts
  web/               the browser UI behind `vno visualize`
    server/          HTTP server: session token, JSON API, SSE job stream
      index.ts       bootstraps http.Server, builds ctx, dispatches routes
      context.ts     the shared ctx: notes/config/job state + helpers
      assets.ts  media.ts  events.ts
      routes/        one module per route group (state, settings, notes,
                      transcribe, summarize, import, cleanup)
    page.ts          the HTML shell, and nothing else
    assets/          app.css and app.ts (the client entry), plus:
      js/            state.ts  dom.ts  api.ts  format.ts  widgets.ts
                      list.ts  deck.ts  jobs.ts  actions.ts  deps.ts  models.ts
                      search.ts  divider.ts  dragdrop.ts  theme.ts  icons.ts
      js/panels/     settings.ts  import.ts  transcribe.ts  cleanup.ts
      sw.ts          the service worker (its own TS project - see below)
```

The `js/` folder keeps its name even though it holds TypeScript: it's part of
every client import specifier and of the URLs the browser fetches, so renaming
it would be churn with nothing behind it.

**Three TypeScript projects, not one**, because they run in three different
places and must not see each other's globals: `tsconfig.json` covers the CLI
and server (Bun globals, no DOM), `src/web/assets/tsconfig.json` covers the
browser modules (DOM, no Bun), and `src/web/assets/tsconfig.sw.json` covers
the service worker (WebWorker, neither). `bun run typecheck` runs all three.
They share `tsconfig.base.json`.

**Dependencies run one way:** `bin/` → `cli/` → `lib/`, with `web/` reaching
into `lib/` alongside `cli/`. Nothing in `lib/` imports from `cli/` or `web/`,
so anything there is safe to reuse from either side.

| Module | Responsibility |
| --- | --- |
| `lib/config.ts` | Load / save `~/.vno/config.json`, defaults, corrupt-file recovery |
| `lib/volumes.ts` | Per-OS removable-volume detection |
| `lib/sync.ts` | Audio file discovery, the flat copy, self-healing old nested imports — reports progress rather than printing it, so the terminal and the page can each render it their own way |
| `lib/whisper.ts` | Resolving the installed whisper.cpp binary/model and running a transcription (ffmpeg pre-conversion to WAV, spawning the binary, accel-state helpers) |
| `lib/whispercpp.ts` | Installing whisper.cpp itself: `vno-install.json`, per-platform binary acquisition (Homebrew, GitHub release zip, `cmake` source build), model resolution/download/validation |
| `lib/llama.ts` | Resolving the installed llama.cpp binary/model and running a summarization (no ffmpeg step — text in, text out). Optional; see [summarization.md](summarization.md) |
| `lib/llamacpp.ts` | Installing llama.cpp itself, mirroring `lib/whispercpp.ts` — its own `llama-cpp/vno-install.json`, curated model aliases, drop-in `.gguf` discovery. Entirely optional, never touched unless `vno setup --llama` is run |
| `lib/engineInstall.ts` | The install-root/manifest/download/archive-extraction/GPU-detection primitives shared by `whispercpp.ts` and `llamacpp.ts` — everything genuinely engine-agnostic about "vendor a binary + models under a vno-managed folder" |
| `lib/setup.ts` | Finding ffmpeg on PATH, per-OS install recipes, running them, re-reading PATH |
| `lib/media.ts` | ffprobe durations, filename date parsing, formatting |
| `lib/vtt.ts` | Parse and serialize WebVTT cues |
| `lib/notes.ts` | Builds the note model both the CLI and the page render from, reporting progress through an optional callback |
| `cli/progress.ts` | The terminal progress bar every slow per-file loop draws through |
| `lib/open.ts` | Opening a folder / revealing a file, per OS — behind `vno explore`, the UI's Explore button and `/api/reveal` alike |
| `lib/ledger.ts` | `~/.vno/deleted.json`: what was deleted, so import won't re-copy it |
| `lib/themes.ts` | The UI's theme ids/labels, and `themeOf(config)`. Ids only — each palette lives in `assets/app.css` as a `[data-theme="id"]` block, so colours have one home. Here rather than in `web/` because `vno setting` offers the same list |
| `lib/special-case-handling.ts` | Recovering Samsung Voice Recorder `.m4a` files whose index was truncated by an interrupted copy — see [Troubleshooting](troubleshooting.md#a-samsung-recording-wont-play-or-transcribe-and-a-repairedm4a-appeared) |

## There is no build step

Not for the CLI — Bun runs the TypeScript sources directly, and the published
package ships them as-is — and not for the UI either.

`assets/app.css`, `assets/app.ts` and every module under `assets/js/` are read
from disk on **each request**, so a browser reload is enough to see a UI edit
— no restart. Changes to anything in `web/server/` or `lib/` do need a
restart.

The client modules are TypeScript, and `server/assets.ts` type-strips them per
request with `Bun.Transpiler` on the way out. The transpiler *only* removes
types: it rewrites no specifiers, so `import "./deck.ts"` survives verbatim and
the browser comes straight back for that module. Browsers key off the
`Content-Type`, not the extension, so a `.ts` URL served as `text/javascript`
is exactly what a native ES module loader wants. There's still no bundler, no
framework and no dependencies — just the browser resolving `import`/`export`
one module at a time.

Two consequences worth knowing. Cross-module *type* imports must be written
`import type`, so they're erased rather than left pointing at a module the
server doesn't serve. And a syntax error in a client module comes back as a
500 naming the file, instead of a blank page and an opaque parse failure.

Adding a client file needs no server change: an `import` from whichever module
uses it is enough, and `server/assets.ts` serves anything under `assets/` by
extension.

The session token is the one thing not in the assets: `page.ts` inlines it into
the HTML, so it never travels in an asset URL — which is also why the two asset
routes sit *ahead* of the token gate. `/sw.js` (the service worker) follows the
same reasoning and sits ahead of the gate too, but is served at the *root*
path rather than under `/assets/` so its default scope is the whole origin.

`/manifest.webmanifest` is also ahead of the gate but, unlike the assets, is
generated per request (`page.ts:renderManifest`) rather than read off disk -
its `start_url` has to carry the current token, since an installed PWA's
shortcut has no other way to get one; a static file could only ever bake in
whatever token happened to exist when it was written. The token itself is
persisted in `~/.vno/session-token` and reused across `vno v` launches
(`lib/sessionToken.ts`) rather than regenerated per run, so that embedded
`start_url` keeps working indefinitely instead of dying the moment the
server restarts. (An *already-installed* PWA shortcut won't pick up a
manifest fix like this on its own - most browsers cache the manifest from
install time - so reinstalling the PWA is what actually applies a
`start_url` change to an existing install.)

`cli/visualize.ts:openViewer()` is what actually hands the URL to the OS once
the server is up: it calls `lib/open.ts:findInstalledPwaShortcut()` (Windows
only, matching `vno://`'s own scope) to look for the app's Start Menu shortcut
(named after the manifest's `name`, "Voice Notes.lnk" — Chrome/Edge create it
verbatim on install) and opens that instead of the plain URL when it exists,
so a person who's installed the PWA always lands in the standalone window
rather than a browser tab. `bin/vno.ts`'s `open-protocol` handler (the `vno://`
target) never calls `runVisualize` in its own process at all: that process is
the one the OS launches for the protocol, so it's stuck with whatever console
window that invocation creates. Instead it immediately re-spawns a second,
detached `vno visualize --no-open` with `windowsHide: true` - which suppresses
window creation for the *new* process outright (`CREATE_NO_WINDOW`), unlike
trying to hide a console this process already owns - and exits. The actual
server then runs fully in the background with no window of its own.
`--no-open` carries over the same reasoning as before: the tab or window that
had the user click "Launch vno" is `offline.html`, already polling in the
background, so opening anything here would just be a redundant second window.

## The local HTTP API

Everything below `/api` requires the session token, supplied as an
`X-VNO-Token` header, a `?t=` query parameter, or a `token` field in the JSON
body (`sendBeacon` can't set headers). Cross-origin requests are refused
outright. See the [UI's security model](ui.md#security-model).

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | The page. Token required as `?t=` |
| `/assets/*` | GET | Static assets (app.css, app.ts, assets/js/**). **Not** token-gated, by design |
| `/manifest.webmanifest` | GET | PWA manifest, generated per request so `start_url` carries the current token. **Not** token-gated itself |
| `/sw.js` | GET | Service worker (installability + offline fallback page). **Not** token-gated |
| `/media/<rel>` | GET | Streams audio, with range-request support |
| `/api/state` | GET | Notes, config, model list, theme list, `ffmpeg`/whisper.cpp availability, summarization availability, current job |
| `/api/events` | GET | SSE stream: `job` and `notes` events |
| `/api/ping` | POST | Liveness |
| `/api/bye` | POST | Tab closed (deferred shutdown) or Quit (`{quit:true}`, immediate) |
| `/api/settings` | POST | Patch `autoTranslate`, `defaultModel`, `transcribeLanguage`, `crossLanguageModel`, `crossLanguageMap`, `summaryModel`, `openWhenDone`, `rememberDeletions`, `theme`, `useGpu` |
| `/api/sources` | POST | Replace `config.sources` wholesale (array-shaped, doesn't fit the scalar `/api/settings` patch) |
| `/api/sources/explore` | POST | Open the folder a source's files currently land in (or will, on next sync) — `mapTo` when set, else `target/<sanitized source basename>/`. Used by the source-removal confirmation dialog |
| `/api/reveal` | POST | Reveal a file, or open a folder |
| `/api/transcript` | PUT | Save an edited transcript (cues or plain text) |
| `/api/notes/delete` | POST | Delete a recording and its sidecars |
| `/api/notes/refresh` | POST | Recheck one note against disk (bypasses the duration cache) |
| `/api/transcribe` | POST | Start a transcription job |
| `/api/summarize` | POST | Start a summarization job for one recording (`{rel, model?}`) — optional, 412 if llama.cpp/a model isn't set up. See [summarization.md](summarization.md) |
| `/api/summary` | PUT | Save a manually edited summary |
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
  keyed by size+mtime (`lib/notesCache.ts`), so only new or changed files pay
  for it. Selecting a note in the browser triggers `POST /api/notes/refresh`,
  a one-file recheck that bypasses the cache, so a file changed outside vno
  doesn't show stale data until the next full rebuild.
- **The filter box is a full-text search, and it reads the transcripts.**
  `assets/js/search.ts` matches a take's name, folder path and transcript text
  as one string — normalised so every run of whitespace is a single space,
  because a timed transcript is joined cue by cue and a phrase said across a
  cue boundary is only contiguous after that. Those strings are built once per
  note into a `WeakMap` (replaced wholesale on the next state reload, so
  there's nothing to invalidate) and pre-built in idle slices, which is what
  makes a keystroke a few milliseconds of `indexOf` over the whole library
  rather than a rescan. Extending a query only re-tests rows still showing,
  since a string can't contain `abc` without containing `ab`. Transcript hits
  render as a marked context line under the row and are marked again in the
  open take's transcript — without that, a take matching on words nobody can
  see just looks like a filtering bug.
- **One job at a time.** A second start returns `409 Busy`. Jobs stream their
  output line by line to the page's log panel; the last 200 lines are kept.
- **Colour only ever comes from a token, and a theme is one attribute.** Every
  palette is a `[data-theme="<id>"]` block at the top of `assets/app.css`
  defining the same dozen semantic custom properties (`--bg`, `--surface`,
  `--ink`, `--accent`, …); nothing below those blocks writes a literal colour,
  which is what lets a theme swap the whole page by rewriting
  `document.documentElement.dataset.theme` (`assets/js/theme.ts`). Two
  consequences worth keeping: the blocks are written as `[data-theme=…]`
  rather than `:root[data-theme=…]`, so the settings dialog can preview a
  theme by putting its id on a swatch element instead of duplicating hex
  values in JS; and the saved theme is stamped into `<html>` by `page.ts`,
  because a theme that only arrived with `/api/state` would paint the default
  palette first and then visibly swap. `lib/themes.ts` holds the ids (shared
  with `vno setting`) — never the colours.
- **The Samsung `.m4a` repair is a catch-block feature, and it re-frames with
  ffmpeg rather than a native decoder.** `lib/special-case-handling.ts` handles
  recordings whose `moov` was cut off mid-`stsz` by an interrupted copy. The
  audio is intact; only the frame boundaries are lost, and an AAC
  `raw_data_block` has no length field to scan for. The trick is that vno
  already ships a decoder that can find them: given an MP4 declaring the whole
  `mdat` as a *single* sample, ffmpeg decodes one frame, reports what it
  consumed, and libavformat re-feeds the rest — recovering every frame. That
  makes the repair deterministic and verifiable (the recovered frame count is
  checked against the count `stts` recorded before the cut) at the cost of one
  re-encode, and with no dependency beyond the ffmpeg vno already requires.
  The rebuild replaces the recording **in place** so nothing downstream has to
  know a repair happened, with the damaged file kept as `<name>.original.m4a` —
  filtered out of `findMediaFiles` so it can't surface as a duplicate note, and
  removable through `vno cleanup --originals` / the Cleanup dialog's checkbox.
  Verification runs before anything is renamed, and the swap moves the original
  aside first, so a failed repair can never leave the user without their file.
  Two easy things to get wrong: a successful ffprobe is **not** a health check
  (duration comes from the intact movie header), and neither is a cache miss (a
  library scanned before this existed has durations cached) — which is why the
  structural check hangs off `buildNote`, the one call every recording passes
  through, rather than off `getDurationSeconds`.
- **Dependency probing never runs the thing it's checking for.** `lib/setup.ts`
  scans `PATH` for ffmpeg (honouring `PATHEXT`, and `lstat` so Windows App
  Execution Aliases resolve); `lib/whispercpp.ts:resolveBinary` checks the
  vendored `whisper-cpp/bin/` in both install roots, then PATH. Both are
  directory scans, not executions, which is what makes the check affordable
  at the start of every command and on every `/api/state`, with nothing to
  memoise or invalidate — an install done in another terminal shows up on the
  next refresh. It's also the same resolution `spawn` will do, so it predicts
  the real outcome.
- **`lib/setup.ts` decides, `cli/setup.ts` asks.** Detection and install
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
- **The ledger must never be load-bearing.** `lib/ledger.ts` swallows its own
  read *and* write failures: missing, corrupt and unreadable all resolve to
  "nothing is remembered", and a failed write can't turn a successful delete
  into an error. Suppression is folded into `resolveFlatDest` so it reuses the
  existing name+size key rather than inventing a second notion of sameness.

---

[← Back to the docs index](README.md) · [The browser UI](ui.md) · [CLI reference](cli-reference.md)
