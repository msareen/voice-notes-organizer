# Transcription

Transcription is [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
running **locally** on your machine as a single self-contained binary — no
Python, no PyTorch, no account, no upload, no per-minute cost.

> *Transcription is slow — but it is free.* A long recording on a big model
> can take a while, though whisper.cpp is several times faster than the old
> Python implementation on the same hardware. That's still the trade you're
> making, just a better version of it.

whisper.cpp and ffmpeg both have to be installed. You don't have to arrange
that yourself: every command that transcribes checks first and offers to
install what's missing, and [`vno setup`](cli-reference.md#vno-setup) does the
same on demand — see [Installing whisper.cpp](#installing-whispercpp) below
for what that actually does.

## Choosing a model

`turbo` is the default and the right answer most of the time: near
`large`-quality, several times faster. Drop down only if `turbo` is too slow on
your hardware, or you're batching a long backlog.

| Model | Speed | Quality | Use when |
| --- | --- | --- | --- |
| `tiny` | fastest | rough | You just need something searchable |
| `base` | very fast | passable | Clear speech, quiet room |
| `small` | fast | decent | A reasonable floor for real use |
| `medium` | slow | good | Accents, crosstalk, background noise |
| `large` | slowest | best | Hard audio you can't re-record |
| `turbo` | fast | near-`large` | **Default. Start here.** |

Set your default with `vno setting` or the [UI's Settings
dialog](ui.md#settings) — it's stored as
[`defaultModel`](configuration.md#defaultmodel). Override per run with
`-m/--model`, or in the transcribe dialog's dropdown.

Models download themselves on first use into `whisper-cpp/models/` (a few
hundred MB to ~1.6 GB depending on size), validated after downloading and
cached afterwards. The first run of a new model will sit there apparently
doing nothing while it downloads — that's expected. See [Installing
whisper.cpp](#installing-whispercpp) for exactly where they live and how to
pre-fetch or inspect them with `vno setup --list-models`.

## Installing whisper.cpp

`vno setup` installs a prebuilt or freshly-built `whisper.cpp` binary,
per platform:

| Platform | How | Accelerator |
| --- | --- | --- |
| macOS | `brew install whisper-cpp` | Metal, automatically, on Apple silicon |
| Windows | A prebuilt release zip, CUDA build matched to your driver if you have an NVIDIA GPU | CUDA (NVIDIA), or BLAS-accelerated CPU otherwise |
| Linux | A prebuilt CPU binary, or built from source with `cmake` (needs `cmake`, `git`, a C++ compiler) if you have an NVIDIA GPU | CUDA if `nvidia-smi` finds a card, else CPU |

whisper.cpp ships no Vulkan build for any platform, so a non-NVIDIA GPU
(AMD, Intel) doesn't get hardware acceleration — Windows falls back to a
BLAS-accelerated CPU build, which is still faster than plain CPU.

By default it installs **locally**, alongside this install of vno, under
`whisper-cpp/`. Pass `--global` to install once under your home directory
(`~/.whisper-cpp/` on macOS/Linux, `%LOCALAPPDATA%\whisper-cpp\` on Windows)
instead — useful if you run vno from more than one place and don't want to
redownload a multi-gigabyte model set per install. Either way, the layout is
the same:

```
whisper-cpp/
├── bin/          # the whisper.cpp binary (+ its .dll/.so files, when vendored)
├── models/       # ggml-*.bin model files
└── install.json  # what setup found or built: version, platform, binary path, accelerator, models
```

Re-running `vno setup` is safe and fast — it only re-resolves what's already
there and downloads nothing it doesn't need to. `vno setup --list-models`
prints the model inventory (what's present, where, how big, whether it
validates) without installing or downloading anything.

Already have a whisper.cpp binary from somewhere else — a manual build, a
different tool that vendors one? When `vno setup` asks where to install,
choose **"I already have it installed"** and give it a path (the binary
itself, or a folder to search). Nothing is copied; the path is recorded in
`install.json` and used in place.

## GPU acceleration

Unlike the old Python/PyTorch path, whisper.cpp's accelerator backend is
fixed by **which binary got installed**, not chosen per run — a Homebrew
install is Metal-accelerated, a Windows CUDA build is accelerated, a
CPU/BLAS-only build is not, and nothing about that changes at transcription
time. On Windows, the CUDA build is picked by asking `nvidia-smi` what CUDA
runtime your **driver** supports (not whether a CUDA toolkit is installed —
most machines don't have one, and don't need one: the zip bundles its own
runtime DLLs). `vno setup` names what it found or built and asks once
whether to use it:

```
Found NVIDIA GeForce RTX 3060 Laptop GPU acceleration (cuda).
? Use the accelerator for transcription? It's several times faster than the CPU.
```

The answer is remembered in [`accel`](configuration.md#accel). Turning it off
doesn't uninstall anything — it just passes `-ng` (no-GPU) to force the CPU
even on an accelerator-capable build. Toggle it from `vno setting` or the
UI's Settings dialog any time.

If an accelerated run fails part-way (a driver issue, not enough VRAM for the
model), vno says so, redoes that file on the CPU, and finishes the run on the
CPU:

```
Accelerator run failed: ggml_cuda_init: no CUDA-capable device is detected
Falling back to the CPU for the rest of this run.
```

## Transcribe vs. translate

| | Task | Result |
| --- | --- | --- |
| **Transcribe** *(default)* | `transcribe` | Verbatim, in the language spoken |
| **Translate** | `translate` | English, whatever was spoken |

Translation is whisper.cpp's own task, done in the same pass — not a second step,
and not a separate service. It costs the same time as a transcription.

Reach it with `--translate` on the CLI, the *translate to English* checkbox in
the UI, or automatically on every import via
[`autoTranslate`](configuration.md#autotranslate).

**You get one file either way.** Translating replaces the verbatim transcript;
it doesn't sit alongside it. If you want both, transcribe first, rename the
`.vtt`, then translate.

## The output: one `.vtt` per recording

A single timed WebVTT file is written next to the audio:

```
260725_0126.mp3
260725_0126.vtt
```

```
WEBVTT

00:00:00.000 --> 00:00:30.000
Another thing which I would like to do for the tinker note…

00:00:30.000 --> 00:00:58.000
like that I would have to check that if double tap is allowed…
```

Why VTT and nothing else:

- **It's plain text.** Readable in any editor, greppable, diffable, and
  survives this tool being abandoned. No database, no lock-in.
- **The timings drive the follow-along highlight** in the [browser
  UI](ui.md) — the current line highlights and scrolls as it plays, and
  clicking a line seeks to it.

`.srt` and `.txt` files are still **read** if you have them from elsewhere
(a `.txt` displays without the follow-along highlight), and they're cleaned up
alongside their audio on delete. But whisper.cpp only ever writes `.vtt`.

Transcripts are looked up by name: `<same-stem>.vtt`, then `.srt`, then `.txt`.
Rename an audio file and you must rename its transcript to match, or the note
will look untranscribed.

## Editing transcripts

Transcription gets names, jargon and homophones wrong. Fix them in the [UI's
transcript editor](ui.md#transcript-editor) — one box per cue, timings
untouched, `Ctrl`/`Cmd`+`Enter` to save. Or edit the `.vtt` in any text editor;
the UI picks up the change on reload.

> ⚠️ **Re-transcribing overwrites your edits.** whisper.cpp writes straight over
> the `.vtt`. The re-transcribe picker asks for confirmation on already-
> transcribed files for exactly this reason — but once confirmed, hand-edits
> are gone.

## Re-transcribing

Worth doing when the first pass was on a small model, the audio was
misdetected as the wrong language, or you want a translation of something you
transcribed verbatim.

```bash
vno transcribe -f                    # picker lists every take, incl. transcribed
vno transcribe -f 250810_1328        # one specific file, no picker
vno transcribe -f 250810_1328 -m large --translate
```

Or use **Re-transcribe** on the take in the UI.

## Batching a backlog

Transcription is single-file. For a large backlog:

1. Set `defaultModel` to something you can live with (`turbo`, or `small` if
   the machine is modest).
2. Start it and walk away — `vno transcribe`, `Ctrl+A`, `Enter`.
3. Individual failures are logged and the batch carries on, so one corrupt file
   doesn't cost you the run.

If you'd rather it not open a browser at the end, pass `--no-open`.

---

[← Back to the docs index](README.md) · [The browser UI](ui.md) · [Troubleshooting](troubleshooting.md)
