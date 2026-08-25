# Third-party binary management

For working on the code. Nothing here is needed to use the tool — see
[Installation](installation.md) and [Transcription](transcription.md#installing-whispercpp)
for the user-facing version of most of this.

vno depends on two things it doesn't ship itself: **ffmpeg** (decoding audio)
and **whisper.cpp** (transcription). This page walks through what `vno setup`
actually does, step by step, and answers the questions that tend to come up
once you start reading the code: where do these files live, how does vno
know if an install is "local" or "global", and what is `vno-install.json` for.

## The `vno setup` flow, step by step

**1. Check what's already there.**
PATH is refreshed first (it can be stale if something was installed after
this shell opened), then vno checks whether whisper.cpp is already
resolvable — vendored under one of two known folders, recorded in a file
there, or found on `PATH` under any of its known names. Same idea for
ffmpeg/ffprobe: just a `PATH` scan.

**2. If it's missing, ask where to put it.**
Unless a mode was forced with `--local`/`--global`, the user is asked:
install it *locally* (beside this install of vno), *globally* (under the
user's home directory), or *"I already have it — here's the path"*.

**3. Install (or register) the binary.**
For a fresh install, vno figures out the right build for the platform (GPU
present? which vendor? on Windows it asks `nvidia-smi` what CUDA runtime the
*driver* supports), downloads or builds it into the chosen folder's `bin/`,
and writes a small record next to it — that record is `vno-install.json`, covered
below. For "I already have it", nothing is downloaded or copied — the path
you gave is just written into that same record.

**4. Re-resolve, rather than trust the flag.**
Immediately after, vno runs the *exact same lookup* it uses at transcription
time to figure out which binary is actually now in effect. This matters
because "I already have it" or a tie between two old installs might not
land where the flag said — asking the binary itself is more honest than
trusting what was requested.

**5. Read the accelerator info back out, once.**
The binary's accelerator backend (CUDA / Metal / CPU) was decided the moment
it was built or downloaded — nothing about that changes later. So this step
just reads whatever got recorded in step 3, and asks once whether to use it
for transcription. Cheap, so it can run on every `vno setup`, unlike the old
Python path's runtime CUDA probe.

**6. Make sure the default models are present.**
vno takes an inventory of what model files actually exist on disk right now
(both folders, plus a couple of platform extras), and for anything from the
default set (`small`, `turbo`, or whichever single model `--model` asked for,
or a checklist of any of them with `--whisper`) that isn't already there,
downloads it straight into the *active* folder's `models/` — checksum-verified
against the catalog entry's SHA-256 once, right after the download finishes.

**7. llama.cpp, separately and only if asked.** None of the steps above touch
llama.cpp — summarization is entirely optional, so a plain `vno setup` never
installs or configures it. That's its own explicit step, `vno setup
--llama`; see
[llama.cpp (optional summarization) is managed very differently](#llamacpp-optional-summarization-is-managed-very-differently)
below.

That's the whole flow — everything after this (running a transcription) just
reuses steps 1 and 4's lookup, without re-asking anything.

## Where the files actually live

whisper.cpp isn't installed to one place — vno always has **two candidate
folders** in mind, and both are fixed, computable paths (not something typed
in or configured):

- **local** — right beside this particular install of vno itself. If you
  installed vno globally with Bun, this is inside that install's own
  directory; if you're running from a dev checkout, it's inside the
  checkout.
- **global** — under your home directory: `~/.whisper-cpp` on macOS/Linux,
  `%LOCALAPPDATA%\whisper-cpp` on Windows.

Each of those two folders, if it's ever been used, has the same three things
inside it:

```
whisper-cpp/
├── bin/          the binary itself (+ any .dll/.so files it needs)
├── models/       ggml-*.bin model files
└── vno-install.json  a record of what setup found or built here
```

## "Local or global" is a file lookup, not a saved setting

This is the part that's easy to assume works like a config flag, and
doesn't. There is **no setting anywhere** — not in `~/.vno/config.json`, not
in an env var — that says "this machine uses the local install" or "this
machine uses the global one".

Instead, every time vno needs the binary or a model, it just **checks both
of the two fixed folders above and uses whichever one actually has files in
it.** If only one has ever been set up, that's obviously the one used. If
both have something (say, you did a local install months ago, then later ran
`vno setup --global`), vno picks whichever one is *newer*, using a timestamp
each folder's own record carries — so a fresh global install correctly wins
over a stale leftover local one, rather than some fixed order always
checking local first.

When vno reports "you're using the local install" it isn't recalling a
choice — it's comparing the path it just found the binary at against the two
known candidate paths and reporting which one matched. The mode is a
property of *where the binary happened to be found*, derived after the
fact, not a preference read back from storage.

## What `vno-install.json` actually is

It's worth being clear that **whisper.cpp itself has no idea this file
exists.** It's not part of the whisper.cpp project at all — it's something
vno invented and fully owns, purely to avoid redoing work.

### Why it exists

Two things about whisper.cpp are expensive or awkward to re-derive every
single time vno runs a command:

- Which binary is the "right" one, when there might be a leftover install in
  the other folder too.
- What accelerator that binary actually has — this used to require a slow
  runtime probe in the old Python/PyTorch version of this tool (asking
  PyTorch "can you actually see a working CUDA device?" at the start of
  every transcription). whisper.cpp doesn't need that: the accelerator is
  baked in when the binary itself was built, so it never changes on its own.

`vno-install.json` is just a small note vno leaves for itself, right beside the
binary, so the answer to "what did the last `vno setup` find or build here"
is a cheap file read instead of a re-probe.

### What it holds

Nothing more than a snapshot of what one `vno setup` run produced for one of
the two folders: which binary it is and how it was obtained (built/downloaded
vs. pointed at externally), what accelerator that binary has, when this
happened, and — as a convenience, not the source of truth — where any models
that got downloaded into this folder ended up.

### What it's *not* required for

This is the part worth internalizing: **every one of those facts is treated
as a fallback, never as the answer on its own.** Before trusting anything
`vno-install.json` says, vno always checks the real, expected location on disk
first:

- Looking for the binary? Check the folder's actual `bin/` directory first.
  Only fall back to whatever path `vno-install.json` remembers if nothing's
  vendored there — which is really only ever the case for a binary the user
  pointed at manually, sitting somewhere else entirely.
- Looking for a model? Check the folder's actual `models/` directory first,
  at the exact filename that model would have. Only fall back to
  `vno-install.json`'s note if that default file isn't there.
- Want to know *which models are available at all* (`vno setup
  --list-models`)? That doesn't consult `vno-install.json` in any way — it's a
  plain scan of the actual model folders on disk.

So `vno-install.json` can go stale — get deleted, get out of date if a file is
moved by hand — without that being a correctness problem. Worst case, vno
just re-derives the same information the next time it needs it (a fresh
lookup, or a re-download if a model file is genuinely gone). The one place
staleness has no fallback is a binary registered from an external location:
since that path was never inside vno's own folder to begin with, there's no
default location to fall back to re-checking if the user moves that file
later.

## Two related environment variables

Separate from all of the above — these aren't read from `vno-install.json` or
any config file, just from the shell environment, and neither is something
vno sets up for you:

- **`WHISPER_MODEL_PATH`** — for when your models live somewhere outside
  both of the two folders described above (a shared cache, an offline
  pre-seeded copy). Checked before either folder's default location.
- **`VNO_MODEL_BASE`** — replaces where models get *downloaded from*
  (normally Hugging Face, with a mirror fallback) with a single URL of your
  own, e.g. an internal mirror.

Neither one affects where the *binary* is found — that's always one of the
two fixed folders, `vno-install.json`, or `PATH`, with no environment override.

## llama.cpp (optional summarization) is managed very differently

Everything above is `lib/whisper/whispercpp.ts` — llama.cpp
(`lib/llama/llamacpp.ts`) mirrors it for *models* (a curated catalog with
SHA-256 verification, resumable `fetch()` downloads, the same
`lib/engineInstall.ts` primitives) but stays deliberately stripped down for
the *binary*, because installing/updating llama.cpp itself is the OS package
manager's job, not vno's. Worth knowing the two aren't quite the same shape,
if you're reading one file expecting the other's conventions throughout.

**The binary isn't vendored at all.** `vno` doesn't download or build
llama.cpp itself:

- macOS: `brew install llama.cpp`
- Windows: `winget install --id ggml.llamacpp`
- Linux: not automated — `vno setup --llama` just prints manual instructions
  (no prebuilt asset story here the way whisper.cpp has one)

So there's no `bin/`, no local/global *binary* install root, and no
`vno-install.json` recording what got built. `lib/llama/llamacpp.ts:resolveBinary()`
just checks `config.llamaCliPath` (a manual override, explained below) and
then `PATH` — that's the entire resolution chain. Compare this to
whisper.cpp's `resolveBinary()` above, which never touches `PATH` at all.

**Why the manual override exists.** A fresh `winget install` in particular
often doesn't update `PATH` for the *current* shell — the classic "works
after you open a new terminal" problem. Rather than make every command
re-probe and hope, `vno setup --llama` falls back to asking for the binary's
path directly when PATH still doesn't see it right after an install, and
saves that into `config.llamaCliPath` (`~/.vno/config.json`). It's checked
before `PATH`, so once set it wins outright — there's no "prefer PATH unless
stale" logic to reason about.

**Models can come from vno's catalog, or be entirely yours to manage.**
`resolveInstallRoot`/`installPaths`/`bothInstallRoots` from
`lib/engineInstall.ts` (the same generic helpers whisper.cpp uses) are
reused here too, but **only for the `models/` folder** — "local" and
"global" mean "which folder do my `.gguf` files live in", nothing about the
binary. `vno setup --llama` asks that question once, creates the folder, and
offers a checkbox picker over `lib/webSources/llamaModels.ts`'s curated,
tiered catalog (repo, filename, approximate size, and — for every entry that
has one — a SHA-256). Picking one downloads it into that folder the same way
`downloadModel` works for whisper (mirror fallback, resumable via `.part` +
`Range`, GGUF-magic-bytes validation, then a checksum check against the
catalog's hash if it has one). A checksum mismatch is never auto-deleted —
`onChecksumMismatch` asks first, same contract as whisper's. You can just as
easily skip all of that and drop your own `.gguf` file into the folder
instead (or point `VNO_LLAMA_MODEL_PATH` at your own location); a
user-supplied file has no catalog entry, so `listModels()`/`resolveModel()`
fall back to the plain scan — readable, non-empty, starts with the `GGUF`
magic bytes — with no checksum to check.

`vno setup --remove-model` still works the same way as whisper.cpp's: it only
ever deletes files sitting inside one of the two `models/` folders above
(`isManagedModel`/`removeEngineModel` in `engineInstall.ts`, shared by both
engines), never anything found through `VNO_LLAMA_MODEL_PATH` or reached some
other way.

**The accelerator backend isn't detected either.** whisper.cpp's `accel` is
read straight out of `vno-install.json` because vno itself picked (or built)
a CUDA/Metal/CPU variant. llama.cpp has no such record to read anymore, so
`config.llamaAccel.backend` is set directly by `vno setup --llama`: `"metal"`
after a Homebrew install (Homebrew's formula is Metal-accelerated on Apple
silicon by default), or by asking the same "does this build have GPU
acceleration?" yes/not-sure/no question on Windows/Linux — there's nothing
else to read it from.

---

[← Back to the docs index](README.md) · [Transcription](transcription.md) · [Architecture](architecture.md)
