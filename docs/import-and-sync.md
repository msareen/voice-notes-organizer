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

**Nothing is ever deleted from the device.** Import only reads.

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
