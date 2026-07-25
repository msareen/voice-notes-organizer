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
  "openWhenDone": true
}
```

## What can change what

| Setting | `vno setting` | UI Settings | Edit the file |
| --- | :---: | :---: | :---: |
| `target` | ✅ | shown only | ✅ |
| `sources` | — | — | ✅ |
| `knownMounts` | reset all | per-volume, on import | ✅ |
| `autoTranslate` | ✅ | ✅ | ✅ |
| `defaultModel` | ✅ | ✅ | ✅ |
| `openWhenDone` | ✅ | ✅ | ✅ |

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

## `openWhenDone`

Whether a finished `vno import` / `vno transcribe` run launches the
[browser UI](ui.md). `true` by default; set it to `false` to keep runs
headless.

`--no-open` overrides it for a single run.

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
