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
npm install
npm link                      # `vno` runs your working copy from anywhere
node bin/vno.js <command>     # or run in place, without linking

node bin/vno.js               # import (default command)
node bin/vno.js visualize     # browser UI; also `v` / `--v`
node bin/vno.js transcribe    # also `t` / `--t`
node bin/vno.js cleanup --dry-run
node bin/vno.js setup         # check/install ffmpeg + whisper.cpp; also `doctor`
node bin/vno.js config        # prints ~/.vno/config.json path
```

npm scripts (`npm run import|transcribe|cleanup|visualize|setting|setup|config`) are
thin wrappers over the same.

## The full `vno` surface

Every command and flag, for driving the tool directly. `vno` with no arguments is
`vno import`. `-v`/`--v` = `visualize`, `-t`/`--t` = `transcribe`.

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
`Ctrl+A` all, `Enter` confirms) listing only untranscribed files.

| Flag | Effect |
| --- | --- |
| `-m, --model <model>` | `turbo` (default), `tiny`, `base`, `small`, `medium`, `large` |
| `-f, --file [name]` | Transcribe one named file directly. **Bare `-f`** instead opens the picker over *every* file, including already-transcribed ones |
| `-s, --filter <text>` | Pre-filter the picker by name or recorded date |
| `--translate` | whisper.cpp's translate task (any language → English) instead of verbatim |
| `--no-open` | Don't launch the UI when the run finishes |

### `vno cleanup`
Scans for recordings shorter than the threshold and deletes them plus their
transcript sidecars, after a confirmation that defaults to *no*.

| Flag | Effect |
| --- | --- |
| `-f, --file <names...>` | Delete exactly these recordings instead of scanning. Skips ffprobe entirely. If **any** name fails to resolve, nothing is deleted |
| `-t, --threshold <seconds>` | Duration cutoff, default `3` |
| `--dry-run` | List what would go, delete nothing |

### `vno cleanup ledger`
Deletes `~/.vno/deleted.json`. Touches no recordings — it only makes vno forget what
was deleted, so those recordings import again if the device still has them.

### `vno visualize` (`v`, `--v`)
Serves the browser UI on loopback and blocks until the tab closes, the page's Quit
button is used, or Ctrl+C. Everything the CLI does is available in the page. Building
the note model up front needs an ffprobe per recording for duration, but that's cached
on disk keyed by size+mtime (`lib/notesCache.js`), so only new or changed files pay for
it after the first run — a progress bar (count + current folder) still runs until the
server is up, then clears itself, since a cold run or a large delta can still take a
moment.

| Flag | Effect |
| --- | --- |
| `-p, --port <number>` | Default `8477`; falls back to `8478` (with a warning) if that's taken. `0` picks a free port automatically instead |
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
`nvidia-smi`'s header, not a toolkit check — see `lib/whispercpp.js:detectAccelCandidate`)
if there's an NVIDIA GPU, a BLAS-accelerated CPU build otherwise (no Vulkan
asset exists, so non-NVIDIA GPUs get no acceleration); on Linux, a prebuilt
CPU tarball, or a `cmake` source build if there's an NVIDIA GPU (no prebuilt
Linux CUDA asset). If whisper.cpp isn't installed and neither `--local` nor
`--global` was passed, asks where: local, global, or a path to one already
installed (`registerExternalBinary`, never copied into place). Nothing
installs without a confirmation. Also fetches the default model set (`small`
+ `large-v3-turbo`) into `whisper-cpp/models/`, and reports (with an offer to
delete) leftover `~/.cache/whisper/*.pt` files from a prior Python whisper
install.

| Flag | Effect |
| --- | --- |
| `--check` | Report only; installs and downloads nothing |
| `--local` / `--global` | Install whisper.cpp beside this vno install or under the user's home directory, without asking |
| `--model <name>` | Fetch just this model instead of the defaults |
| `--list-models` | Print the model inventory and exit |

### `vno config`
Prints the path to `~/.vno/config.json`.

**Name resolution for `-f`** (shared by `transcribe`, `cleanup` and `explore`, in
`lib/notes.js:resolveNamedFile`): an absolute path, a path relative to the target, or
a bare filename matched case-insensitively — exact basename, then stem (so
`250810_1328` finds `250810_1328.mp3`), then unique substring. Several matches means
the command lists them and refuses rather than guessing.

**There is no build, lint, or test tooling.** No test runner, no test files, no
linter config. Verify changes by running the CLI or the UI by hand. `tsconfig.json`
is a leftover Bun template — there is no TypeScript in the repo and nothing typechecks
it; ignore it rather than trying to satisfy it.

**No build step for the UI either.** `src/web/assets/app.css`, `app.js` and every
module under `assets/js/` are read from disk on *every request* (`server/assets.js`),
so a browser reload shows a UI edit. Changes to `src/web/server/`, `page.js`, or
anything in `src/lib/` need a server restart.

**Published to npm as a public scoped package.** `@msareen/voice-notes-organizer`
— `publishConfig.access` must stay `"public"`, since scoped packages default to
restricted and `npm publish` fails without it. Users install with `npm i -g` or run
it via `npx`; `npm link` is the *development* workflow, not the distribution story.
There is still no build step: `files` ships `bin/`, `src/` and `docs/` as-is, and
`src/web/assets/` is resolved off `import.meta.url` so it works from `node_modules`.

**`.gitattributes` pins the working tree to LF, and that is load-bearing.** `npm
pack` packs the working tree rather than the git index, so on a clone with
`core.autocrlf=true` the shebang in `bin/vno.js` would ship as `#!/usr/bin/env
node\r` and every Linux/macOS install would fail with `env: 'node\r': No such file
or directory`. Don't remove `* text=auto eol=lf`.

## Architecture

Dependencies run one way: `bin/` → `src/cli/` → `src/lib/`, with `src/web/` reaching
into `src/lib/` alongside `cli/`. **Nothing in `lib/` imports from `cli/` or `web/`**,
which is what makes it shareable between the terminal and the browser paths. Keep it
that way — if a CLI module grows logic the UI also needs, move it down into `lib/`.

- `bin/vno.js` — commander definitions only. Version is read from `package.json` at
  runtime, never hardcoded. `-v`/`--v`/`-t`/`--t` are rewritten into command names in
  `process.argv` before parse, since commander would otherwise read them as options.
- `src/cli/*` — one module per command, each exporting `run<Command>()`. `import.js`
  ends by handing off to `runVisualize()`, so `vno` blocks until the browser tab closes.
- `src/lib/*` — domain logic and OS access: config, volume detection, the flat copy,
  ffprobe, VTT parsing, the note model, the deletion ledger, opening folders,
  `setup.js` (PATH lookup + per-OS install recipes for ffmpeg), `whispercpp.js`
  (installing whisper.cpp itself — `install.json`, per-platform binary acquisition,
  model resolution/download/validation) and `whisper.js` (resolving the installed
  binary/model and running a transcription: ffmpeg pre-conversion to WAV, spawning
  the binary, the accel-state helpers that replaced `gpu.js`).
- `src/web/server/` — the HTTP server, split by route group. `index.js` builds the
  shared `ctx` (notes/config/job/SSE-clients state, plus the token gate and dispatch
  table) and owns process/socket lifecycle; `context.js` defines `ctx` itself;
  `assets.js`/`media.js`/`events.js` handle static files, range-request audio
  streaming and the SSE stream; `routes/*.js` (state, settings, notes, transcribe,
  import, cleanup) each export a `createXRoutes(ctx)` factory of closures over `ctx` -
  add a new route by adding a case to `index.js`'s dispatch switch and a handler in
  the matching (or a new) `routes/` file. `page.js` emits the HTML shell and nothing
  else.
- `src/web/assets/app.js` — the client entry point, native ES modules (`<script
  type="module">`, no bundler, no framework, no dependencies - browsers resolve the
  imports directly, so app.js is just wiring). The rest lives under `assets/js/`:
  `state.js`/`dom.js` hold the shared mutable state and element refs every module
  reads; `api.js`/`format.js`/`widgets.js` are generic helpers; `list.js` (the takes
  list) and `deck.js` (the playback/transcript deck) are mutually referential by
  design - selecting a row plays it, the deck's actions refresh the list - which is a
  safe ES module cycle as long as cross-calls happen inside event handlers rather
  than at module-evaluation time; `panels/*.js` are the four command modals
  (Settings, Import, Transcribe, Cleanup); `jobs.js` owns the SSE connection, the job
  strip and page lifecycle (heartbeat, quit, deferred shutdown). Keep the "no build
  step" property: every file here must be loadable as-is by a browser.

`docs/architecture.md` has the full route table and module responsibilities; read it
before changing the API surface.

### Invariants worth knowing before you change things

- **`rel` is the note id everywhere** — a target-relative, forward-slash path. The
  server's `resolveInside()` converts it back to an absolute path and refuses anything
  escaping the target folder. Never build a filesystem path from client input any
  other way.
- **External tools are detected by looking them up, never by running them.**
  `lib/setup.js:which()` scans PATH itself (PATHEXT-aware, `lstat` so Windows
  App Execution Aliases resolve), used for ffmpeg. `lib/whispercpp.js:resolveBinary()`
  does the equivalent for whisper.cpp: checks the vendored `whisper-cpp/bin/`
  in both install roots (local beside this vno install, global under the
  user's home directory), then PATH under any of its binary names
  (`whisper-cpp`, `whisper-cli`, `whisper-cli.exe`). Both are directory scans,
  never executions, so the check runs at the start of every command that
  shells out and on every `/api/state` with no cache to invalidate — and it
  resolves exactly the way `spawn` will. `lib/setup.js`/`lib/whispercpp.js`
  never prompt — the offer-and-install flow is `cli/setup.js:ensureDependencies()`,
  which `transcribe`, `cleanup`'s duration scan and import's auto-translate all
  call before starting work. The browser can't install anything, so the page
  reports and points at `vno setup`.
- **The accelerator backend is fixed at install time, not probed at
  runtime.** Unlike the old Python/PyTorch path (which needed a slow torch
  probe to answer "is CUDA usable?" because a CPU-only torch wheel was a
  common trap), whisper.cpp's backend (CUDA/Metal/CPU — no Vulkan asset
  exists, so non-NVIDIA GPUs get no acceleration) is baked into which binary
  `vno setup` installed — recorded in `install.json`, read back
  by `cli/setup.js:checkAccel()` into `config.accel`, which costs nothing and
  so runs on every `vno setup`, not gated behind a slow-path flag.
  `lib/whisper.js:resolveAccel()` is the single place the "use it unless the
  user said no" rule lives, because the browser has nowhere to ask at job
  time; `resolveAccel(config) !== "cpu"` decides, and `-ng` forces the CPU
  even on an accelerator-capable build. A failure mid-run just retries that
  file (and the rest of the run) on the CPU — there's nothing to invalidate
  in config, since re-checking the backend is free.
- **Notes are cached in the server closure, and durations are cached again on disk.**
  The in-memory `notes` array is rebuilt only when something changes it, then broadcast
  over SSE (`refreshNotes()`). Within a rebuild, `buildNotes` (`lib/notes.js`) skips the
  ffprobe duration call for any file whose size+mtime match what's recorded in
  `lib/notesCache.js` (`~/.vno/notes-cache/<hash of target>.json`) — the only thing worth
  caching, since it's the one field that costs a process spawn rather than a stat or a
  small file read. Selecting a note in the browser calls `POST /api/notes/refresh`
  (`refreshNote` in `lib/notes.js`), which bypasses the cache for that one file — a
  single ffprobe — updates the shared note object in place, and patches the disk cache,
  so a file changed outside vno doesn't show stale data indefinitely without forcing a
  full rescan.
- **One job at a time.** `guardJob()` returns `409 Busy` for a second start. Job output
  streams line-by-line to the page log.
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
- **The deletion ledger must never be load-bearing.** `lib/ledger.js` keeps
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
  check, because the session token is inlined into the HTML by `page.js` and must never
  travel in an asset URL.

### Conventions

- ESM throughout (`"type": "module"`), Node 18+, `node:` prefix on builtins,
  `fs-extra` for filesystem work.
- Terminal prompts go through `src/cli/prompt.js`, not `inquirer` directly: `prompt()`
  resolves the `CANCELLED` sentinel on Esc, `promptStrict()` throws `PromptCancelled`.
  Callers are expected to handle backing out of a flow.
- Config is a single global file, `~/.vno/config.json`, loaded via `loadConfig()` and
  merged over `defaultConfig()`; a corrupt file is backed up rather than crashing.
  New settings need a default there plus, usually, a case in `vno setting`, a field in
  the UI's settings dialog (`assets/js/panels/settings.js:openSettings`), and
  passthrough in the server's `routes/settings.js:settings` **and**
  `context.js:stateResponse` — the dialog can't show what state doesn't
  send. `~/.vno` also holds `deleted.json`; config is not the only file there.
- **Long per-file work reports, it doesn't print.** `buildNotes`, `findAudioFiles` and
  `syncVolume` take an optional `onProgress` and emit `{ phase: "scan", dir, found }`,
  `{ phase: "work", done, total, dir, name }` and `{ phase: "log", message, level }`.
  The terminal renders those as a progress bar (`cli/progress.js`), the browser turns
  the same events into job log lines and title updates — which is the whole reason
  `lib/` can't do the printing itself. `lib/sync.js:reporter()` wraps the callback so
  a display bug can never fail the work. Adding a new slow loop? Report, don't print.
- Child processes (whisper.cpp, ffmpeg, ffprobe, `cmake`/`git` for a Linux
  source build) always pass `windowsHide: true`.
- Comments in this codebase explain *why* a non-obvious choice was made, not what the
  line does. Match that when adding code.
- Cross-platform matters: macOS, Windows and Linux are all supported paths in
  `volumes.js` and `open.js`.

## Documentation

`README.md` is the user-facing overview; `docs/` holds the detail (`ui.md`,
`cli-reference.md`, `configuration.md`, `import-and-sync.md`, `transcription.md`,
`troubleshooting.md`, `architecture.md`). Behaviour changes to commands, flags, config
keys or API routes should be reflected in the matching doc page.
