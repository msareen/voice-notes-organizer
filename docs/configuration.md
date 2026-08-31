# Configuration

Settings live in one global per-user file:

```
~/.vno/config.json
```

On Windows that's `C:\Users\<you>\.vno\config.json`. `vno config` prints the
exact path.

The file is created with defaults the first time you run `vno`. If it ever
becomes corrupt, it's backed up to `config.json.bak-<timestamp>` and recreated
rather than crashing the tool.

```json
{
  "target": "/path/to/voice-notes",
  "sources": [
    { "path": "/mnt/nas/voice-notes", "pattern": "*", "recursive": false, "deleteAfterImport": false, "mapTo": null }
  ],
  "knownMounts": {},
  "autoTranslate": null,
  "defaultModel": "turbo",
  "transcribeLanguage": "auto",
  "openWhenDone": true,
  "rememberDeletions": true,
  "theme": "tape",
  "accel": { "backend": null, "name": null, "use": null, "resolvedAt": null },
  "summaryModel": null,
  "summaryEnabled": true,
  "llamaAccel": { "backend": null, "name": null, "use": null, "resolvedAt": null },
  "summaryPrompt": null,
  "llamaCliPath": null
}
```

`config.json` isn't the only file in `~/.vno`: deletions are recorded next to
it in [`deleted.json`](#rememberdeletions), which you can throw away at any
time.

## What can change what

| Setting | `vno setting` | UI Settings | Edit the file |
| --- | :---: | :---: | :---: |
| `target` | ✅ | shown only | ✅ |
| `sources` | ✅ | ✅ | ✅ |
| `knownMounts` | reset all | per-volume, on import | ✅ |
| `autoTranslate` | ✅ | ✅ | ✅ |
| `defaultModel` | ✅ | ✅ | ✅ |
| `transcribeLanguage` | ✅ | ✅ | ✅ |
| `crossLanguage` | ✅ | ✅ | ✅ |
| `decode` | ✅ | ✅ | ✅ |
| `openWhenDone` | ✅ | ✅ | ✅ |
| `rememberDeletions` | ✅ | ✅ | ✅ |
| `port` | ✅ | — (see below) | ✅ |
| `theme` | ✅ | ✅ | ✅ |
| `accel` | on/off only | on/off only | ✅ (set by `vno setup`) |
| `summaryModel` | ✅ (once installed) | ✅ (once installed) | ✅ |
| `summaryEnabled` | — | ✅ | ✅ |
| `llamaAccel` | on/off only | on/off only | ✅ (set by `vno setup --llama`) |
| `summaryPrompt` | — | ✅ | ✅ |
| `llamaCliPath` | — | — | ✅ (set by `vno setup --llama` when asked) |

---

## `target`

Where imported and synced audio files land, and the folder every command
scans.

Defaults to a `voice-notes` folder inside whatever directory you first ran
`vno` from. Change it with `vno setting`, or by editing this file.

> Moving the target doesn't move your existing recordings — copy them across
> yourself if you want them to follow.

## `sources`

An array of folders to import from **in addition** to auto-detected removable
volumes. Use it for network shares, drives that are already mounted and won't
show up as "removable" (an internal disk, a permanently attached USB HDD), or
a landing folder a phone's Quick Share/Quick Send drops files into (typically
Downloads).

```json
"sources": [
  { "path": "/mnt/nas/voice-notes", "pattern": "*", "recursive": true, "deleteAfterImport": false, "mapTo": null },
  { "path": "D:\\Users\\me\\Downloads", "pattern": "VN*.m4a", "recursive": false, "deleteAfterImport": true, "mapTo": "Phone" }
]
```

| Field | Meaning |
| --- | --- |
| `path` | Folder to sync from |
| `pattern` | `"*"`/`"?"` wildcard against the filename. `"*"` (default) means "any audio-extension file", same as a detected volume |
| `recursive` | Also scan subfolders of `path`. `false` by default — only `path` itself is scanned, since a source is usually a flat drop point. Turn it on for a folder whose recordings are nested in subfolders |
| `deleteAfterImport` | Once a file is safely copied into `target` (or found to already be there), delete it from this folder. `false` by default. Only turn this on for a disposable landing folder — the original is expected to live somewhere else (e.g. still on the phone), not just here |
| `mapTo` | Optional folder *inside* `target` this source's files land in, instead of the default folder named after `path`'s basename — e.g. `"Phone"` or a nested `"Work/Meetings"`. `null` (default) keeps the default naming. Always resolved relative to `target` and can never escape it, however it's written — set it with `vno setting` or the UI's folder browser rather than hand-editing this if you're not sure |

Add as many as you like. Every entry is synced into `target` on every
`vno import` run **without prompting** — it was explicitly configured, so it's
trusted. They also appear in the UI's import dialog, marked
*(configured source)* and checked by default, with the pattern/delete state
shown alongside.

If two sources (or a source and a detected volume) share the same folder name,
the later one is disambiguated with its parent folder name — e.g.
`Recordings (deviceB)` — so they don't land in the same destination folder.
A source with `mapTo` set skips this disambiguation entirely — an explicit
mapping is trusted as intentional, including two sources sharing the same
`mapTo` to consolidate into one folder.

A `deleteAfterImport` source never touches the [deletion ledger](#rememberdeletions)
— it only reads it, to avoid deleting the source copy of a file whose imported
copy you deliberately removed from `target` before. See
[Import & sync](import-and-sync.md#source-folders) for the exact rule.

Older configs with plain path strings (e.g. `"sources": ["/mnt/nas"]`) still
load fine — they're normalized to
`{ path, pattern: "*", recursive: false, deleteAfterImport: false, mapTo: null }` on read.
That's a behavior change from before `recursive` existed (everything was
scanned recursively); re-enable it per source if you relied on that.

Add, edit or remove entries with `vno setting` → *Source folders*, from the
UI's Settings dialog, or by editing this file directly.

## `knownMounts`

Remembers, per detected volume, whether to auto-import it, which subfolder (if
any) to sync from, and when it was last synced — so you're only asked once per
volume. There's no limit to how many volumes are tracked.

```json
"knownMounts": {
  "ic recorder": {
    "name": "IC RECORDER",
    "autoImport": true,
    "sourceSubdir": "PRIVATE/SONY/VOICE/FOLDER01",
    "lastSynced": "2026-07-25T08:14:02.001Z",
    "lastResult": { "copied": 4, "skipped": 112, "total": 116 }
  }
}
```

Volumes are keyed by their **label**, not their drive letter or mount path —
drive letters shuffle between reconnects, labels don't.

Edit this file directly to change a volume's remembered `sourceSubdir`, or set
`autoImport` to `false` to have a volume silently skipped. `vno setting` can
forget all remembered volumes at once, which makes the next import ask fresh.

See [Import & sync](import-and-sync.md) for the detection rules.

## `autoTranslate`

Whether freshly imported notes are auto-translated to English on import, using
whisper.cpp's translate task.

| Value | Behaviour |
| --- | --- |
| `null` *(default)* | Not decided yet — `vno` asks once and stores your answer here |
| `true` | Translate every import, without asking |
| `false` | Never translate on import |

Flip it, or reset it back to `null`, from `vno setting` or the UI's Settings
dialog.

## `defaultModel`

The whisper.cpp model used for auto-translation, and pre-selected in the
`vno transcribe` picker and the UI's transcribe dialog.

One of `turbo`, `tiny`, `base`, `small`, `medium`, `large`. Defaults to
`turbo`. See [Transcription](transcription.md#choosing-a-model) for how to
choose.

## `transcribeLanguage`

The language whisper.cpp is told to expect, as an ISO-639-1 code (`"hi"`,
`"en"`, ...), or `"auto"` (the default) to let it detect per file.

Worth pinning if you speak two languages whisper.cpp's auto-detect confuses
for one another — Hindi and Urdu are acoustically close enough that
auto-detect can flip between them file to file. Setting this to `"hi"` fixes
that, and still transcribes English words mixed into Hindi speech fine, so
it also covers a "mostly Hindi with some English" preference. `vno setting`
offers Hindi/English/auto plus a custom code; the UI's Settings dialog lists
every language whisper.cpp knows.

The trade-off is that a pin applies to every recording, including the ones
that really are in another language. [`crossLanguage`](#crosslanguage) below
is the softer version. When both are set, the pin wins.

## `crossLanguage`

Guides auto-detect instead of overriding it.

```json
"crossLanguage": {
  "model": "small",
  "map": { "ur": "hi" }
}
```

**`model`** is the whisper model used for a `-dl` detection pass that runs
before each transcription, or `null` (the default) for off — with it off
there is no extra pass and nothing here has any effect. `"small"` is a good
choice: it's one of the two models `vno setup` installs, and the pass takes
roughly 1.5 seconds. A model that isn't installed is not an error — the run
logs that it's skipping detection and carries on with plain auto-detect.

**`map`** rewrites what that pass returns. `{ "ur": "hi" }` means "when it
detects Urdu, transcribe as Hindi". A detected language with no entry is used
as detected, so this doesn't disturb recordings in other languages. Keys and
values are whisper.cpp language codes; unknown codes, `"auto"`, and identity
pairs are dropped when the config is read.

Only consulted when `transcribeLanguage` is `"auto"`. Editable from
`vno setting` → *Cross-language detection* and the UI's Settings dialog, both
of which set `transcribeLanguage` back to `"auto"` when you pick a model.
See [Transcription](transcription.md#or-guide-the-detection) for why this
exists and what the alternative costs.

## `decode`

How hard vno works to get a clean transcript out of whisper.cpp.

```json
"decode": {
  "mode": "adaptive",
  "manual": {
    "vad": false,
    "vadThreshold": null,
    "carryContext": null,
    "entropyThold": null,
    "logprobThold": null,
    "noSpeechThold": null,
    "beamSize": null,
    "bestOf": null,
    "temperatureInc": null,
    "flashAttn": null,
    "suppressNst": false
  }
}
```

whisper invents text sometimes — most often one sentence repeated across a
stretch of silence — and how often it does depends on the machine: the same
recording can come out clean on a Windows GPU and as a wall of repeats on a
Mac. There is no single flag that fixes it, so this is a choice between three
strategies.

**`mode`** is the master switch.

| Mode | What it does |
| --- | --- |
| `"adaptive"` *(default)* | Transcribes exactly as `auto` would, reads the `.vtt` back, and only if it finds a loop signature does it retry on progressively safer settings |
| `"auto"` | One pass on whisper.cpp's own defaults. Never retried. What vno did before this setting existed |
| `"manual"` | One pass on the flags in `manual` below. No checking, no retry |

`adaptive` is the default because its first attempt *is* `auto` — a recording
that transcribes cleanly costs exactly what it always did, and only a file
that actually trips a detector pays for a retry. Its ladder is, in order:
drop cross-window context and tighten the fallback thresholds; then also
disable flash attention; then fall back to `large-v3` (skipped, with a note in
the log, if that model isn't downloaded — a transcription run will never start
a 3.1 GB fetch — or if it's the model you were already using, since the point
of that rung is the change of model). A retry replaces the
previous attempt only if it looks *better*, so escalating can't cost you a
transcript you'd have been happy with. If nothing helps, you keep the best of
the attempts and the log says plainly that it still looks wrong.

**`manual`** is ignored unless `mode` is `"manual"`. Every rung of the
adaptive ladder is expressible here, which is the point: it's for finding out
which single flag your machine needs.

| Key | whisper.cpp flag | What it's for |
| --- | --- | --- |
| `carryContext` | `-mc 0` when `false` | Whether each 30-second window is decoded knowing what the last one said. Turning it **off** is the single most effective thing against repetition loops — a loop can no longer feed itself into the next window |
| `flashAttn` | `-fa` / `-nfa` | On by default in whisper.cpp. Its Metal implementation is the usual suspect when output is broken on a Mac and fine on the same file elsewhere; turning it off costs speed and nothing else |
| `vad` | `--vad` | Run Silero voice-activity detection first, so silence never reaches the decoder. Silence is where invented text comes from |
| `vadThreshold` | `-vt` | How confident the detector must be to call something speech |
| `entropyThold` | `-et` | Entropy above which a window is retried at a higher temperature. Lower retries sooner |
| `logprobThold` | `-lpt` | Average log-probability below which a window is retried |
| `noSpeechThold` | `-nth` | No-speech probability above which a window is dropped |
| `beamSize` / `bestOf` | `-bs` / `-bo` | Search width and candidates per window. Wider is slower |
| `temperatureInc` | `-tpi`, or `-nf` when `0` | Temperature step for the fallback ladder; `0` disables fallback entirely |
| `suppressNst` | `-sns` | Suppress non-speech tokens, which is where `[music]`-style inventions start |

**`null` means "pass no flag at all"** — whisper.cpp uses its own default,
which is not the same as vno remembering that default. That matters because
`-bs`/`-bo` read their defaults from the library and those have changed
between whisper.cpp releases; storing today's numbers would quietly pin them
across an upgrade. It also means a `manual` block you haven't touched behaves
exactly like `auto`, which is the right place to start tuning from. `vad` and
`suppressNst` are plain on/off, since "don't pass the flag" and "off" are the
same thing for those.

Speech detection needs a small extra model (`ggml-silero-v5.1.2.bin`, under a
megabyte), which `vno setup` fetches alongside the transcription models. If
it's missing, `--vad` is quietly dropped rather than failing the run.

Editable from `vno setting` → *Transcription quality* and the UI's Settings
dialog, which show the individual flags only in `manual` mode. `vno t <file>
--decode <mode>` overrides `mode` for a single run without changing anything
here — the fastest way to compare a suspect recording against `auto`.

## `accel`

What [`vno setup`](cli-reference.md#vno-setup-doctor) installed for
whisper.cpp's accelerator backend, and what you want done with it.

```json
"accel": {
  "backend": "cuda",
  "name": "NVIDIA GeForce RTX 3060 Laptop GPU",
  "use": true,
  "resolvedAt": "2026-07-26T17:17:54.246Z"
}
```

| Field | Meaning |
| --- | --- |
| `backend` | What `vno setup` installed. `null` = whisper.cpp not installed yet, `"cpu"` = installed, no accelerator build available, `"cuda"`/`"metal"`/`"vulkan"` = installed with that backend |
| `name` | The card, for display (not set for Metal, which doesn't need naming) |
| `use` | Your answer. `null` = never asked, `true`/`false` = decided |
| `resolvedAt` | When `vno setup` last recorded this |

The answer that matters is `backend !== "cpu" && backend !== null && use !== false`
— an accelerator-capable install is used unless you've said no, since the
browser has nowhere to ask at job time.

Unlike the old torch probe, this never needs re-checking on a hot path: the
backend is fixed by which whisper.cpp binary got installed, and reading
`vno-install.json` back is free. Nothing depends on this block being present:
delete it, or the whole file, and every command still runs (falling back to
the CPU until the next `vno setup`).

Toggle it from `vno setting` or the UI's Settings dialog; re-install with a
different backend (e.g. after adding a GPU) by running `vno setup` again. See
[Transcription](transcription.md#gpu-acceleration).

## `summaryModel`

The llama.cpp model used for transcript summarization — a dropped-in `.gguf`
filename you placed in your models folder yourself (see
[Summarization](summarization.md)). `null` until you set one; unlike
`defaultModel` there's no forced default, since summarization is entirely
optional and unset just means "not configured yet".

Set from `vno setting` → *Summarization model* (shown only once at least one
model is present) or the UI's Settings dialog.

## `summaryEnabled`

Whether the deck shows a **Summary** tab and **Summarize** button at all.
`true` by default (or unset — same thing); set to `false` to hide them.
Purely a UI switch: existing `.summary.txt` files are untouched either way,
and flipping it back to `true` brings them straight back into view. Set from
the UI's Settings dialog (*Show the Summary tab in the deck*). See
[Summarization](summarization.md#hiding-the-summary-tab).

## `llamaAccel`

llama.cpp's accelerator backend, mirroring [`accel`](#accel) exactly but
independent of it — whisper.cpp and llama.cpp are installed separately, so a
machine can be accelerated for one and not the other. Unlike `accel`,
llama.cpp's backend isn't detected (there's no vno-picked binary variant to
read it from) — it's whatever you answer when `vno setup --llama` asks
whether your build has GPU acceleration.

## `llamaCliPath`

Manual override for where the llama.cpp binary lives, for when a fresh
`winget install`/`brew install` isn't visible on PATH in the same shell
session. `null` means "trust PATH". Set automatically when `vno setup
--llama` asks for the path after an install; editable by hand.

## `summaryPrompt`

Replaces the built-in summarization instruction wholesale when set. `null`
(the default) means "use the built-in one" — a whitespace-only value is
treated the same way. Set from the UI's Settings dialog (*Override prompt*).

## `openWhenDone`

Whether a finished `vno import` / `vno transcribe` run launches the
[browser UI](ui.md). `true` by default; set it to `false` to keep runs
headless.

`--no-open` overrides it for a single run.

---

## `port`

The port the [browser UI](ui.md) serves on. `9477` by default — chosen to sit
clear of the `8385–8484` block Windows commonly reserves for Hyper-V, which is
where the previous default (`8477`) fell.

The port is deliberately fixed rather than picked fresh each launch, so a
bookmarked URL and an installed PWA's `start_url` — baked in at install time
— keep working. This setting exists because the default isn't always usable:
some machines can't bind it at all, most often on Windows, where whole TCP
ranges are reserved for Hyper-V's dynamic allocator (WSL2, Docker Desktop)
and a bind inside one fails as *"already in use"* with nothing listening.
See [Troubleshooting](troubleshooting.md#port-is-already-in-use--but-nothing-is-using-it-windows).

Set it from `vno setting` → *Viewer port*, or edit the file. `0` asks the OS
for a free port on every run — convenient, but it gives up the stable URL.
`-p/--port` overrides it for a single run without changing the setting.

It's deliberately **not** in the UI's Settings dialog: the page you'd change
it from is served on the very port being changed, so applying it would drop
the connection out from under you. It's a terminal setting.

Changing the port does **not** update an already-installed PWA shortcut;
reinstall the app from the new URL to pick it up.

---

## `theme`

Which colour theme the [browser UI](ui.md#settings) wears. One of:

| Value | Looks like |
| --- | --- |
| `auto` | Follows your system's light/dark setting (Tape after dark, Daylight in the light) |
| `tape` | Warm dark, amber accent — the default |
| `dusk` | Cool indigo, periwinkle accent |
| `moss` | Deep green, lime accent |
| `daylight` | Light paper, rust accent |
| `contrast` | Maximum contrast, heavier hairlines |

Pick one in the UI's Settings panel (it previews as you click) or in
`vno setting`. Anything else in this field falls back to `tape`.

The theme is stored here rather than in the browser, so the page can be served
already wearing it — and so `vno setting` can change it without a browser open.

---

## `rememberDeletions`

Whether recordings you delete through vno are remembered, so that importing
again doesn't copy them straight back off a device that still holds them.
`true` by default.

Deletions are appended to a plain JSON file next to your config:

```
~/.vno/deleted.json
```

Each entry records the target it belongs to, the recording's path within that
target, its size in bytes, which action removed it, and when:

```json
{
  "version": 1,
  "entries": [
    {
      "target": "/path/to/voice-notes",
      "rel": "IC RECORDER/250724_1032.mp3",
      "size": 184320,
      "via": "cleanup",
      "deletedAt": "2026-07-25T10:14:02.881Z"
    }
  ]
}
```

An entry matches a file on the device only when **both** the path and the byte
size line up — the same test import already uses to recognise a recording it
has already copied. Re-record over the same filename and you get a different
size, so the new recording still imports.

**The ledger is optional in the strongest sense: delete the file and nothing
breaks.** Import goes straight back to the behaviour it had before the ledger
existed — copy anything that isn't already on disk. A corrupt or unreadable
ledger is treated the same way, so bad bookkeeping can never block an import.
`vno cleanup ledger` is just a convenient way to delete it.

Setting `rememberDeletions` to `false` stops both halves — nothing is recorded,
and nothing is skipped. An existing ledger file is left alone but ignored.

> **Only deletions made *through* vno can be recorded** — the UI's per-take
> delete, the UI's cleanup, and `vno cleanup`. Deleting a file by hand in
> Explorer or Finder is invisible to the tool, so that recording will come back
> on the next import.

---

## Supported audio and video extensions

Recognised everywhere — import, transcribe, cleanup and the UI. Video files play
in the same deck as audio (whisper.cpp only reads their audio track):

```
.mp3  .wav  .m4a  .aac  .flac  .ogg  .oga  .wma  .aiff  .opus  .amr  .3gp
.mp4  .m4v  .mov  .mkv  .webm  .avi
```

Anything else on the volume is ignored, so photos, firmware and the recorder's
own database files are never copied.

---

[← Back to the docs index](README.md) · [CLI reference](cli-reference.md) · [Import & sync](import-and-sync.md)
