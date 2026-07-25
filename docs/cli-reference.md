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

If `whisper` isn't installed, the command offers to install it with
`pip install -U openai-whisper`. ffmpeg still has to be installed separately.

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

---

## `vno cleanup`

Scans the target folder for recordings shorter than a threshold — the 2-second
accidental button presses — using `ffprobe` to measure duration. Shows the
list, then asks for confirmation (**default: no**) before deleting them along
with any matching `.vtt` / `.srt` / `.txt` sidecar.

| Flag | Effect |
| --- | --- |
| `-t, --threshold <seconds>` | Recordings shorter than this are candidates. Default `3` |
| `--dry-run` | List what would be deleted, delete nothing |

The same scan-and-confirm flow is available from the UI's *Cleanup* button.

> **Deleting only ever happens here, or from the UI** (its *Cleanup* and
> per-take *Delete*), and always behind a confirmation. `import` and
> `transcribe` never delete anything — aside from `import` moving previously
> nested files up into the flat layout.

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

Arrow keys to pick a setting, `Esc` to exit; changes save as you make them. The
first three are also editable from the [UI's Settings dialog](ui.md#settings).

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
npm run config
```

Note the `--` before flags: npm needs it to pass arguments through.

---

[← Back to the docs index](README.md) · [The browser UI](ui.md) · [Configuration](configuration.md)
