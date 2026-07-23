# voice-note-organizer (vno)

A small CLI that watches for removable volumes (voice recorders, SD cards,
USB drives), imports voice notes to a local folder, and transcribes them
with [whisper](https://github.com/openai/whisper).

Works on macOS, Windows, and Linux.

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
  **Imported files land flat**: every recording is dropped directly into a
  single per-device folder (`voice-notes/<device>/`) rather than mirroring the
  device's deep folder tree — name collisions between subfolders are
  disambiguated with a `_2`, `_3`, … suffix. If you'd previously imported with
  the old nested layout, the next import flattens it in place automatically.
  Known volumes are auto-imported (or skipped) silently next time, using the
  remembered choice and subfolder — no re-prompting. When it finishes it also
  regenerates `index.html` (see `vno visualize`).
- `vno transcribe` — lists audio files in the target folder that don't have
  a transcript yet, lets you pick which to transcribe (checkbox list), and
  runs `whisper` on each one. Two files are written next to the audio file:
  a timed `.vtt` (WebVTT, used by `vno visualize` for follow-along
  highlighting) and a plain `.txt` derived from it (e.g. `note.m4a` ->
  `note.vtt` + `note.txt`). Use `-f/--file <name>` to transcribe one specific
  file without the picker — pass a full path, a path relative to the target,
  or just the filename (with or without extension, or even a unique substring)
  and it's searched for and transcribed. If `whisper` isn't installed, it
  offers to install it via `pip install -U openai-whisper` (note: whisper also
  requires `ffmpeg` on your PATH).
- `vno visualize` — generates a self-contained `index.html` in the target
  folder that lists every note with an in-page audio player. When a note has a
  timed `.vtt` transcript, the transcript follows along as it plays
  (highlighting and scrolling to the current line, and clicking any line jumps
  the audio there); notes with only a plain `.txt` show the text without
  highlighting. There's a filter box to search by name or transcript text. The
  page references the audio by relative path (so it stays small) and needs no
  server or internet — just open it in a browser. `-o/--open` opens it for you.
  This runs automatically at the end of every `vno import`.
- `vno cleanup` — scans the target folder for recordings shorter than a
  threshold (default 3 seconds, likely accidental button presses) using
  `ffprobe` (part of ffmpeg) to measure duration, shows the list, and asks
  for confirmation (default: no) before deleting them along with any matching
  transcript. Use `-t/--threshold <seconds>` to change the cutoff, or
  `--dry-run` to just list what would be deleted without removing anything.
  It also removes matching `.vtt`/`.srt` transcripts alongside the `.txt`.
  This is the one command in `vno` that deletes files —
  `import`/`transcribe`/`visualize` never do (aside from `import` moving
  previously-nested files up into the flat layout).
- `vno config` — prints the path to the config file.

Every command is also available as an npm script:

```bash
npm run import
npm run transcribe            # or: npm run transcribe -- --file 250810_1328
npm run cleanup               # or: npm run cleanup -- --dry-run
npm run visualize             # or: npm run visualize -- --open
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
  "knownMounts": {}
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

## Supported audio extensions

`.mp3 .wav .m4a .aac .flac .ogg .oga .wma .aiff .opus .amr .3gp`

## Development

```bash
npm install
node bin/vno.js
```
