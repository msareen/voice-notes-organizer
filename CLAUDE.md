# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`vno` — a local-first CLI + browser UI that imports voice recordings off removable
volumes (Sony-style recorders, SD cards), transcribes them with the local `whisper`
CLI, and lets you play/edit them in a browser. Everything runs on the user's machine;
there is no server, database, or account. Transcripts are plain `.vtt` files written
next to the audio.

## Commands

```bash
npm install
npm link                      # `vno` runs your working copy from anywhere
node bin/vno.js <command>     # or run in place, without linking

node bin/vno.js               # import (default command)
node bin/vno.js visualize     # browser UI; also `v` / `--v`
node bin/vno.js transcribe    # also `t` / `--t`
node bin/vno.js cleanup --dry-run
node bin/vno.js setup         # check/install ffmpeg + whisper; also `doctor`
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
Runs whisper over selected recordings, writing one `.vtt` next to each audio file.
With no `-f`, opens a searchable picker (type to filter, `Space` toggles, `Ctrl+A`
all, `Enter` confirms) listing only untranscribed files.

| Flag | Effect |
| --- | --- |
| `-m, --model <model>` | `turbo` (default), `tiny`, `base`, `small`, `medium`, `large` |
| `-f, --file [name]` | Transcribe one named file directly. **Bare `-f`** instead opens the picker over *every* file, including already-transcribed ones |
| `-s, --filter <text>` | Pre-filter the picker by name or recorded date |
| `--translate` | whisper's translate task (any language → English) instead of verbatim |
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
the note model up front costs an ffprobe per recording, so a progress bar (count +
current folder) runs until the server is up, then clears itself.

| Flag | Effect |
| --- | --- |
| `-p, --port <number>` | Default `0` = pick a free port |
| `--no-open` | Start the server without opening a browser |

### `vno setting` (`settings`)
Interactive wizard: auto-translate, default model, target folder, open-when-done,
remember-deletions, plus resets for remembered volumes and the deletion ledger.
Esc exits.

### `vno setup` (`doctor`)
Reports whether `ffmpeg`, `ffprobe` and `whisper` are on PATH (with resolved
paths) and offers to install what's missing via the machine's own package manager
— winget/choco/scoop, brew/port, apt/dnf/yum/pacman/zypper/apk — with whisper from
pip, Python first if there is none, and pipx as the fallback when the system Python
is externally managed. Nothing installs without a confirmation.

| Flag | Effect |
| --- | --- |
| `--check` | Report only; never offer to install |

### `vno config`
Prints the path to `~/.vno/config.json`.

**Name resolution for `-f`** (shared by `transcribe` and `cleanup`, in
`lib/notes.js:resolveNamedFile`): an absolute path, a path relative to the target, or
a bare filename matched case-insensitively — exact basename, then stem (so
`250810_1328` finds `250810_1328.mp3`), then unique substring. Several matches means
the command lists them and refuses rather than guessing.

**There is no build, lint, or test tooling.** No test runner, no test files, no
linter config. Verify changes by running the CLI or the UI by hand. `tsconfig.json`
is a leftover Bun template — there is no TypeScript in the repo and nothing typechecks
it; ignore it rather than trying to satisfy it.

**No build step for the UI either.** `src/web/assets/app.css` and `app.js` are read
from disk on *every request*, so a browser reload shows a UI edit. Changes to
`server.js`, `page.js`, or anything in `src/lib/` need a server restart.

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
  whisper, ffprobe, VTT parsing, the note model, the deletion ledger, opening folders,
  and `setup.js` (PATH lookup + per-OS install recipes for ffmpeg/whisper/Python).
- `src/web/server.js` — the whole HTTP server: token gate, JSON API, SSE job stream,
  range-request media streaming. `page.js` emits the HTML shell and nothing else.
- `src/web/assets/app.js` — the entire client, ~1200 lines of plain ES5-flavoured JS
  in one IIFE, no framework, no bundler, no dependencies. Keep it that way.

`docs/architecture.md` has the full route table and module responsibilities; read it
before changing the API surface.

### Invariants worth knowing before you change things

- **`rel` is the note id everywhere** — a target-relative, forward-slash path. The
  server's `resolveInside()` converts it back to an absolute path and refuses anything
  escaping the target folder. Never build a filesystem path from client input any
  other way.
- **External tools are detected by looking them up on PATH, never by running
  them.** `lib/setup.js:which()` scans PATH itself (PATHEXT-aware, `lstat` so
  Windows App Execution Aliases resolve). Running `whisper --help` boots Python and
  torch and costs seconds, which is why the old probe had to be memoised; a lookup
  is free, so the check runs at the start of every command that shells out and on
  every `/api/state` with no cache to invalidate. It also resolves exactly the way
  `spawn` will. `lib/setup.js` never prompts — the offer-and-install flow is
  `cli/setup.js:ensureDependencies()`, which `transcribe`, `cleanup`'s duration
  scan and import's auto-translate all call before starting work. The browser
  can't install anything, so the page reports and points at `vno setup`.
- **Notes are cached in the server closure.** Building the model costs an ffprobe per
  file, so it is rebuilt only when something changes it, then broadcast over SSE
  (`refreshNotes()`).
- **One job at a time.** `guardJob()` returns `409 Busy` for a second start. Job output
  streams line-by-line to the page log.
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
  the UI's settings dialog (`app.js:openSettings`), and passthrough in the server's
  `patchSettings` **and** `stateResponse` — the dialog can't show what state doesn't
  send. `~/.vno` also holds `deleted.json`; config is not the only file there.
- Child processes (`whisper`, `ffprobe`, `pip`) always pass `windowsHide: true`.
- Comments in this codebase explain *why* a non-obvious choice was made, not what the
  line does. Match that when adding code.
- Cross-platform matters: macOS, Windows and Linux are all supported paths in
  `volumes.js` and `open.js`.

## Documentation

`README.md` is the user-facing overview; `docs/` holds the detail (`ui.md`,
`cli-reference.md`, `configuration.md`, `import-and-sync.md`, `transcription.md`,
`troubleshooting.md`, `architecture.md`). Behaviour changes to commands, flags, config
keys or API routes should be reflected in the matching doc page.
