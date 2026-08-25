# Summarization (optional)

Summarization is [llama.cpp](https://github.com/ggml-org/llama.cpp), running
**locally** the same way transcription does — a vendored binary, no Python, no
account, no upload. Unlike whisper.cpp, it's **entirely optional**: nothing in
vno requires it, and the app behaves exactly as it always did if you never set
it up.

## Installing llama.cpp

```bash
vno setup --llama
```

`vno setup` on its own asks too — once, only if llama.cpp isn't installed yet
— right after it finishes with ffmpeg/whisper.cpp:

```
? Set up llama.cpp for optional transcript summarization? (Use arrow keys)
  Yes, set it up now
❯ Not now
```

Say no and nothing installs; you're asked again the next time you run
`vno setup` with it still missing. `--llama` skips straight past the question.
Either way, installing the binary walks you through picking a summarization
model next — a short list of curated models to download, or a `.gguf` file
you already have. Nothing downloads without that explicit choice.

| Platform | How | Accelerator |
| --- | --- | --- |
| macOS | `brew install llama.cpp` | Metal, automatically, on Apple silicon |
| Windows | A prebuilt release zip, CUDA build matched to your driver if you have an NVIDIA GPU | CUDA (NVIDIA), or a CPU build otherwise |
| Linux | A prebuilt CPU binary, or built from source with `cmake` if you have an NVIDIA GPU | CUDA if `nvidia-smi` finds a card, else CPU |

By default it installs **locally**, alongside this install of vno, under
`llama-cpp/` — the same construct as whisper.cpp's `whisper-cpp/`, just its
own root and its own `vno-install.json` (the file's `description` field says
what it's for, so the two are easy to tell apart if you ever open one).
`--global` puts it under your home directory instead. The layout:

```
llama-cpp/
├── bin/          # the llama.cpp binary (+ its .dll/.so files, when vendored)
├── models/       # .gguf model files
└── vno-install.json  # what setup found or built: version, platform, binary path, accelerator, models
```

**Bring your own model.** Drop any `.gguf` file into `llama-cpp/models/`
(local or global root) and it's discovered automatically — `vno setup
--list-models` shows it alongside the curated ones, validated the same way
(magic bytes, and a size check for the curated aliases only). There's no
catalog you're limited to.

Already have a llama.cpp binary from somewhere else? When `vno setup --llama`
asks where it should come from, choose **"I already have it installed"** and
give it a path. Nothing is copied.

Re-run `vno setup --llama` any time to pick a different model, or fetch one
non-interactively:

```bash
vno setup --summary-model phi4-mini
```

Models are the one thing here that grows without bound — a couple of whisper
models plus a summarization GGUF is comfortably 10 GB — so they can be
deleted again:

```bash
vno setup --remove-model                       # picker over everything installed
vno setup --remove-model gemma-4-E2B-it-Q4_K_M.gguf
```

Both whisper and summarization models show up in the picker with their sizes.
Deletion is confirmed, defaults to *no*, and only touches models vno
installed itself — see [the CLI reference](cli-reference.md#vno-setup-doctor).
If you delete the model `summaryModel` points at, the setting is cleared.

`vno status` and plain `vno setup` show summarization as one informational
line — never a blocker, since it's optional:

```
  ? summarize    optional, not installed — run `vno setup --llama`
```

## Choosing a model

`vno setup --llama` offers a short starting set — small instruct models that
run reasonably on CPU:

| Alias | Size (Q4_K_M) | Notes |
| --- | --- | --- |
| `phi4-mini` | ~2.5 GB | 131K context — the smallest of these, and a good default |
| `gemma4-e2b` | ~3.1 GB | 131K context |
| `gemma4-e4b` | ~5.0 GB | 131K context |
| `qwen2.5-3b` | ~2.1 GB | |
| `llama3.2-3b` | ~2.0 GB | |

Summarizing a transcript leans on instruction-following and context length
rather than raw parameter count, so the list is ordered smallest-first — the
top entry is a fine place to start, and there's little reason to sit through a
bigger download unless you've tried one and want better prose. Reasoning
models (`Phi-4-mini-reasoning`, the Qwen3 `*-Thinking` builds, and friends)
are deliberately not here: they write their chain of thought to stdout, which
is the wrong shape for something saved straight into a `.summary.txt`.

Each curated download is verified against a known SHA-256 (read straight off
Hugging Face's own `X-Linked-ETag` header for that file, not guessed) rather
than just a size check — a truncated or corrupted download is rejected and
retried even if it happens to land close to the expected byte count.

Set your default with `vno setting` → *Summarization model* (only shown once
at least one model is installed) or the UI's Settings dialog. It's stored as
[`summaryModel`](configuration.md#summarymodel). Override per run with
`vno summarize -m <name>`.

## Using it

**In the browser UI:** select a transcribed recording, click **Summarize** in
the deck. The job runs in the background (same progress strip as
transcription); when it finishes, switch to the **Summary** tab next to
**Transcript** to read it. Clicking Summarize before llama.cpp is set up shows
a small explanation instead of erroring.

**On the command line**, one recording at a time — no picker, no batch mode:

```bash
vno summarize 250810_1328
vno summarize interview.mp3 -m phi4-mini
```

The recording needs a transcript first (`vno t`) — summarization reads the
transcript text, it doesn't touch the audio.

## The output: one `<name>.summary.txt` per recording

```
260725_0126.mp3
260725_0126.vtt
260725_0126.summary.txt
```

Plain text, same "readable in any editor, survives this tool being
abandoned" reasoning as `.vtt`. Re-summarizing overwrites it; deleting the
recording removes it along with the transcript.

## Scope

- **One recording at a time.** There's no batch/mass-summarize mode.
- **Long transcripts are truncated** to fit the model's context window rather
  than summarized in chunks — a v1 limitation, not a bug.
- The model runs against a fixed instruction ("summarize this transcript in a
  few sentences") — there's no custom-prompt UI yet.

---

[← Back to the docs index](README.md) · [Transcription](transcription.md) · [The browser UI](ui.md)
