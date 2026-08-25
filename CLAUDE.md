# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`vno` — a local-first CLI + browser UI that imports voice recordings off removable
volumes (Sony-style recorders, SD cards), transcribes them with a local
[whisper.cpp](https://github.com/ggml-org/whisper.cpp) binary, and lets you
play/edit them in a browser. Everything runs on the user's machine; there is
no server, database, account, Python, or PyTorch. Transcripts are plain
`.vtt` files written next to the audio.

## Commands

```bash
bun install
bun link                      # `vno` runs your working copy from anywhere
bun bin/vno.ts <command>      # or run in place, without linking
bun run typecheck             # tsc --noEmit over all three TS projects

bun bin/vno.ts               # import (default command)
bun bin/vno.ts visualize     # browser UI; also `v` / `viz` / `vis` / `--v`
bun bin/vno.ts transcribe    # also `t` / `--t`
bun bin/vno.ts cleanup --dry-run
bun bin/vno.ts status        # is vno ready? exits 0/1, --json for scripts
bun bin/vno.ts setup         # check/install ffmpeg + whisper.cpp; also `doctor`
bun bin/vno.ts config        # prints ~/.vno/config.json path
```

Package scripts (`bun run import|transcribe|cleanup|visualize|setting|setup|config`)
are thin wrappers over the same.

## The full `vno` surface

Every command and flag, for driving the tool directly. `vno` with no arguments is
`vno import`. `--v` = `visualize`, `-t`/`--t` = `transcribe`. `-v`/`--version` prints
the version (and a hint to use `v`/`viz`/`vis` for the UI) rather than launching it -
unlike `-t`, it's deliberately not a `visualize` shortcut.

### `vno import` (default)
Detects removable volumes plus configured `sources`, then copies new audio into
`target/<device>/`, flat. Prompts once per unknown volume (import? remember? pin a
subfolder?), then runs silently. Offers auto-translate once and remembers the answer.
Ends by opening the UI when anything was imported.

| Flag | Effect |
| --- | --- |
| `--no-open` | Don't launch the UI when the run finishes |

### `vno transcribe` (`t`, `--t`)
Runs whisper.cpp over selected recordings, writing one `.vtt` next to each audio
file. With no `-f`, opens a searchable picker (type to filter, `Space` toggles,
`Ctrl+A` all, `Enter` confirms) listing only untranscribed files. A positional
`[file]` argument instead (`vno t <file>`) is a direct one-shot path: no picker, no
model prompt, no requirement that the file live under `target` — just
`config.defaultModel` (or `-m`) run against exactly that file, never opening the UI
when done.

| Flag | Effect |
| --- | --- |
| `-m, --model <model>` | `turbo` (default), `tiny`, `base`, `small`, `medium`, `large` |
| `-f, --file [name]` | Transcribe one named file directly. **Bare `-f`** instead opens the picker over *every* file, including already-transcribed ones |
| `-s, --filter <text>` | Pre-filter the picker by name or recorded date |
| `--translate` | whisper.cpp's translate task (any language → English) instead of verbatim |
| `-o, --output <path>` | With a positional `[file]` only: write the transcript here instead of next to the source |
| `--no-open` | Don't launch the UI when the run finishes |

### `vno cleanup`
Scans for recordings shorter than the threshold and deletes them plus their
transcript sidecars, after a confirmation that defaults to *no*.

| Flag | Effect |
| --- | --- |
| `-f, --file <names...>` | Delete exactly these recordings instead of scanning. Skips ffprobe entirely. If **any** name fails to resolve, nothing is deleted |
| `-t, --threshold <seconds>` | Duration cutoff, default `3` |
| `--originals` | Also offer the `*.original.m4a` backups kept beside repaired Samsung recordings. Listed and deleted as their own group — no transcript sidecars, never written to the ledger. Works without ffprobe |
| `--dry-run` | List what would go, delete nothing |

### `vno cleanup ledger`
Deletes `~/.vno/deleted.json`. Touches no recordings — it only makes vno forget what
was deleted, so those recordings import again if the device still has them.

### `vno visualize` (`v`, `viz`, `vis`, `--v`)
Serves the browser UI on loopback and blocks until the tab closes, the page's Quit
button is used, or Ctrl+C. Everything the CLI does is available in the page. Building
the note model up front needs an ffprobe per recording for duration, but that's cached
on disk keyed by size+mtime (`lib/notesCache.ts`), so only new or changed files pay for
it after the first run — a progress bar (count + current folder) still runs until the
server is up, then clears itself, since a cold run or a large delta can still take a
moment.

| Flag | Effect |
| --- | --- |
| `-p, --port <number>` | Default `8477`, fixed across runs (stable for bookmarks and an installed PWA's `start_url`). If it's held by another `vno v` instance, opens a tab to that instance instead of picking a new port; if held by something else, errors and asks for `--port`. `0` picks a free port automatically instead |
| `--no-open` | Start the server without opening a browser |

### `vno explore` (`open`)
Opens the target folder in the OS file manager. With a `[file]` argument, reveals
that recording with the file selected instead (name resolution below; Linux has no
portable "select" verb, so there it opens the containing folder). Always prints the
path first, since `openPath` is best-effort. A name that matches nothing or several
recordings prints the shared explanation and exits non-zero. The UI's **Explore**
button, the `⧉` on each device group and per-take *Open file location* are the same
thing over `/api/reveal`.

### `vno setting` (`settings`)
Interactive wizard: auto-translate, default model, target folder, open-when-done,
remember-deletions, plus resets for remembered volumes and the deletion ledger.
Esc exits.

### `vno setup` (`doctor`)
Reports whether `ffmpeg`/`ffprobe` are on PATH and whisper.cpp is installed
(with resolved paths), and offers to install what's missing: ffmpeg via the
machine's own package manager (winget/choco/scoop, brew/port,
apt/dnf/yum/pacman/zypper/apk), whisper.cpp per-platform — `brew install
whisper-cpp` on macOS (Metal automatically); on Windows, a GitHub release zip
with a CUDA build matched to the driver's supported CUDA runtime (via
`nvidia-smi`'s header, not a toolkit check — see `lib/whispercpp.ts:detectAccelCandidate`)
if there's an NVIDIA GPU, a BLAS-accelerated CPU build otherwise (no Vulkan
asset exists, so non-NVIDIA GPUs get no acceleration); on Linux, a prebuilt
CPU tarball, or a `cmake` source build if there's an NVIDIA GPU (no prebuilt
Linux CUDA asset). If whisper.cpp isn't installed and neither `--local` nor
`--global` was passed, asks where: local, global, or a path to one already
installed (`registerExternalBinary`, never copied into place). Nothing
installs without a confirmation. Also fetches the default model set (`small`
+ `large-v3-turbo`) into `whisper-cpp/models/`, reports (with an offer to
delete) leftover `~/.cache/whisper/*.pt` files from a prior Python whisper
install, and — Windows only — reports whether `vno://` is registered as a URL
protocol handler and offers to (re-)register it (`lib/protocol.ts`), so a
browser can launch `vno v` the way a Teams/Zoom link launches its own app.

| Flag | Effect |
| --- | --- |
| `--check` | Report only; installs and downloads nothing |
| `--local` / `--global` | Install whisper.cpp beside this vno install or under the user's home directory, without asking |
| `--model <name>` | Fetch just this model instead of the defaults |
| `--list-models` | Print the model inventory and exit |

### `vno config`
Prints the path to `~/.vno/config.json`.

**Name resolution for `-f`** (shared by `transcribe`, `cleanup` and `explore`, in
`lib/notes.ts:resolveNamedFile`): an absolute path, a path relative to the target, or
a bare filename matched case-insensitively — exact basename, then stem (so
`250810_1328` finds `250810_1328.mp3`), then unique substring. Several matches means
the command lists them and refuses rather than guessing.

**The whole repo is TypeScript, and Bun runs it directly. There is still no
build step anywhere** — not in development, not for the published package.
`bun run typecheck` is a *check* (`tsc --noEmit`), never a compile; nothing in
this repo emits JavaScript, and adding a build output would undo the point.

**Three TS projects, because there are three global environments**, and each
must not see the others': `tsconfig.json` = CLI + server (Bun, no DOM);
`src/web/assets/tsconfig.json` = browser modules (DOM, no Bun);
`src/web/assets/tsconfig.sw.json` = the service worker (WebWorker, neither).
All extend `tsconfig.base.json`. `strict` is on; `noUncheckedIndexedAccess` is
deliberately off (see the comment there). `src/types.ts` holds the domain types
every layer shares and deliberately imports nothing, so the browser project can
pull from it.

**There is no lint or test tooling.** No test runner, no test files, no linter
config. Verify changes with `bun run typecheck` plus running the CLI or the UI
by hand.

**No build step for the UI either — the browser modules are transpiled per
request.** `src/web/assets/app.css`, `app.ts` and every module under
`assets/js/` are read from disk on *every request* (`server/assets.ts`), so a
browser reload shows a UI edit. The `.ts` ones are type-stripped on the way out
with `Bun.Transpiler`, which rewrites no specifiers — `import "./deck.ts"`
survives, and the browser fetches that URL back through the same route, keyed
off the `text/javascript` Content-Type rather than the extension. Two rules
follow: **client code must use `import type` for cross-module types** (a value
import of `src/types.ts` would survive erasure and 404), and a syntax error
comes back as a 500 naming the file rather than a blank page. Changes to
`src/web/server/`, `page.ts`, or anything in `src/lib/` still need a server
restart.

**Published to npm as a public scoped package, but installed with Bun.**
`@msareen/voice-notes-organizer` — `publishConfig.access` must stay `"public"`,
since scoped packages default to restricted and `npm publish` fails without it.
Users install with `bun i -g` or run it via `bunx`; **Node cannot run this
package** (`engines.bun`, and `bin` points at `bin/vno.ts`). `bun link` is the
*development* workflow, not the distribution story. `files` ships `bin/`,
`src/`, `docs/` and the tsconfigs as-is, and `src/web/assets/` is resolved off
`import.meta.url` so it works from `node_modules`.

**`.gitattributes` pins the working tree to LF, and that is load-bearing.** A
pack takes the working tree rather than the git index, so on a clone with
`core.autocrlf=true` the shebang in `bin/vno.ts` would ship as `#!/usr/bin/env
bun\r` and every Linux/macOS install would fail with `env: 'bun\r': No such file
or directory`. Don't remove `* text=auto eol=lf`.

## Architecture

Dependencies run one way: `bin/` → `src/cli/` → `src/lib/`, with `src/web/` reaching
into `src/lib/` alongside `cli/`. **Nothing in `lib/` imports from `cli/` or `web/`**,
which is what makes it shareable between the terminal and the browser paths. Keep it
that way — if a CLI module grows logic the UI also needs, move it down into `lib/`.

- `bin/vno.ts` — commander definitions only. Version is read from `package.json` at
  runtime, never hardcoded. `--v`/`-t`/`--t` are rewritten into command names in
  `process.argv` before parse, since commander would otherwise read them as options
  (`v`/`viz`/`vis`/`t` are ordinary commander `.aliases()` and don't need this).
  `-v`/`--version` is a real option (`program.on("option:version", ...)`, not
  `.version()`'s built-in handler) so it can print a hint pointing at `v`/`viz`/`vis`
  alongside the version number.
- `src/cli/*` — one module per command, each exporting `run<Command>()`. `import.ts`
  ends by handing off to `runVisualize()`, so `vno` blocks until the browser tab closes.
- `src/lib/*` — domain logic and OS access: config, volume detection, the flat copy,
  ffprobe, VTT parsing, the note model, the deletion ledger, opening folders,
  `setup.ts` (PATH lookup + per-OS install recipes for ffmpeg), `whispercpp.ts`
  (installing whisper.cpp itself — `vno-install.json`, per-platform binary acquisition,
  model resolution/download/validation; models come from Hugging Face with an
  hf-mirror.com fallback and a `VNO_MODEL_BASE` override — note the HF repo is
  still under `ggerganov` even though the GitHub org moved to `ggml-org`, so the
  two URLs deliberately disagree), `themes.ts` (the UI theme ids +
  `themeOf()` — ids only, never colours), `languages.ts` (the whisper
  language vocabulary + `normalizeLanguageMap()`, shared by both settings
  surfaces for the same reason `themes.ts` is) and `whisper.ts` (resolving the installed
  binary/model and running a transcription: ffmpeg pre-conversion to WAV, spawning
  the binary, the accel-state helpers that replaced `gpu.ts`), plus
  `special-case-handling.ts` (recovering Samsung `.m4a` files with a truncated
  index — see the invariant below), `sessionToken.ts` (the persisted `~/.vno/session-token`
  the server reads at startup) and `protocol.ts` (Windows-only: registers `vno://` as a
  URL protocol via `reg.exe`, so a browser can launch `vno v` the way a Teams/Zoom link
  launches its own app — `vno setup` is the only caller).
- `src/web/server/` — the HTTP server, split by route group. `index.ts` builds the
  shared `ctx` (notes/config/job/SSE-clients state, plus the token gate and dispatch
  table) and owns process/socket lifecycle; `context.ts` defines `ctx` itself;
  `assets.ts`/`media.ts`/`events.ts` handle static files, range-request audio
  streaming and the SSE stream; `routes/*.ts` (state, settings, notes, transcribe,
  import, cleanup) each export a `createXRoutes(ctx)` factory of closures over `ctx` -
  add a new route by adding a case to `index.ts`'s dispatch switch and a handler in
  the matching (or a new) `routes/` file. `page.ts` emits the HTML shell and nothing
  else.
- `src/web/assets/app.ts` — the client entry point, native ES modules (`<script
  type="module">`, no bundler, no framework, no dependencies - browsers resolve the
  imports directly off the per-request transpile, so app.ts is just wiring). The
  folder is still called `js/` because its name is part of every import specifier
  and every URL the browser fetches. The rest lives under `assets/js/`:
  `state.ts`/`dom.ts` hold the shared mutable state and element refs every module
  reads; `api.ts`/`format.ts`/`widgets.ts` are generic helpers, as is `search.ts`
  (the normalised name+path+transcript haystack the filter box searches, built once
  per note in a `WeakMap` and warmed while the browser is idle); `list.ts` (the
  takes list) and `deck.ts` (the playback/transcript deck) are mutually referential
  by design - selecting a row plays it, the deck's actions refresh the list - which
  is a safe ES module cycle as long as cross-calls happen inside event handlers rather
  than at module-evaluation time; `panels/*.ts` are the four command modals
  (Settings, Import, Transcribe, Cleanup); `jobs.ts` owns the SSE connection, the job
  strip and page lifecycle (heartbeat, quit, deferred shutdown); `theme.ts` writes the
  theme id onto `<html>`; `icons.ts` builds the few SVGs the client makes at
  runtime (the topbar's are inline in `page.ts`); `pwa.ts` registers the service
  worker and shows the "install as an app" banner off `beforeinstallprompt`;
  `sw.ts` is the service worker, which sits outside `js/` and typechecks as its
  own project because it runs in a ServiceWorkerGlobalScope with no DOM. Keep the
  "no build step" property: every file here must be loadable by a browser after
  nothing more than type erasure - no JSX, no decorators, no enums, nothing that
  needs real codegen.

`docs/architecture.md` has the full route table and module responsibilities; read it
before changing the API surface.

### Invariants worth knowing before you change things

- **`rel` is the note id everywhere** — a target-relative, forward-slash path. The
  server's `resolveInside()` converts it back to an absolute path and refuses anything
  escaping the target folder. Never build a filesystem path from client input any
  other way.
- **External tools are detected by looking them up, never by running them.**
  `lib/setup.ts:which()` scans PATH itself (PATHEXT-aware, `lstat` so Windows
  App Execution Aliases resolve), used for ffmpeg. `lib/whispercpp.ts:resolveBinary()`
  does the equivalent for whisper.cpp: checks the vendored `whisper-cpp/bin/`
  in both install roots (local beside this vno install, global under the
  user's home directory), then PATH under any of its binary names
  (`whisper-cpp`, `whisper-cli`, `whisper-cli.exe`). Both are directory scans,
  never executions, so the check runs at the start of every command that
  shells out and on every `/api/state` with no cache to invalidate — and it
  resolves exactly the way `spawn` will. `lib/setup.ts`/`lib/whispercpp.ts`
  never prompt — the offer-and-install flow is `cli/setup.ts:ensureDependencies()`,
  which `transcribe`, `cleanup`'s duration scan and import's auto-translate all
  call before starting work. The browser can't install anything, so the page
  reports and points at `vno setup`.
- **The accelerator backend is fixed at install time, not probed at
  runtime.** Unlike the old Python/PyTorch path (which needed a slow torch
  probe to answer "is CUDA usable?" because a CPU-only torch wheel was a
  common trap), whisper.cpp's backend (CUDA/Metal/CPU — no Vulkan asset
  exists, so non-NVIDIA GPUs get no acceleration) is baked into which binary
  `vno setup` installed — recorded in `vno-install.json`, read back
  by `cli/setup.ts:checkAccel()` into `config.accel`, which costs nothing and
  so runs on every `vno setup`, not gated behind a slow-path flag.
  `lib/whisper.ts:resolveAccel()` is the single place the "use it unless the
  user said no" rule lives, because the browser has nowhere to ask at job
  time; `resolveAccel(config) !== "cpu"` decides, and `-ng` forces the CPU
  even on an accelerator-capable build. A failure mid-run just retries that
  file (and the rest of the run) on the CPU — there's nothing to invalidate
  in config, since re-checking the backend is free.
- **Notes are cached in the server closure, and durations are cached again on disk.**
  The in-memory `notes` array is rebuilt only when something changes it, then broadcast
  over SSE (`refreshNotes()`). Within a rebuild, `buildNotes` (`lib/notes.ts`) skips the
  ffprobe duration call for any file whose size+mtime match what's recorded in
  `lib/notesCache.ts` (`~/.vno/notes-cache/<hash of target>.json`) — the only thing worth
  caching, since it's the one field that costs a process spawn rather than a stat or a
  small file read. Selecting a note in the browser calls `POST /api/notes/refresh`
  (`refreshNote` in `lib/notes.ts`), which bypasses the cache for that one file — a
  single ffprobe — updates the shared note object in place, and patches the disk cache,
  so a file changed outside vno doesn't show stale data indefinitely without forcing a
  full rescan.
- **One job at a time.** `guardJob()` returns `409 Busy` for a second start. Job output
  streams line-by-line to the page log.
- **Colour lives in tokens, and a theme is one attribute.** Every palette is a
  `[data-theme="<id>"]` block at the top of `assets/app.css` setting the same dozen
  semantic custom properties (`--bg`, `--surface`, `--ink`, `--accent`, `--line`, …);
  nothing below those blocks may write a literal colour, or it won't survive a theme
  swap. The blocks are deliberately `[data-theme=…]` and not `:root[data-theme=…]`,
  so the settings dialog previews a theme by putting its id on a swatch element and
  no hex value is ever repeated in JS. `page.ts` stamps the saved theme onto `<html>`
  server-side, since a theme arriving with `/api/state` would flash the default first.
  `"auto"` has no palette of its own: it borrows Tape, and Daylight again inside a
  `prefers-color-scheme: light` media query — the one palette written twice, because
  a media query can't be referenced from another selector. Keep those two in step.
- **The Samsung `.m4a` repair re-frames with ffmpeg, and only from a catch block.**
  `lib/special-case-handling.ts` handles recordings whose `moov` was cut off
  mid-`stsz` by an interrupted copy: `mdat` is intact, but AAC `raw_data_block`s
  have no length field, so the frame boundaries can't be byte-scanned. Rather than
  an FFI'd AAC decoder (an earlier version used `koffi`+libfaad2 — never satisfiable
  on Windows, and it only recovered the surviving `stsz` prefix), it rebuilds a
  minimal MP4 declaring the *whole* `mdat` as a **single sample**: ffmpeg decodes a
  frame, reports what it consumed, and libavformat re-feeds the remainder, walking
  every frame. That single-sample `stsz` is deliberately untruthful — don't "fix" it.
  The result is verified against the frame count `stts` recorded before the cut, so
  a repair either provably got everything or says what it missed. Costs one
  re-encode; needs nothing beyond the ffmpeg vno already requires. The rebuild
  **replaces the recording in place** (so `rel`, the transcript name and every
  downstream consumer are unaffected), keeping the damaged file as
  `<name>.original.m4a` — filtered out of `findMediaFiles`, removable via
  `vno cleanup --originals` and the Cleanup dialog's checkbox, and never written to
  the deletion ledger. Verification runs *before* the swap, and the swap renames
  the original aside first, so a failed repair can't cost the user their file.
  Two things are easy to get wrong: a successful ffprobe is **not** a health check
  (duration comes from the intact movie header), and neither is a cache miss (an
  already-scanned library has durations cached) — so the check hangs off
  `healIfDamaged()` in `buildNote`, the one call every recording passes through.
- **A zero exit code still gets a freshness check.** whisper.cpp's exit code is
  reliable (unlike the old Python whisper, which could exit 0 having silently
  skipped a file over a Windows console encoding bug — gone now that there's
  no Python in the pipeline), but `transcribeFile` still verifies the `.vtt`
  exists and is newer than when the run started before resolving, belt and
  braces.
- **Timed transcript saves never touch timings.** The editor sends text only; the
  server re-reads cues off disk and merges. A cue-count mismatch is a `409`.
- **Imports are idempotent** by name + size (`resolveFlatDest`). Files land flat, one
  folder per device; old nested imports are flattened in place on re-run.
- **Deletion is confined** to `cleanup`, the UI's cleanup, and per-take delete — all
  behind a confirmation. Nothing else in the codebase removes a user file. Keep it so.
  Those same three are the only writers to the deletion ledger, which is exactly why
  a file deleted by hand in Explorer can't be remembered and will re-import.
- **The deletion ledger must never be load-bearing.** `lib/ledger.ts` keeps
  `~/.vno/deleted.json`, listing what was deleted so import doesn't copy it back off a
  device that still holds it. It swallows its own read *and* write failures: missing,
  corrupt and unreadable all mean "nothing is remembered", and a failed write can't
  turn a successful delete into an error. Deleting the file is a supported user action
  (`vno cleanup ledger`), so never make correctness depend on it existing. Suppression
  lives inside `resolveFlatDest` so it reuses the existing name+size key rather than
  inventing a second notion of "the same recording"; entries are scoped by `target`.
- **The page owns the CLI lifetime.** Losing the SSE stream schedules a deferred
  shutdown (so a reload doesn't kill the session); a running job is allowed to finish.
- **Assets are deliberately *not* token-gated** and their routes sit ahead of the token
  check, because the session token is inlined into the HTML by `page.ts` and must never
  travel in an asset URL. `/sw.js` follows the same rule and is served at the root path
  rather than under `/assets/`, so the service worker's default scope covers the whole
  origin instead of just `/assets/*`. `/manifest.webmanifest` sits ahead of the gate too,
  but unlike the assets it's generated per request (`page.ts:renderManifest`), not read
  off disk — its `start_url` has to embed the current token, which a static file could
  never do. An already-installed PWA shortcut won't notice a `start_url` fix on its own
  (most browsers cache the manifest from install time); reinstalling the PWA is what
  actually picks up a changed one.
- **Launching the viewer prefers the installed PWA over a browser tab, and `vno://`
  never opens a second window.** `cli/visualize.ts:openViewer()` calls
  `lib/open.ts:findInstalledPwaShortcut()` (Windows only, matching `vno://`'s own scope)
  to look for the Start Menu shortcut Chrome/Edge name after the manifest's `name`
  ("Voice Notes.lnk") and opens that instead of the plain URL when found. The
  `open-protocol` command (the `vno://` handler's target) never runs the server in its
  own process — that process is stuck with whatever console window the OS creates for
  the protocol invocation, so it immediately re-spawns a second, detached
  `vno visualize --no-open` with `windowsHide: true` (suppresses window creation for
  the *new* process outright, unlike trying to hide a console this process already
  owns) and exits, leaving the real server running fully in the background. `--no-open`
  carries over the same reasoning either way — the tab or window that had the user
  click "Launch vno" is `offline.html`, already polling in the background, so opening
  anything there would just be a redundant second window.
- **The session token is persisted, not regenerated per run.** `lib/sessionToken.ts`
  keeps it in `~/.vno/session-token` and reuses it across `vno v` launches. It still
  gates every mutating route the same way (loopback is reachable by anything on the
  machine, including a hostile page's hidden iframe, so the token is what stops that
  iframe from getting a live session just by loading `/`) — the only change is that the
  URL an installed PWA remembers as its fixed `start_url` keeps working indefinitely
  instead of dying the moment the server restarts.

### Conventions

- ESM throughout (`"type": "module"`), Bun 1.2+, `node:` prefix on builtins
  (Bun implements them), `fs-extra` for filesystem work.
- Relative imports carry the `.ts` extension (`allowImportingTsExtensions`).
  That's not cosmetic on the client side: the specifier is what the browser
  fetches back, so it has to name a file the asset route can serve.
- `catch` binds `unknown` under `strict`. Modules that need a message from one
  keep a small local `errorMessage(err)` helper rather than casting inline.
- Terminal prompts go through `src/cli/prompt.ts`, not `inquirer` directly: `prompt()`
  resolves the `CANCELLED` sentinel on Esc, `promptStrict()` throws `PromptCancelled`.
  Callers are expected to handle backing out of a flow.
- Config is a single global file, `~/.vno/config.json`, loaded via `loadConfig()` and
  merged over `defaultConfig()`; a corrupt file is backed up rather than crashing.
  New settings need a default there plus, usually, a case in `vno setting`, a field in
  the UI's settings dialog (`assets/js/panels/settings.ts:openSettings`), and
  passthrough in the server's `routes/settings.ts:settings` **and**
  `context.ts:stateResponse` — the dialog can't show what state doesn't
  send. `~/.vno` also holds `deleted.json` and `session-token`; config is not the only
  file there.
- **Long per-file work reports, it doesn't print.** `buildNotes`, `findMediaFiles` and
  `syncVolume` take an optional `onProgress` and emit `{ phase: "scan", dir, found }`,
  `{ phase: "work", done, total, dir, name }` and `{ phase: "log", message, level }`.
  The terminal renders those as a progress bar (`cli/progress.ts`), the browser turns
  the same events into job log lines and title updates — which is the whole reason
  `lib/` can't do the printing itself. `lib/sync.ts:reporter()` wraps the callback so
  a display bug can never fail the work. Adding a new slow loop? Report, don't print.
- Child processes (whisper.cpp, ffmpeg, ffprobe, `cmake`/`git` for a Linux
  source build) always pass `windowsHide: true`.
- Comments in this codebase explain *why* a non-obvious choice was made, not what the
  line does. Match that when adding code.
- Cross-platform matters: macOS, Windows and Linux are all supported paths in
  `volumes.ts` and `open.ts`.

## Documentation

`README.md` is the user-facing overview — deliberately thin: a four-step
"Getting started", what the app is, the command table, and a pointer per topic.
`docs/` holds the detail (`installation.md`, `ui.md`, `cli-reference.md`,
`configuration.md`, `import-and-sync.md`, `transcription.md`, `troubleshooting.md`,
`architecture.md`). Behaviour changes to commands, flags, config keys or API routes
should be reflected in the matching doc page. Resist re-growing a reference *inside*
the README — the config table and install walkthrough both lived there once, went
stale against `docs/`, and were cut for exactly that reason.
