# Import & sync

How `vno import` decides what to copy, where it puts it, and what it remembers.

## What counts as a volume

Detection is per-OS, and deliberately conservative — the point is to spot a
recorder or SD card, not to offer up every disk in the machine.

**Windows** — `DriveType` alone can't tell an external USB HDD from an internal
NVMe drive; Windows often reports both as "Fixed". So each volume is joined
back to its physical disk and filtered on **bus type**: only `USB`, `SD`, `MMC`
and `IEEE1394` buses count, plus mapped network drives. Internal SATA / NVMe /
SAS disks are excluded even if their drive type looks removable, and system or
boot disks are always excluded. If PowerShell isn't available, it falls back to
a plain drive-letter scan of `D:` through `Z:`.

**macOS** — everything mounted under `/Volumes`, minus the boot volume and
symlinked aliases.

**Linux** — udisks2-style automount roots only: `/media/<user>`, `/media`, and
`/run/media/<user>`. **`/mnt` is deliberately not scanned** — that's the
conventional place to permanently mount internal secondary drives, and a big
internal HDD showing up as an import candidate would be wrong.

Anything the detector misses can be added by hand as a
[`sources`](configuration.md#sources) entry, which is imported on every run
without prompting.

## Source folders

A `sources` entry behaves like a permanently plugged-in volume — synced every
run, no prompt — but with three extra, opt-in behaviors a real volume doesn't
need:

- **`pattern`** restricts the walk to filenames matching a `"*"`/`"?"`
  wildcard (e.g. `VN*.m4a`) instead of the default "any audio-extension file"
  check. Useful when the folder isn't dedicated to voice notes.
- **`recursive`** — `false` by default, meaning only the configured folder
  itself is scanned, not its subfolders. A source folder is usually a flat
  drop point (e.g. a phone's Quick Share/Quick Send target), so a single-level
  scan is both the common case and the fast one; turn it on to also pick up
  recordings nested in subfolders. Detected removable volumes don't have this
  knob — they always scan the whole tree, since a recorder's own folder
  layout isn't something the user chose (see
  [Pinning a subfolder](#pinning-a-subfolder) below for narrowing those
  instead).
- **`deleteAfterImport`** removes the source file once it's either freshly
  copied into `target` or found to already be there (a duplicate re-drop).
  This is the setting for something like a phone's Quick Share/Quick Send
  drop folder: the phone still holds the original, so the copy that lands in
  Downloads is disposable, and turning this on keeps it from piling up.

  There's one safety exception: if [`rememberDeletions`](configuration.md#rememberdeletions)
  shows this exact target path was **deliberately deleted from the library
  before**, the source file is left in place instead of being removed — the
  import is skipping it on purpose, so silently destroying the only remaining
  copy would be wrong. Nothing about this is written to the deletion ledger;
  it only ever reads it.

  Leave `deleteAfterImport` off (the default) for a folder that's an actual
  permanent archive.

See [Configuration → `sources`](configuration.md#sources) for the exact
schema, and `vno setting` → *Source folders* / the UI's Settings dialog to
manage entries without hand-editing the config file.

## Pinning a subfolder

Most voice recorders bury audio several folders deep:

```
IC RECORDER/
└── PRIVATE/
    └── SONY/
        └── VOICE/
            ├── FOLDER01/
            └── FOLDER02/
```

Scanning the whole volume works, but it's slower and can pick up audio you
didn't mean (ringtones, sample files). Both the CLI prompt and the UI's
[import dialog](ui.md#import) let you **browse the volume's folders one level
at a time and pin one as the sync root**. The choice is remembered per volume
in [`knownMounts.<id>.sourceSubdir`](configuration.md#knownmounts).

## Imports land flat

Every recording from a device is dropped **directly** into a single per-device
folder:

```
voice-notes/
├── IC RECORDER/
│   ├── 260725_0126.mp3
│   ├── 260725_0126.vtt
│   ├── 260725_0128.mp3
│   └── 260725_0128.vtt
└── Field Recorder/
    └── 260724_2044.mp3
```

The device's deep folder tree is **not** mirrored. `FOLDER01` and `FOLDER02`
are the recorder's storage bins, not a structure you chose, and reproducing
them locally is noise — everything is sorted by recorded date in the UI
anyway.

**Name collisions** between subfolders are disambiguated with a `_2`, `_3`, …
suffix.

**If you'd previously imported with the old nested layout**, the next import
flattens it in place automatically and tells you how many files it moved. This
is a move, not a copy — nothing is duplicated, and a file that can't be moved
is left exactly where it is rather than risking a clobber.

## Re-running is safe

Imports are **idempotent**. For each source file, a same-named file already in
the destination with the **same size** is treated as the same recording and
skipped. Only a same-named file with a *different* size gets a `_2` suffix.

So plugging the recorder in twice copies nothing the second time, and
`vno import` is safe to run as a reflex. The summary line tells you the split:

```
Synced "IC RECORDER": 4 copied, 112 already up to date -> D:\voice-notes\IC RECORDER
```

**Nothing is ever deleted from a detected volume.** Import only reads from
those. The one exception is a manually configured [source folder](#source-folders)
with `deleteAfterImport: true`, which is opt-in per folder and never applies
to a removable device.

## Deleted recordings stay deleted

That idempotency has a gap on its own: it only recognises files that are
*still there*. Delete a bad recording locally, leave the recorder plugged in,
run `vno` again, and the empty slot gets refilled from the device.

So deletions made through vno are remembered. The UI's per-take **Delete**, the
UI's **Cleanup**, and `vno cleanup` each append an entry to
`~/.vno/deleted.json`, and import leaves those recordings alone:

```
Synced "IC RECORDER": 4 copied, 112 already up to date, 3 previously deleted
```

Entries match on path **and** byte size, the same pair used to spot an
already-imported file. A genuinely different recording that happens to reuse a
filename has a different size, so it still imports normally.

Two limits worth knowing:

- **Only deletions made through vno count.** Deleting a file in Explorer or
  Finder can't be seen from here, so it will come back on the next import.
- **The device still has the audio.** Nothing here deletes from the recorder;
  the ledger only stops the local copy reappearing.

Changed your mind? `vno cleanup ledger` (or deleting `~/.vno/deleted.json`
yourself, or `vno setting` → *forget deleted recordings*) makes vno forget
everything it's remembered, and the next import brings those recordings back.
To switch the whole mechanism off, set
[`rememberDeletions`](configuration.md#rememberdeletions) to `false`.

## What's remembered

After a successful import, the volume is recorded in
[`knownMounts`](configuration.md#knownmounts): its label, whether to
auto-import, the pinned subfolder, the timestamp, and the copied/skipped
counts. Next time that volume appears, it's imported (or skipped) silently
using those answers — no re-prompting.

Volumes are keyed by **label**, not drive letter or mount path, because drive
letters shuffle between reconnects.

To change your mind: uncheck *remember* in the UI's import dialog, edit
`knownMounts` directly, or use `vno setting` → *forget all remembered volume
choices* to make the next import ask fresh about everything.

## Recorded dates

The date shown against each take comes from the **filename**, which is how most
recorders stamp their files:

| Filename | Read as |
| --- | --- |
| `250810_1328` | 2025-08-10 13:28 |
| `20250810_132845` | 2025-08-10 13:28 |
| `2025-08-10 13.28` | 2025-08-10 13:28 |

Implausible values are rejected (a year outside 1970–2099, February 30th), and
anything unparseable falls back to the file's **modified time** — which
copying preserves, so it usually still reflects the recording.

---

[← Back to the docs index](README.md) · [Configuration](configuration.md) · [CLI reference](cli-reference.md)
