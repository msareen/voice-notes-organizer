# Summarization (optional)

Summarization is [llama.cpp](https://github.com/ggml-org/llama.cpp), running
**locally** the same way transcription does — no Python, no account, no
upload. Unlike whisper.cpp, it's **entirely optional**: nothing in vno
requires it, and the app behaves exactly as it always did if you never set it
up.

Unlike whisper.cpp, vno doesn't install or manage the binary itself — the OS
package manager does, and you manage your own model files. This keeps the
whole thing bare and easy to reason about.

## Installing llama.cpp

```bash
vno setup --llama
```

`vno setup` on its own asks too — once, only if llama.cpp isn't installed yet
— right after it finishes with ffmpeg/whisper.cpp. Say no and nothing
installs; you're asked again the next time you run `vno setup` with it still
missing. `--llama` skips straight past the question.

| Platform | How |
| --- | --- |
| macOS | `brew install llama.cpp` (Metal-accelerated automatically on Apple silicon) |
| Windows | `winget install --id ggml.llamacpp` |
| Linux | Not automated — install it yourself (your distro's package manager, or build from source), then either open a new terminal or give `vno setup --llama` the binary's path |

If the install succeeds but the binary isn't visible on this shell's PATH yet
(common right after a fresh `winget install`), `vno setup --llama` asks for
the path directly and remembers it in config (`llamaCliPath`) rather than
re-probing PATH forever — open a new terminal first if you'd rather it find
the binary itself.

## Bring your own model

vno never downloads a summarization model for you. `vno setup --llama` asks
whether your models should live locally (beside this vno install) or
globally (under your home directory), creates that folder, and prints its
path:

```
llama-cpp/
└── models/       # drop your .gguf file(s) in here
```

Drop any `.gguf` file into that folder (or point the `VNO_LLAMA_MODEL_PATH`
env var at one) and it's discovered automatically — `vno setup --list-models`
shows it, validated only for readability and the GGUF magic bytes (no
catalog, no checksum — it's your file). Get one from wherever you like, e.g.
[Hugging Face's GGUF models](https://huggingface.co/models?library=gguf) —
a small instruct model (2-5 GB, Q4_K_M quant) summarizes reasonably on CPU.
Avoid "thinking"/reasoning variants — they write a long chain of thought to
stdout before the actual answer, which doesn't fit a `.summary.txt` sidecar.

Set your default with `vno setting` → *Summarization model* (only shown once
at least one model is present) or the UI's Settings dialog, or point at one
non-interactively:

```bash
vno setup --summary-model my-model-Q4_K_M.gguf
```

This only checks the file is there — it never downloads. Delete models you no
longer want the same way as whisper's:

```bash
vno setup --remove-model                              # picker over everything installed
vno setup --remove-model my-model-Q4_K_M.gguf
```

Both whisper and summarization models show up in the picker with their
sizes. Deletion is confirmed, defaults to *no*, and only touches files inside
vno's own local/global `models/` folders. If you delete the model
`summaryModel` points at, the setting is cleared.

`vno status` and plain `vno setup` show summarization as one informational
line — never a blocker, since it's optional:

```
  ? summarize    optional, not installed — run `vno setup --llama`
```

## Overriding the prompt

Settings' Summarization section has an *Override prompt* field — replaces the
built-in instruction wholesale for every summary. Leave it blank to use the
default (shown as the field's placeholder). Stored as
[`summaryPrompt`](configuration.md#summaryprompt).

## Using it

**In the browser UI:** select a transcribed recording, click **Summarize** in
the deck. The job runs in the background (same progress strip as
transcription); when it finishes, switch to the **Summary** tab next to
**Transcript** to read it. Clicking Summarize before llama.cpp is set up shows
a small explanation instead of erroring.

**On the command line**, one recording at a time — no picker, no batch mode:

```bash
vno summarize 250810_1328
vno summarize interview.mp3 -m my-model-Q4_K_M.gguf
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

---

[← Back to the docs index](README.md) · [Transcription](transcription.md) · [The browser UI](ui.md)
