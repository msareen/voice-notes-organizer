# Troubleshooting

## `whisper.cpp` or `ffmpeg` isn't found

```
ffmpeg and whisper.cpp aren't on your PATH, and transcribing needs them.
```

Run:

```bash
vno setup
```

It reports which of `ffmpeg`, `ffprobe` and `whisper.cpp` are missing and
offers to install them — ffmpeg with your machine's package manager,
whisper.cpp per-platform (Homebrew on macOS; a CUDA-matched or BLAS-CPU
release zip on Windows; a prebuilt CPU binary, or a `cmake` source build if
you have an NVIDIA GPU, on Linux; see [Installing
whisper.cpp](transcription.md#installing-whispercpp)). The commands it offers
are in the [CLI reference](cli-reference.md#vno-setup) if you'd rather run
them yourself. You don't have to remember to run it — `vno transcribe`, `vno
cleanup` and auto-translating imports all run the same check first.

## `vno setup` installed it, but vno still can't find it

Check what vno itself resolves, and where:

```bash
vno setup --check
```

whisper.cpp is vendored into `whisper-cpp/bin/` (local or global, see
[Installing whisper.cpp](transcription.md#installing-whispercpp)) rather than
put on your system `PATH`, so a new terminal shouldn't be necessary — but if
`vno setup --check` still shows it missing right after a successful install,
something wrote the binary somewhere unexpected. The install log `vno setup`
printed says exactly where it put it; check `install.json` in that
`whisper-cpp/` folder for the recorded path.

**On Windows**, every `.dll` the release zip shipped has to stay beside
`whisper-cli.exe` — if you moved or copied just the `.exe` out of
`whisper-cpp/bin/`, it won't start. Re-run `vno setup` to re-extract the zip
cleanly rather than patching the folder by hand.

## A model isn't found

```
The "small" model isn't installed. Run `vno setup --model small` to download it.
```

Models live in `whisper-cpp/models/` as `ggml-<name>.bin` files. Run
`vno setup --list-models` to see what's present, where, and whether each one
validates (size and header check) — a file that fails validation is treated
as absent and gets deleted and re-downloaded on the next `vno setup`. Point
`WHISPER_MODEL_PATH` at a file or directory to use a model from somewhere
else entirely (a shared network location, one you downloaded by hand).

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

Expected on CPU, though whisper.cpp is several times faster than the old
Python implementation on the same hardware — see [Choosing a
model](transcription.md#choosing-a-model). Drop to `small` or `base`, or leave
a batch running overnight. The first run of any model also downloads it
(hundreds of MB to ~1.6 GB), which looks like a hang.

If your machine has an NVIDIA GPU or is a Mac, check vno knows about it:
`vno setup` installs a build matched to it (CUDA on NVIDIA, Metal
automatically on Apple silicon) and offers to use it, which is several times
faster. AMD and Intel GPUs on Windows/Linux aren't accelerated — whisper.cpp
ships no Vulkan build — so those fall back to a BLAS-accelerated CPU build,
still faster than plain CPU but not GPU-fast. See [GPU
acceleration](transcription.md#gpu-acceleration).

## `vno` isn't a recognised command

Your shell hasn't picked up npm's global bin folder, or the install didn't take.
Restart the shell first, then check the package is actually there:

```bash
npm ls -g --depth 0        # should list @msareen/voice-notes-organizer
npm bin -g                 # this folder has to be on your PATH
```

If that folder isn't on your `PATH`, add it — on Windows it's usually
`%APPDATA%\npm`, on macOS/Linux something like `/usr/local/bin` or
`~/.npm-global/bin`. Either way you can skip the global bin entirely:

```bash
npx @msareen/voice-notes-organizer <command>
```

Working from a clone (`npm link`)? Same checks apply, and you can always run it
in place with `node bin/vno.js <command>`.

## The config file is broken

If `~/.vno/config.json` can't be parsed, `vno` backs it up to
`config.json.bak-<timestamp>` and writes a fresh default rather than crashing.
Your `knownMounts` and `sources` are in the backup if you want them back.

---

Still stuck? [Open an issue](https://github.com/msareen/voice-notes-organizer/issues)
with the command you ran and the full output.

---

[← Back to the docs index](README.md) · [Transcription](transcription.md) · [Configuration](configuration.md)
