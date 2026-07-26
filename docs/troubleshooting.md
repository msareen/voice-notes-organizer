# Troubleshooting

## `whisper` or `ffmpeg` isn't found

```
ffmpeg and whisper aren't on your PATH, and transcribing needs them.
```

Run:

```bash
vno setup
```

It reports which of `ffmpeg`, `ffprobe` and `whisper` are missing and offers to
install them with your machine's package manager. The commands it offers are in
the [CLI reference](cli-reference.md#vno-setup) if you'd rather run them
yourself. You don't have to remember to run it — `vno transcribe`, `vno
cleanup` and auto-translating imports all run the same check first.

## `vno setup` installed it, but vno still can't find it

vno re-reads your `PATH` after installing (from the registry on Windows, plus
the usual install directories elsewhere), but some installers put things
somewhere else entirely. **Open a new terminal** and try again.

**On Windows**, `pip` installs `whisper.exe` into your Python `Scripts`
directory — e.g. `C:\Users\<you>\AppData\Local\Programs\Python\Python312\Scripts`
or `C:\PythonXX\Scripts`. If `whisper` still isn't found, add that folder to
your `PATH` and restart your shell. Find it with:

```powershell
python -c "import sysconfig; print(sysconfig.get_path('scripts'))"
```

Check what vno itself resolves, and where:

```bash
vno setup --check
```

## pip refuses to install whisper: "externally-managed-environment"

Debian, Ubuntu and Homebrew's Python won't let `pip` install into the system
interpreter. `vno setup` spots this and offers `pipx install openai-whisper`
instead, which puts whisper in its own environment. If you don't have pipx:

```bash
sudo apt-get install pipx    # or: brew install pipx
pipx install openai-whisper
```

## Durations show as `?`

That's `ffprobe` (part of ffmpeg) missing. Run `vno setup`.

Duration reading fails **quietly** by design, so a missing ffprobe never blocks
import or playback: the picker and the UI show `?`, and the takes list has no
`LEN` chip. The one place it isn't quiet is `vno cleanup`'s short-recording
scan, which would otherwise report "nothing is short" when the truth is "I
can't measure anything" — that stops and offers the install instead.

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
