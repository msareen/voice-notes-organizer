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
  "sources": [],
  "knownMounts": {},
  "autoTranslate": null,
  "defaultModel": "turbo",
  "openWhenDone": true,
  "rememberDeletions": true,
  "gpu": { "device": null, "name": null, "torch": null, "use": null, "probedAt": null }
}
```

`config.json` isn't the only file in `~/.vno`: deletions are recorded next to
it in [`deleted.json`](#rememberdeletions), which you can throw away at any
time.

## What can change what

| Setting | `vno setting` | UI Settings | Edit the file |
| --- | :---: | :---: | :---: |
| `target` | ✅ | shown only | ✅ |
| `sources` | — | — | ✅ |
| `knownMounts` | reset all | per-volume, on import | ✅ |
| `autoTranslate` | ✅ | ✅ | ✅ |
| `defaultModel` | ✅ | ✅ | ✅ |
| `openWhenDone` | ✅ | ✅ | ✅ |
| `rememberDeletions` | ✅ | ✅ | ✅ |
| `gpu` | on/off only | on/off only | ✅ (detected by `vno setup`) |

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
volumes. Use it for network shares, or for drives that are already mounted and
won't show up as "removable" (an internal disk, a permanently attached USB
HDD).

```json
"sources": [
  "/mnt/nas/voice-notes",
  "D:\\Backups\\OldRecorder"
]
```

Add as many as you like. Every entry is synced into `target` on every
`vno import` run **without prompting** — it was explicitly configured, so it's
trusted. They also appear in the UI's import dialog, marked
*(configured source)* and checked by default.

If two sources (or a source and a detected volume) share the same folder name,
the later one is disambiguated with its parent folder name — e.g.
`Recordings (deviceB)` — so they don't land in the same destination folder.

**Only settable by editing this file for now.**

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
whisper's translate task.

| Value | Behaviour |
| --- | --- |
| `null` *(default)* | Not decided yet — `vno` asks once and stores your answer here |
| `true` | Translate every import, without asking |
| `false` | Never translate on import |

Flip it, or reset it back to `null`, from `vno setting` or the UI's Settings
dialog.

## `defaultModel`

The whisper model used for auto-translation, and pre-selected in the
`vno transcribe` picker and the UI's transcribe dialog.

One of `turbo`, `tiny`, `base`, `small`, `medium`, `large`. Defaults to
`turbo`. See [Transcription](transcription.md#choosing-a-model) for how to
choose.

## `gpu`

What [`vno setup`](cli-reference.md#vno-setup-doctor) found out about GPU
acceleration, and what you want done with it.

```json
"gpu": {
  "device": "cuda",
  "name": "NVIDIA GeForce RTX 3060 Laptop GPU",
  "torch": "2.5.1+cu121",
  "use": true,
  "probedAt": "2026-07-26T17:17:54.246Z"
}
```

| Field | Meaning |
| --- | --- |
| `device` | The probe result. `null` = never checked, `"cuda"` = usable GPU, `"cpu"` = checked, there isn't one |
| `name` | The card, for display |
| `torch` | The torch build that answered, so an upgrade is visible |
| `use` | Your answer. `null` = never asked, `true`/`false` = decided |
| `probedAt` | When the probe last ran |

The answer that matters is `device === "cuda" && use !== false` — a detected GPU
is used unless you've said no, since the browser has nowhere to ask at job time.

Detection means booting Python and importing torch, which takes seconds, so it
happens **only in `vno setup`** and the result is cached here. Nothing depends on
it: delete the block, or the whole file, and every command still runs on the CPU.

Toggle it from `vno setting` or the UI's Settings dialog; re-detect after a driver
or torch change by running `vno setup` again. See
[Transcription](transcription.md#gpu-acceleration).

## `openWhenDone`

Whether a finished `vno import` / `vno transcribe` run launches the
[browser UI](ui.md). `true` by default; set it to `false` to keep runs
headless.

`--no-open` overrides it for a single run.

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

## Supported audio extensions

Recognised everywhere — import, transcribe, cleanup and the UI:

```
.mp3  .wav  .m4a  .aac  .flac  .ogg  .oga  .wma  .aiff  .opus  .amr  .3gp
```

Anything else on the volume is ignored, so photos, firmware and the recorder's
own database files are never copied.

---

[← Back to the docs index](README.md) · [CLI reference](cli-reference.md) · [Import & sync](import-and-sync.md)
