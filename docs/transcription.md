# Transcription

Transcription is [OpenAI Whisper](https://github.com/openai/whisper), running
**locally** on your machine. No account, no upload, no per-minute cost.

> *Whisper is slow — but it is free.* A long recording on a big model can take
> longer than the recording itself. That's the trade you're making.

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

Models download themselves on first use (a few hundred MB to ~3 GB depending on
size) and are cached by whisper afterwards. The first run of a new model will
sit there apparently doing nothing while it downloads — that's expected.

## Transcribe vs. translate

| | Task | Result |
| --- | --- | --- |
| **Transcribe** *(default)* | `transcribe` | Verbatim, in the language spoken |
| **Translate** | `translate` | English, whatever was spoken |

Translation is whisper's own task, done in the same pass — not a second step,
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
alongside their audio on delete. But whisper only ever writes `.vtt`.

Transcripts are looked up by name: `<same-stem>.vtt`, then `.srt`, then `.txt`.
Rename an audio file and you must rename its transcript to match, or the note
will look untranscribed.

## Editing transcripts

Whisper gets names, jargon and homophones wrong. Fix them in the [UI's
transcript editor](ui.md#transcript-editor) — one box per cue, timings
untouched, `Ctrl`/`Cmd`+`Enter` to save. Or edit the `.vtt` in any text editor;
the UI picks up the change on reload.

> ⚠️ **Re-transcribing overwrites your edits.** Whisper writes straight over
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

Whisper is single-file and CPU-bound. For a large backlog:

1. Set `defaultModel` to something you can live with (`turbo`, or `small` if
   the machine is modest).
2. Start it and walk away — `vno transcribe`, `Ctrl+A`, `Enter`.
3. Individual failures are logged and the batch carries on, so one corrupt file
   doesn't cost you the run.

If you'd rather it not open a browser at the end, pass `--no-open`.

---

[← Back to the docs index](README.md) · [The browser UI](ui.md) · [Troubleshooting](troubleshooting.md)
