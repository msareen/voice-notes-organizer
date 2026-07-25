# Troubleshooting

## `whisper` isn't found

```
whisper CLI was not found on your PATH.
```

Install it:

```bash
pip install -U openai-whisper
```

(`pip3` if `pip` points at Python 2.) Verify with `whisper --help`.

**On Windows**, `pip` installs `whisper.exe` into your Python `Scripts`
directory — e.g. `C:\Users\<you>\AppData\Local\Programs\Python\Python312\Scripts`
or `C:\PythonXX\Scripts`. If `whisper` still isn't found after installing, add
that folder to your `PATH` and **restart your shell**. Find it with:

```powershell
python -c "import sysconfig; print(sysconfig.get_path('scripts'))"
```

`vno transcribe` offers to run the pip install for you, but it can't fix your
`PATH`, and it can't install ffmpeg.

## `whisper --help` throws a traceback, but transcription works

Known with some Python 3.12 / argparse combinations. `vno` handles it: only a
genuine "command not found" is treated as *not installed*, so whisper is still
used normally.

## ffmpeg / ffprobe isn't found

Whisper needs `ffmpeg` to read audio, and `vno cleanup` needs `ffprobe`
(shipped with ffmpeg) to measure durations.

```bash
brew install ffmpeg          # macOS
winget install ffmpeg        # Windows (or: choco install ffmpeg)
sudo apt install ffmpeg      # Debian / Ubuntu
```

Verify **both**: `ffmpeg -version` and `ffprobe -version`.

**Symptom without it:** durations show as `?` in the picker and the UI, the
takes list has no `LEN` chip, and `vno cleanup` finds nothing — it can't
measure anything, so nothing looks short. This fails quietly by design, so a
missing ffprobe never blocks import or playback.

## No volumes are detected

- The recorder must be in **USB mass-storage / file-transfer mode**, not
  charging-only or MTP. Check it appears in Explorer / Finder first.
- **Internal drives are excluded on purpose.** Detection only accepts USB, SD,
  MMC and FireWire buses (plus mapped network drives on Windows), and never the
  system disk. See [Import & sync](import-and-sync.md#what-counts-as-a-volume).
- **Linux:** only `/media/<user>`, `/media` and `/run/media/<user>` are
  scanned. `/mnt` is deliberately skipped.
- Anything the detector won't see can be added by hand as a
  [`sources`](configuration.md#sources) entry — it's then imported on every run
  without prompting.

## A volume imports silently / stopped asking me

That's [`knownMounts`](configuration.md#knownmounts) doing its job — you
answered once and it remembered. To change your mind, edit that section of
`~/.vno/config.json`, or run `vno setting` → *forget all remembered volume
choices*.

## Import copied the wrong files, or far too many

You're syncing the whole volume rather than the recorder's audio folder. Pin a
subfolder: the CLI prompt offers a folder browser, and the UI's import dialog
has a **Subfolder** button per volume. See
[Pinning a subfolder](import-and-sync.md#pinning-a-subfolder).

## A recording shows no transcript, but the `.vtt` exists

Transcripts are matched **by filename stem**: `note.mp3` ↔ `note.vtt`. If you
renamed one and not the other, rename it back — or rename both to match.

Also check the sidecar is beside the audio, not in a subfolder.

## The browser page won't open, or says "Invalid session token"

Every run generates a fresh single-use token, inlined into the page URL:

- **A bookmarked URL won't work** — its token belongs to a dead session. Start
  a new one with `vno v` and use the URL it prints.
- **The port changes every run** unless you pin it with `-p/--port`.
- If no browser opens, the URL is in the terminal — paste it manually.
- `--no-open` starts the server without launching a browser at all.

## The CLI exits as soon as I close the tab

By design — the browser tab *is* the session. Reloads and second tabs are fine;
closing the last tab ends the CLI a few seconds later. A job already running
finishes first. Use **Quit** in the header to end it deliberately.

## A UI edit doesn't show up

There's no build step: `app.css` and `app.js` are read from disk per request,
so a **browser reload** is enough. If it's still stale, hard-reload
(`Ctrl`/`Cmd`+`Shift`+`R`). Only changes to `server.js` or anything in `lib/`
need a restart.

## "Transcript changed on disk — reload and try again"

The `.vtt` changed underneath the editor (usually a re-transcribe finished
while it was open). The save is refused rather than clobbering the newer file.
Reload the page and redo the edit.

## Transcription is unbearably slow

Expected on CPU — see [Choosing a model](transcription.md#choosing-a-model).
Drop to `small` or `base`, or leave a batch running overnight. The first run of
any model also downloads it (hundreds of MB to ~3 GB), which looks like a hang.

## `vno` isn't a recognised command

`npm link` didn't take, or your shell hasn't picked up the global bin folder.
Restart the shell, and check `npm ls -g --depth 0` lists
`@msareen/voice-notes-organizer`. Otherwise just run it in place:

```bash
node bin/vno.js <command>
```

## The config file is broken

If `~/.vno/config.json` can't be parsed, `vno` backs it up to
`config.json.bak-<timestamp>` and writes a fresh default rather than crashing.
Your `knownMounts` and `sources` are in the backup if you want them back.

---

Still stuck? [Open an issue](https://github.com/msareen/voice-notes-organizer/issues)
with the command you ran and the full output.

---

[← Back to the docs index](README.md) · [Transcription](transcription.md) · [Configuration](configuration.md)
