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

## Picking a model: vno's catalog, or bring your own

`vno setup --llama` offers a curated, checksum-verified pick list of small
"edge" instruct models — the same idea as whisper's model picker. Models are
grouped into size tiers (sub-1GB, 1-2GB, 2-4GB, 4-6GB) and it's a **checkbox**,
so you can install more than one and switch between them later:

```
── Tier 1 — sub-1GB ──
 ◉ Qwen 3.5 0.8B — ~533 MB
 ◯ LFM 2.5 1.2B Instruct — ~731 MB
 ◯ Llama 3.2 1B Instruct — ~808 MB

── Tier 2 — 1-2GB ──
 ◯ Qwen 3.5 2B — ~1280 MB
 ...
```

Pick one or several and each is downloaded (URL printed to the console as it
starts, same as whisper's models) and, for every catalog entry that ships a
known SHA-256, verified once right after the download finishes — never on a
later scan, so a multi-gigabyte model isn't re-hashed every time vno starts.
A checksum that doesn't match is **never deleted automatically**: you're
shown the expected/actual hashes and asked whether to keep the file (default)
or delete it and retry — it could just as easily be a stale entry in vno's
own catalog as real corruption. A model with no checksum on file (yours, or
an older catalog entry) skips the check entirely rather than failing closed.

You don't have to use the catalog. Whatever the picker offers, `vno setup
--llama` also creates a plain folder and prints its path:

```
llama-cpp/
└── models/       # drop your own .gguf file(s) in here too
```

Drop any `.gguf` file into that folder (or point the `VNO_LLAMA_MODEL_PATH`
env var at one) and it's discovered automatically — `vno setup --list-models`
shows it, validated only for readability and the GGUF magic bytes (no
catalog, no checksum — it's your file, your responsibility). Get one from
wherever you like, e.g. [Hugging Face's GGUF models](https://huggingface.co/models?library=gguf)
— a small instruct model (2-5 GB, Q4_K_M quant) summarizes reasonably on CPU.
Avoid "thinking"/reasoning variants — they write a long chain of thought to
stdout before the actual answer, which doesn't fit a `.summary.txt` sidecar.

Set your default with `vno setting` → *Summarization model* (only shown once
at least one model is present) or the UI's Settings dialog, or fetch one
non-interactively:

```bash
vno setup --summary-model qwen3.5-2b              # a catalog alias — downloads it
vno setup --summary-model my-model-Q4_K_M.gguf    # a file already in your models folder — just confirms it's there
```

Either way this only fetches/confirms the file — it doesn't change
`summaryModel`; set your default from `vno setting` or the Settings dialog.
Delete models you no longer want the same way as whisper's:

```bash
vno setup --remove-model                              # picker over everything installed
vno setup --remove-model my-model-Q4_K_M.gguf
```

Both whisper and summarization models show up in the picker with their
sizes. Deletion is confirmed, defaults to *no*, and only touches files inside
vno's own local/global `models/` folders. If you delete the model
`summaryModel` points at, the setting is cleared.

`vno status` and plain `vno setup` show summarization as two informational
lines — never a blocker, since it's optional:

```
  ? llama.cpp     optional, for transcript summarization — run `vno setup --llama`
```

or, once installed:

```
  ✓ llama.cpp     /path/to/llama-cli
  ✓ llama models
      gemma-4-E2B-it-Q4_K_M.gguf   /path/to/models/gemma-4-E2B-it-Q4_K_M.gguf
```

## Overriding the prompt

Settings' Summarization section has an *Override prompt* field — replaces the
built-in instruction wholesale for every summary. Leave it blank to use the
default (shown as the field's placeholder). Stored as
[`summaryPrompt`](configuration.md#summaryprompt).

## Hiding the Summary tab

Settings' Summarization section has a *Show the Summary tab in the deck*
toggle — off hides the **Summary** tab (and the Summarize button) from the
deck entirely, for anyone who'd rather not see it. It's purely a UI switch:
existing `.summary.txt` files are never touched, and turning it back on
brings them straight back into view. Stored as
[`summaryEnabled`](configuration.md#summaryenabled).

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
