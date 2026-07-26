# CLI reference

Every command and flag. Run `vno --help` or `vno <command> --help` for the
same thing, shorter.

Everything here works unlinked too, as `node bin/vno.js <command>`.

| Command | Aliases | What it does |
| --- | --- | --- |
| [`vno import`](#vno-import) | `vno` (default) | Detect volumes and import new recordings |
| [`vno transcribe`](#vno-transcribe) | `vno t`, `vno --t`, `vno -t` | Transcribe or translate recordings with whisper |
| [`vno visualize`](#vno-visualize) | `vno v`, `vno --v`, `vno -v` | Launch the browser UI |
| [`vno cleanup`](#vno-cleanup) | — | Delete very short recordings |
| [`vno setting`](#vno-setting) | `vno settings` | Interactive settings wizard |
| [`vno setup`](#vno-setup) | `vno doctor` | Check ffmpeg + whisper, install what's missing |
| [`vno config`](#vno-config) | — | Print the config file path |

---

## `vno import`

The default command — plain `vno` runs it.

Detects connected volumes. For each **new** volume it asks (via arrow-key
menus) whether to import audio files into the target folder, and whether to
remember that choice. If you say yes, it also lets you browse the volume's
folders and pin a specific subfolder as the sync root — useful for devices that
bury audio several folders deep (`PRIVATE\SONY\VOICE\FOLDER01\…`).

**Known volumes are auto-imported (or skipped) silently next time**, using the
remembered choice and subfolder. Press `Esc` at any prompt to cancel — anything
already copied is kept.

Imported files land **flat**, one folder per device. See
[Import & sync](import-and-sync.md) for why, and for how name collisions are
handled.

**Auto-translate:** after importing, `vno` offers *once* to auto-translate new
notes to English as they come in. Your answer is remembered and applied to
every future import without asking. Toggle or reset it with `vno setting`.

**When the run finishes** — and only if it actually brought something in — it
launches the [browser UI](ui.md) so the new notes are immediately playable.
The CLI then stays up serving that page until you close the tab.

| Flag | Effect |
| --- | --- |
| `--no-open` | Don't launch the browser UI when the run finishes |

---

## `vno transcribe`

Aliases: `vno t`, `vno --t`, `vno -t`.

Lists audio files in the target folder that don't have a transcript yet, lets
you pick which to transcribe, and runs `whisper` on each. One file is written
next to the audio: a timed `.vtt` (`note.m4a` → `note.vtt`).

### The picker

- **Filters live as you type** — start typing to narrow to rows whose text
  (name, recorded date, or duration) contains what you typed; `Backspace` to
  edit. The count updates as you go.
- `↑` / `↓` move (no wraparound), **`Space`** toggles a row, **`Ctrl+A`**
  toggles all *currently visible* rows, **`Enter`** transcribes everything
  that's both checked and visible.
- Each row shows the file's **recorded date** — read from the recorder's
  filename (`250810_1328` → `2025-08-10 13:28`), falling back to the file's
  modified time — and its **duration**.
- **`Esc`** at any point, including mid-selection, quits without transcribing.

It then asks which whisper model to use, defaulting to your
[`defaultModel`](configuration.md#defaultmodel) (`turbo` out of the box).

### Re-transcribing

Pass `-f` **on its own** and the picker lists *every* recording, not just
untranscribed ones, with a `• transcribed` marker on the ones that already have
a `.vtt`. Nothing is pre-selected in this mode (a reflex `Enter` would
otherwise overwrite everything), and selecting a marked row asks for
confirmation.

> Whisper writes straight over the old file, so **hand-edits made in the
> transcript editor are lost** when you re-transcribe.

Naming a file directly (`-f 250810_1328`) also re-transcribes it, without the
picker.

| Flag | Effect |
| --- | --- |
| `-m, --model <name>` | Model to use: `turbo`, `tiny`, `base`, `small`, `medium`, `large`. Skips the prompt |
| `-f, --file [name]` | Transcribe one specific file without the picker — full path, path relative to the target, bare filename (with or without extension), or a unique substring. **Passing `-f` with no value** switches the picker into re-transcribe mode |
| `-s, --filter <text>` | Pre-seed the picker's live filter |
| `--translate` | Produce an English translation (whisper's translate task) instead of a verbatim transcript |
| `--no-open` | Don't launch the browser UI when the run finishes |

Before anything else it checks that `ffmpeg` and `whisper` are on your `PATH`,
and offers to install whichever is missing — the same check [`vno
setup`](#vno-setup) runs. The check happens up front, not after you've picked
files, because the picker shows durations that need `ffprobe`.

Once at least one file has been converted, it launches the [browser
UI](ui.md) so you can play and proof-read the new transcripts right away.

More detail in [Transcription](transcription.md).

---

## `vno visualize`

Aliases: `vno v`, `vno --v`, `vno -v`.

Starts a local web server and opens the two-pane organizer in your browser.
**Everything the CLI can do can be done from there.** Fully documented in
[The browser UI](ui.md).

| Flag | Effect |
| --- | --- |
| `-p, --port <number>` | Pin the port. Default: a free one, picked automatically |
| `--no-open` | Start the server without opening a browser (prints the URL) |

Startup measures every recording with `ffprobe`, which on a large library takes
a while, so a progress bar shows the count and the folder being read:

```
Reading recordings [████████████░░░░░░░░░░░░] 268/551  Sony
```

It clears itself the moment the viewer is up, and is drawn only on a terminal —
piped or redirected output stays clean.

---

## `vno cleanup`

Scans the target folder for recordings shorter than a threshold — the 2-second
accidental button presses — using `ffprobe` to measure duration. Shows the
list, then asks for confirmation (**default: no**) before deleting them along
with any matching `.vtt` / `.srt` / `.txt` sidecar.

| Flag | Effect |
| --- | --- |
| `-f, --file <names...>` | Delete exactly these recordings instead of scanning for short ones |
| `-t, --threshold <seconds>` | Recordings shorter than this are candidates. Default `3` |
| `--dry-run` | List what would be deleted, delete nothing |

The same scan-and-confirm flow is available from the UI's *Cleanup* button.

### Deleting named recordings

`-f` takes one or more recordings and deletes them with their transcripts,
skipping the duration scan entirely:

```bash
vno cleanup -f 250724_1032                        # bare name
vno cleanup -f 250724_1032.mp3 250724_1105.mp3    # several at once
vno cleanup -f "IC RECORDER/250725_0900.mp3"      # path relative to the target
vno cleanup -f 250724_1032 --dry-run              # show what would go
```

Names resolve exactly like [`vno transcribe -f`](#vno-transcribe): an absolute
path, a path relative to the target, or a bare filename matched
case-insensitively — with or without the extension. A name matching several
recordings lists them and asks you to narrow it down.

**If any name doesn't resolve, nothing is deleted** — a typo makes you re-run
with a fixed list rather than silently deleting the subset that did match. The
confirmation still applies (default *no*), and everything deleted goes into the
ledger.

Because it never measures duration, `-f` is also the way to delete recordings
when `ffprobe` isn't installed.

Everything deleted here is written to the [deletion
ledger](import-and-sync.md#deleted-recordings-stay-deleted), so plugging the
recorder back in and importing again won't copy it back.

> **Deleting only ever happens here, or from the UI** (its *Cleanup* and
> per-take *Delete*), and always behind a confirmation. `import` and
> `transcribe` never delete anything — aside from `import` moving previously
> nested files up into the flat layout.

---

## `vno cleanup ledger`

Deletes the deletion ledger (`~/.vno/deleted.json`) after showing how much it
remembers. Exactly the same thing as deleting that file by hand.

```bash
vno cleanup ledger
```

**No recording is touched.** All this does is make vno forget what you deleted
— so the next import copies those recordings back if the device still has
them. That's the point: it's how you undo a deletion you've changed your mind
about.

The ledger can also be cleared from `vno setting`, and switched off entirely
with the [`rememberDeletions`](configuration.md#rememberdeletions) setting.

---

## `vno setting`

Alias: `vno settings`.

An interactive wizard for the switches you're most likely to flip without
hand-editing `config.json`:

- whether imports **auto-translate** (on / off / ask each time)
- the default **whisper model**
- the **target** import folder
- whether finished runs **launch the browser UI**
- **forget all remembered volume choices**
- **check ffmpeg + whisper** and install what's missing (runs [`vno
  setup`](#vno-setup); the menu line shows the current state)

Arrow keys to pick a setting, `Esc` to exit; changes save as you make them. The
first three are also editable from the [UI's Settings dialog](ui.md#settings).

---

## `vno setup`

Alias: `vno doctor`.

Reports whether `ffmpeg`, `ffprobe` and `whisper` are on your `PATH` — with the
resolved path of each — then offers to install whatever is missing.

```bash
vno setup
vno setup --check     # report only, never offer to install
```

| Flag | Effect |
| --- | --- |
| `--check` | Print the status and stop. Installs nothing, asks nothing |

Installs go through whatever package manager you already have, first match
wins:

| Platform | Tried in this order |
| --- | --- |
| Windows | winget → Chocolatey → Scoop |
| macOS | Homebrew → MacPorts |
| Linux | apt → dnf → yum → pacman → zypper → apk → Homebrew |

Whisper always installs with `pip install -U openai-whisper` (`pip3`, `pip`, or
`python -m pip`, whichever exists). If there's no Python at all, vno offers to
install that first, through the same package manager. On a distro whose Python
refuses to be installed into (Debian/Ubuntu's "externally managed
environment"), it offers `pipx install openai-whisper` instead.

**Nothing is installed without you confirming it.** You always see the exact
command first, and can choose to run it yourself instead. Where a system
package manager needs root, the command is prefixed with `sudo` — so you may be
asked for your password; on Windows you may get a UAC prompt. In a
non-interactive shell (a pipe, CI) vno prints the command and stops rather than
asking a question nobody can answer.

Afterwards vno re-reads your `PATH` — from the registry on Windows, and by
adding the usual install directories elsewhere — so a freshly installed tool is
usable in the same run instead of after a terminal restart. If it still isn't
visible, vno says so rather than pretending it worked.

**This check runs by itself.** `vno transcribe`, `vno cleanup`'s duration scan,
and an import that auto-translates all run it before starting work, so a
missing tool surfaces as an install offer instead of a failure part-way
through. When everything is present the check is silent and instant — it's a
`PATH` lookup, not a program launch.

The browser UI can't install anything (it's a web page), so it shows the same
information and points you back at `vno setup`.

---

## `vno config`

Prints the path to the config file (`~/.vno/config.json`). See
[Configuration](configuration.md) for what's in it.

---

## npm scripts

Every command is also an npm script, for running without linking:

```bash
npm run import
npm run transcribe            # or: npm run transcribe -- --file 250810_1328
npm run cleanup               # or: npm run cleanup -- --dry-run
npm run visualize             # or: npm run visualize -- --port 8477
npm run setting
npm run setup
npm run config
```

Note the `--` before flags: npm needs it to pass arguments through.

---

[← Back to the docs index](README.md) · [The browser UI](ui.md) · [Configuration](configuration.md)
