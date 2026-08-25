# The browser UI

`vno visualize` (alias `vno v` / `vno viz` / `vno vis` / `vno --v`) starts a small local web server and
opens the organizer in your browser. It is the app: **everything the CLI can
do can be done from here**, and the page is live — edits, deletes and imports
take effect on disk immediately, with no file to regenerate and nothing to
export.

![The Voice Note Organizer browser UI: takes list on the left, playback deck and follow-along transcript on the right.](../images/vno-ui.png)

It opens automatically at the end of every `vno import`, and every
`vno transcribe` that converted at least one file. Run it on its own any time
with `vno v`.

---

## Layout

### Header

The commands sit on the left, next to the root label; the readout and the two
system keys sit on the right.

| Element | What it does |
| --- | --- |
| **Root label** (`voice-notes`) | The name of your target folder |
| **Import** | Detect volumes and pull in new recordings — see [Import dialog](#import) |
| **Transcribe** | Pick takes and run whisper on them — see [Transcribe dialog](#transcribe) |
| **Cleanup** | Find and delete very short recordings — see [Cleanup dialog](#cleanup) |
| **Explore** | Opens the target folder in Explorer / Finder / your file manager — the same thing `vno explore` does |
| **Recordings / Total time** | Number of recordings and their combined running time |
| **⚙ Settings** (right) | Theme, plus the settings also offered by `vno setting` — see [Settings dialog](#settings) |
| **⏻ Quit** (right) | Stops the server and ends the CLI session |

On a narrow window the readout drops out and the command buttons keep their
icons only.

While a job is running, a progress bar and a **Log** toggle appear in the
header, and the command buttons are disabled until it finishes.

### Left pane — the takes list

Newest recording first. Each row shows the file name, the recorded date and
time, the duration, the file size, and a **green LED** when a transcript
exists.

- **Grouping** — rows group by device folder. Each group header collapses with
  a click, and carries a `⧉` button that opens that folder on disk.
- **Filter box** — a full-text search across file names, folder paths *and*
  transcript text, so you can find a recording by something said in it. A take
  that matched on its transcript shows the matching words underneath, and the
  same words are highlighted in the transcript when you open it. Whitespace is
  ignored when matching, so a phrase works even when the transcript broke it
  across two lines. The `n / n takes` counter above the box tracks the filtered
  count.
- **Keyboard** — `↑` / `↓` move through the visible list; `Enter` or `Space`
  selects the focused row.
- **Divider** — drag it to resize the pane. It's focusable too: `←` / `→`
  resize in steps once it has focus.

### Right pane — the playback deck

- **Now playing** header with the file name and its folder path.
- **Metadata chips**: `REC` (recorded date/time), `LEN` (duration), `SIZE`,
  `FMT` (container).
- **Video recordings** (`.mp4`, `.m4v`, `.mov`, `.mkv`, `.webm`, `.avi`) get a
  themed frame above the transport showing the picture; a capped max-height
  keeps a portrait or odd-aspect clip from pushing the transport and
  transcript off screen. Audio-only recordings show no frame — everything
  else about the deck (transport, scrub rail, cue ticks, transcript
  highlighting) works identically for both, since both play through the same
  custom transport.
- **Transport** — play/pause, a draggable scrub rail, elapsed and total time,
  `−10s` / `+10s`, and a speed key cycling 1× → 1.25× → 1.5× → 2× → 0.75×. The
  rail carries a **tick per transcript cue**, so you can see where speech was
  segmented before you play it. Media is streamed from disk with range
  requests, so seeking works and nothing is copied anywhere. With the scrub
  focused, `←` / `→` seek five seconds, `Home` / `End` jump to either end, and
  `Space` plays or pauses.
- **Transcript / Summary tabs** — a **Transcript** tab (the timed `.vtt`,
  current line highlighted and scrolled into view as it plays, click any line
  to jump playback there; a plain `.txt` is shown as a block, without
  highlighting) and, unless hidden in Settings, a **Summary** tab next to it
  rendering the recording's `.summary.txt` as markdown. See
  [Summarization](summarization.md).

### Per-take actions

| Button | What it does |
| --- | --- |
| **Open file location** | Opens the file's containing folder in Explorer / Finder |
| **Transcribe** / **Re-transcribe** | Opens the transcribe dialog for just this take |
| **Summarize** / **Re-summarize** | Summarizes the transcript with llama.cpp — optional, hidden if the Summary tab is disabled in Settings; see [Summarization](summarization.md) |
| **Edit transcript** | Opens the in-page editor (below) |
| **Delete** | Deletes the audio *and* its transcript sidecars, after a confirmation |

---

## Transcript editor

A deliberately minimal in-page editor, reached with **Edit transcript**.

- **Timed transcripts** (`.vtt`, `.srt`) get **one text box per cue**, with the
  timestamp shown beside it. Only the text is editable, so **your edits never
  disturb the timings** — the original timings are read back off disk on save
  and written out unchanged.
- **Untimed notes** get a single text box. A note with **no transcript at all**
  can have one typed by hand this way; clearing the box removes the sidecar.
- **`Ctrl`/`Cmd`+`Enter`** saves. **`Esc`** cancels.

If the file changed on disk while you were editing (a re-transcribe finished,
say), the save is refused with *"Transcript changed on disk — reload and try
again"* rather than overwriting the new version.

---

## Dialogs

### Import

Lists every detected volume plus every folder configured in
[`sources`](configuration.md#sources). For each one:

- A **checkbox** — pre-checked for configured sources and for volumes you've
  already chosen to auto-import.
- The **mount path**, and the date it was last synced.
- A **Subfolder** button that walks the volume's folder tree one level at a
  time, so a recorder that buries audio under `PRIVATE/SONY/…` can be pinned
  without typing a path. *Reset to whole volume* undoes it.

Two checkboxes apply to the run: **translate newly imported notes to English**
(pre-set from your `autoTranslate` setting) and **remember these volumes and
auto-import them next time** (on by default).

If nothing is connected, the dialog says so and points at the `sources` config
option.

**Drag and drop** — dragging audio or video file(s) from your OS file manager onto the
page (anywhere, no dialog needed) copies them straight in, landing in a
`Dropped/` folder next to the per-device ones. Same-name-and-size dedup applies,
so dropping the same file twice is a no-op; a file matching one you deleted
through vno is left alone too, same as a normal import. There's no translate
option here — drop the file, then use Transcribe with `--translate` if you
want it.

### Transcribe

Lists every take with a `has transcript` / `no transcript` marker. Untranscribed
ones are checked by default; when there's no backlog left, everything is. Use
**All** / **None** to toggle the list in bulk.

Below the list: the **whisper model** (defaulting to your
[`defaultModel`](configuration.md#defaultmodel)) and a **translate to English**
checkbox. **Start** kicks off the job.

If whisper.cpp or ffmpeg isn't installed, the dialog says so up front. A web
page can't run an installer, so it points you at `vno setup` in a terminal,
which offers to install what's missing. Starting the job anyway is refused with
the same message.

### Cleanup

Enter a **threshold in seconds** (default 3) and scan. The dialog lists every
recording shorter than that with its duration, checkboxes to deselect any you
want to keep, and a confirmation before deleting. Matching `.vtt` / `.srt` /
`.txt` sidecars go with them.

Tick **Also list pre-repair originals** to include the `*.original.m4a` copies
kept beside
[repaired Samsung recordings](troubleshooting.md#a-samsung-recording-wont-play-or-transcribe).
They appear as a second group in the same list — unticked by default, since
they're worth keeping until you've played the repaired recording — and are
deleted without touching any transcript or the deletion ledger.

### Settings

Opens as a full-height panel from the right, off the **⚙** key in the header.

**Appearance** is the first section: six themes, each shown as a swatch in its
own palette — **Auto** (follows your system's light/dark setting), **Tape**
(the default warm dark), **Dusk**, **Moss**, **Daylight** (light) and
**Contrast**. Picking one applies it to the page immediately so you can see it;
**Save** keeps it (in [`theme`](configuration.md#theme)), and **Cancel** or
`Esc` puts back the one you arrived with. `vno setting` offers the same list in
the terminal.

Then the settings that are also offered by `vno setting`:
[`autoTranslate`](configuration.md#autotranslate) (on / off / ask each time),
[`defaultModel`](configuration.md#defaultmodel),
[`transcribeLanguage`](configuration.md#transcribelanguage),
[`crossLanguage`](configuration.md#crosslanguage) (its own full-width row below
the two columns: a detect-model dropdown, two language dropdowns and **Add**,
and the saved rewrites as a strip of `Urdu → Hindi ✕` pills you click to remove
— the **?** beside the heading explains what the pass is for),
[GPU acceleration](configuration.md#accel),
[`openWhenDone`](configuration.md#openwhendone), and
[`rememberDeletions`](configuration.md#rememberdeletions). The **target folder**
is shown but not editable here — changing it needs a re-scan, so it lives in
`vno setting`. **Save** at the bottom of the panel writes the lot.

**Source folders** — synced every import in addition to detected volumes — are
also editable here: paste or type a path, or click **Browse…** to walk the
filesystem from a server-side folder tree (a browser's own directory picker
can't hand back a real path, so this drives `/api/browse-fs` instead). Each
row also picks which audio extensions to pick up, whether to include
subfolders (off by default — a source is usually a flat drop point), and
whether to delete the source file once it's safely copied in.

The GPU row only appears when an accelerator-capable whisper.cpp build was
installed, and only turns it on or off: *installing* one is
[`vno setup`](cli-reference.md#vno-setup)'s job, since the browser can't run
an installer. Until you've run it, the dialog says so. A transcribe job logs
which device it used.

**Summarization** is its own full-width section, always present. A **Show the
Summary tab in the deck** toggle
([`summaryEnabled`](configuration.md#summaryenabled)) turns the whole feature's
UI on or off — hides the tab and the Summarize button without touching any
summary already on disk. Once llama.cpp has at least one model, two more
fields appear: [`summaryModel`](configuration.md#summarymodel) (a dropdown
over whatever's in your models folder) and an **Override prompt** field
([`summaryPrompt`](configuration.md#summaryprompt)). Before that, the section
just points at `vno setup --llama`. See [Summarization](summarization.md).

Deletes made from this page — both the per-take **Delete** and **Cleanup** —
are recorded, so importing again won't copy those recordings back off the
device. Clearing that record is a CLI job: `vno cleanup ledger`.

`Esc` closes any dialog. When dialogs stack (the subfolder browser over the
import dialog), `Esc` closes only the topmost one.

---

## Jobs and the log

Import and transcription run as **jobs**. At most one runs at a time — starting
a second is refused with a *"Busy"* message.

While one runs, the header shows a progress bar and a per-file title
(*"Transcribing 260725_0126.mp3 (2/7)"*). The **Log** panel streams whisper's
live output, including its progress bar, so a long transcription isn't a black
box. The last 200 lines are kept.

Failures on individual files are logged and the job carries on with the rest —
one unreadable recording doesn't abandon the batch.

---

## Lifecycle: how the session ends

The CLI stays up serving the page, and exits when you're done with it:

- **Quit** in the header stops the server, but not silently: the page covers
  itself with a "Shutting down vno…" screen the moment you confirm, then
  polls until a request genuinely fails to connect (not just "the last one
  was slow") before switching that screen to "vno has stopped — you can
  close this tab now" and trying to close the window itself. That last part
  is best-effort — most browsers refuse to let a script close a tab it
  didn't open itself, which is exactly why the message doubles as the
  fallback instead of assuming the close works.
- **Closing the browser tab does the same** — the CLI exits a few seconds
  later. A page *reload* isn't mistaken for a close, and a second tab keeps the
  session alive.
- A job already running is **allowed to finish** before shutdown, so you never
  get a half-written transcript.
- A wedged connection (sleeping laptop, proxy) is caught by a watchdog after
  two minutes of silence.

---

## Installing as an app

The page is a PWA (manifest + service worker): most browsers offer to install
it, and vno surfaces that as an "Install Voice Notes as an app" banner the
first time a session becomes eligible for it. Installing gives you a standalone
window with its own icon/taskbar entry instead of a browser tab. It still
needs `vno v` running — installing doesn't start a background service; if the
fixed port isn't reachable when you open the installed app, you get a splash
screen (the app's mark, "Starting Voice Notes…") rather than an error page,
since the common case is a cold start still spinning up, not a real failure.
It tries to launch vno for you automatically as soon as it shows. Recovery
options — a **Launch vno** button, a **Reload**, and manual instructions —
stay hidden for the first several seconds and only fade in if startup is
taking longer than a normal cold start should, so the common case reads as
"starting up" rather than "something's wrong." The page polls quietly in the
background throughout and moves on by itself the moment the server answers,
so there's nothing to click once it's up.

Both the automatic attempt and the **Launch vno** button navigate to
`vno://open` — a custom URL scheme, the same mechanism a Teams or Zoom
meeting link uses, so the browser shows its own native "Open vno?" prompt
and, on approval, the OS runs `vno v` for you. It only works once
`vno setup` has registered the handler (Windows only for now — see
[`vno setup`](cli-reference.md#vno-setup)); without that, both do nothing
beyond whatever "unknown link" handling your browser shows, so the manual
instructions stay right beside them once they appear. The automatic attempt
fires once per page load, not on every poll, so a server that never comes up
can't turn it into repeated pop-ups. This launch never opens a second tab or
window — the splash page itself is already polling in the background and
moves on the moment the server answers.

The server this starts runs in the background, not in a visible terminal:
`vno://open` briefly launches a console-owning process (whatever Windows
creates for the protocol invocation), which immediately hands off to a
second, detached, windowless copy of the server and exits — so after that
first flash, there's nothing on your taskbar or desktop for the server
itself, the same way starting Teams or Zoom doesn't leave a console window
behind either.

Once installed, plain `vno v` (from a terminal, or a second `vno://open`)
prefers the installed app over a browser tab: it looks for the app's Start
Menu shortcut and, if found, opens that instead — so launching vno always
lands you in the standalone window rather than a tab once you've installed
it once.

---

## Security model

These endpoints delete files and launch programs, so access is narrow by
design:

- The server binds to **`127.0.0.1`** on a **fixed port** ([`port`](configuration.md#port),
  `9477` by default) — never an external interface. If that port is busy,
  `vno v` checks whether it's a `vno v` instance already running and opens a
  tab to it instead of picking a different port (bookmarked URLs and an
  installed PWA shortcut depend on the port staying put); `-p/--port 0` asks
  for a random free port instead.
- Every request needs a **session token**, persisted in
  `~/.vno/session-token` and reused across runs (not regenerated per launch —
  what lets a bookmark or an installed PWA keep working), inlined into the
  page. Requests without it get a 403, including anyone who guesses the port.
- **Cross-origin requests are refused** outright, so a page in another tab
  can't drive your session.
- Every file path is resolved back against the target folder; anything
  escaping it is rejected.

`-p/--port <number>` pins the port if you need a different stable one;
`--no-open` starts the server without launching a browser (it prints the
tokenized URL instead).

> Earlier versions wrote a static `index.html` into the target folder. That
> file is no longer generated or updated — if you have one lying around it's a
> stale snapshot and can be deleted.

---

[← Back to the docs index](README.md) · [CLI reference](cli-reference.md) · [Configuration](configuration.md)
