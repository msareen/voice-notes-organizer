# Installation

The [main README](../README.md#getting-started) has the four steps most people
need. This page is the long version: what has to be on the machine already,
other ways to run the CLI, and how to install the dependencies by hand if you'd
rather not let `vno setup` do it.

## What you need first

- **Node.js 18+** (or [Bun](https://bun.sh)) to run the CLI. Everything else
  `vno setup` can install for you.
- **ffmpeg** on your `PATH` — whisper.cpp needs it to decode audio into the
  16kHz mono WAV it accepts, and `vno cleanup` uses `ffprobe` (shipped with
  ffmpeg) to measure durations.
- On Linux, building whisper.cpp from source needs `cmake`, `git` and a C++
  compiler already on the machine — `vno setup` tells you the exact command if
  any are missing.

No Python and no PyTorch, on any platform. Transcription is a single
self-contained binary.

## Installing the CLI

```bash
npm install -g @msareen/voice-notes-organizer
```

That puts `vno` on your `PATH`. To try it without installing anything:

```bash
npx @msareen/voice-notes-organizer          # same as `vno`
npx @msareen/voice-notes-organizer v        # ...or any other command
```

To update later:

```bash
npm update -g @msareen/voice-notes-organizer
```

To remove it:

```bash
npm uninstall -g @msareen/voice-notes-organizer
```

That leaves `~/.vno` (your config, and the record of what you've deleted) and
your recordings alone — uninstalling the tool never touches either. Delete
`~/.vno` yourself if you want it gone too.

## Installing ffmpeg and whisper.cpp

```bash
vno setup
```

Checks `ffmpeg`/`ffprobe` and whisper.cpp, then offers to install whatever is
missing — ffmpeg through whatever package manager you already have, whisper.cpp
as a per-platform prebuilt binary (or a source build on Linux with an NVIDIA
GPU). It then fetches the default model set (`small` + `turbo`).

**Nothing is installed without you confirming it**, and you don't have to
remember to run it: `vno transcribe`, `vno cleanup`'s duration scan and an
import that auto-translates all run the same check first, and offer the same
install. `vno setup --check` reports and installs nothing.

📖 [**Full `vno setup` reference →**](cli-reference.md#vno-setup) — every flag,
where things land, and how the GPU backend is chosen.
[Installing whisper.cpp](transcription.md#installing-whispercpp) covers the
per-platform detail.

## Installing the dependencies yourself

Prefer to skip `vno setup` and do it by hand:

| OS | ffmpeg | whisper.cpp |
| --- | --- | --- |
| macOS | `brew install ffmpeg` | `brew install whisper-cpp` |
| Windows | `winget install --id Gyan.FFmpeg -e` | download a [release zip](https://github.com/ggml-org/whisper.cpp/releases) |
| Linux (Debian/Ubuntu) | `sudo apt install ffmpeg` | `git clone` + `cmake` build — see [Transcription](transcription.md#installing-whispercpp) |

Verify with `ffmpeg -version`, `ffprobe -version` and `vno setup --check`.

If you install whisper.cpp somewhere yourself, `vno setup` can be pointed at
it rather than installing a second copy — choose **"I already have it
installed"** when it asks, and give it the path. Nothing is copied.

---

[← Back to the docs index](README.md) · [Transcription](transcription.md) · [Troubleshooting](troubleshooting.md)
