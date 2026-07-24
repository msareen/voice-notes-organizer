# voice-note-organizer (vno)

A small CLI that watches for removable volumes (voice recorders, SD cards,
USB drives), imports voice notes to a local folder, and transcribes them
with [whisper](https://github.com/openai/whisper).

Works on macOS, Windows, and Linux.

## Why

This project was born out of Sony's Sound Organizer 2 seeing almost no
meaningful update in a very long time — in 2026 it still does little beyond
basic import and sync. voice-note-organizer is built with digital
record-keeping in mind: using open-source tools like [Bun](https://bun.sh)
and [Whisper](https://github.com/openai/whisper), you can quickly import,
transcribe, and visualize your recordings.

## Installation

### 1. Prerequisites

- **Node.js 18+** (or [Bun](https://bun.sh)) to run the CLI.
- **Python 3.8+ with `pip`** — needed to install Whisper (transcription).
- **ffmpeg** on your `PATH` — Whisper uses it to read audio, and `vno cleanup`
  uses `ffprobe` (shipped with ffmpeg) to measure durations.

### 2. Get the project and install dependencies

```bash
git clone https://github.com/<you>/voice-note-organizer.git
cd voice-note-organizer

npm install          # or: bun install
```

Optionally link it so `vno` is available everywhere:

```bash
npm link             # then you can run `vno` from any folder
```

Without linking, run it in place with `node bin/vno.js <command>`,
`bun run <command>`, or the npm scripts (`npm run import`, etc.).

### 3. Install ffmpeg

- **macOS:** `brew install ffmpeg`
- **Windows:** `winget install ffmpeg` (or `choco install ffmpeg`)
- **Linux (Debian/Ubuntu):** `sudo apt install ffmpeg`

Verify with `ffmpeg -version` and `ffprobe -version`.

### 4. Install Whisper

```bash
pip install -U openai-whisper
```

(Use `pip3` if `pip` points at Python 2.) Verify with `whisper --help`.
If Whisper isn't on your `PATH` when you run `vno transcribe`, the tool
offers to run this `pip install` for you — but ffmpeg still has to be
installed separately (step 3).

> **Windows note:** `pip` installs `whisper.exe` into your Python `Scripts`
> directory (e.g. `C:\PythonXX\Scripts`). If `whisper` isn't found after
> install, add that folder to your `PATH` and restart your shell.

## Usage

```bash
npx voice-note-organizer
```

or, if installed globally / linked locally:

```bash
vno
```

### Commands

- `vno` / `vno import` (default) — detects connected volumes. For each new
  volume it asks (via arrow-key menus) whether to import audio files into the
  target folder and whether to remember that choice. If you say yes, it also
  lets you browse the volume's folders with the arrow keys and pin a specific
  subfolder as the sync root — useful for devices (e.g. many voice recorders)
  that bury audio several folders deep (`PRIVATE\SONY\VOICE\FOLDER01\...`).
  Press **Esc** at any prompt to cancel the import (anything already copied is
  kept).
  **Imported files land flat**: every recording is dropped directly into a
  single per-device folder (`voice-notes/<device>/`) rather than mirroring the
  device's deep folder tree — name collisions between subfolders are
  disambiguated with a `_2`, `_3`, … suffix. If you'd previously imported with
  the old nested layout, the next import flattens it in place automatically.
  Known volumes are auto-imported (or skipped) silently next time, using the
  remembered choice and subfolder — no re-prompting.
  **Auto-translate:** after importing new notes, `vno` offers (once) to
  auto-translate them to English with whisper's translate task as they come in.
  Your answer is remembered, so every subsequent import applies the same choice
  without asking — every note that lands that session (and in future sessions)
  is translated automatically. Toggle or reset this any time with
  `vno setting`. When it finishes it always regenerates `index.html` (see
  `vno visualize`), so the player reflects the latest import and transcripts.
- `vno transcribe` (alias `vno t` / `vno --t`) — lists audio files in the target folder that don't have
  a transcript yet, lets you pick which to transcribe, and runs `whisper` on
  each one. The picker **filters live as you type**: just start typing to
  narrow the list to rows whose text (name, recorded date or duration)
  contains what you typed, Backspace to edit, and the count updates as you go.
  Use ↑/↓ to move (no wraparound), **Space** to toggle a row, **Ctrl+A** to
  toggle all currently-visible rows, and **Enter** to transcribe everything
  that's both checked and visible. Pass `-s/--filter <text>` to pre-seed the
  filter. Each row shows the file's **recorded date** (read from the
  recorder's filename, e.g. `250810_1328` -> `2025-08-10 13:28`, falling back
  to the file's modified time) and its **duration**. Press **Esc** at any
  point — including mid-selection — to quit without transcribing.
  One file is written next to the audio file: a timed `.vtt` (WebVTT — plain,
  human-readable text plus the timing that drives `vno visualize`'s
  follow-along highlighting), e.g. `note.m4a` -> `note.vtt`. Use `-f/--file <name>`
  to transcribe one specific file without the picker — pass a full path, a
  path relative to the target, or just the filename (with or without
  extension, or even a unique substring) and it's searched for and
  transcribed. It then asks which Whisper model to use (defaulting to the
  fast, accurate `turbo` model, or whatever you set as the default in
  `vno setting`); pass `-m/--model <name>` to choose up front. Pass
  `--translate` to produce an English translation (whisper's translate task)
  instead of a verbatim transcript.
  If `whisper` isn't installed, it offers to install it via
  `pip install -U openai-whisper` (note: whisper also requires `ffmpeg` on
  your PATH).
- `vno visualize` (alias `vno v` / `vno --v`) — generates a self-contained `index.html` in the target
  folder: a two-pane organizer. The left pane is a file list (newest recording
  first) where each row shows the file name, its recorded date and time,
  duration, and size, plus a 📝 icon when a transcript is available (○ when
  not). Click a row and the right pane loads that note's audio player and
  transcript. When the note has a timed `.vtt` transcript, it follows along as
  it plays (highlighting and scrolling to the current line, and clicking any
  line jumps the audio there); a legacy plain `.txt` (from older runs) is shown
  without highlighting. A filter box searches by name or transcript text. The
  page references the audio by relative path (so it stays small) and needs no
  server or internet — just open it in a browser. `-o/--open` opens it for you.
  This runs automatically at the end of every `vno import`.
- `vno cleanup` — scans the target folder for recordings shorter than a
  threshold (default 3 seconds, likely accidental button presses) using
  `ffprobe` (part of ffmpeg) to measure duration, shows the list, and asks
  for confirmation (default: no) before deleting them along with any matching
  transcript. Use `-t/--threshold <seconds>` to change the cutoff, or
  `--dry-run` to just list what would be deleted without removing anything.
  It removes matching `.vtt`/`.srt`/`.txt` transcript sidecars too.
  This is the one command in `vno` that deletes files —
  `import`/`transcribe`/`visualize` never do (aside from `import` moving
  previously-nested files up into the flat layout).
- `vno setting` (alias `vno settings`) — an interactive wizard for the direct
  switches you're most likely to flip without hand-editing `config.json`:
  whether imports auto-translate (on / off / ask each time), the default
  whisper model, the target import folder, and forgetting all remembered volume
  choices. Arrow keys to pick a setting, Esc to exit; changes save as you make
  them.
- `vno config` — prints the path to the config file.

Every command is also available as an npm script:

```bash
npm run import
npm run transcribe            # or: npm run transcribe -- --file 250810_1328
npm run cleanup               # or: npm run cleanup -- --dry-run
npm run visualize             # or: npm run visualize -- --open
npm run setting
npm run config
```

(Note the `--` before flags: npm needs it to pass arguments through to the
command.)

### Config

Settings live in a global per-user config file:

```
~/.vno/config.json
```

```json
{
  "target": "/path/to/voice-notes",
  "sources": [],
  "knownMounts": {},
  "autoTranslate": null,
  "defaultModel": "turbo"
}
```

- `target` — where imported/synced audio files land. Defaults to a
  `voice-notes` folder inside whatever directory you first ran `vno` from.
  Edit this file to point it somewhere else.
- `sources` — an array of folders to import from in addition to
  auto-detected removable volumes (e.g. network shares, or drives that are
  already mounted and won't show up as "removable"). Add as many as you
  like:

  ```json
  "sources": [
    "/mnt/nas/voice-notes",
    "D:\\Backups\\OldRecorder"
  ]
  ```

  Only settable by editing this file for now; every entry is synced into
  `target` on every `vno import` run without prompting (it was explicitly
  configured, so it's trusted). If two sources (or a source and a detected
  volume) share the same folder name, the later one is disambiguated with
  its parent folder name (e.g. `Recordings (deviceB)`) so they don't land in
  the same destination folder.
- `knownMounts` — remembers, per detected volume (there's no limit to how
  many volumes can be tracked here), whether to auto-import it, which
  subfolder (if any) to sync from, and when it was last synced, so you're
  only asked once per volume. Edit this file directly to change a volume's
  remembered `sourceSubdir`.
- `autoTranslate` — whether freshly imported notes are auto-translated to
  English on import. `null` (the default) means "not decided yet", so `vno`
  asks once and stores your answer here; `true`/`false` translate imports (or
  don't) without asking. Reset it to `null` — or flip it — from `vno setting`.
- `defaultModel` — the whisper model used for auto-translation and pre-selected
  in the `vno transcribe` picker. One of `turbo`, `tiny`, `base`, `small`,
  `medium`, `large`. Change it from `vno setting`.

## Supported audio extensions

`.mp3 .wav .m4a .aac .flac .ogg .oga .wma .aiff .opus .amr .3gp`

## Development

```bash
npm install
node bin/vno.js
```
