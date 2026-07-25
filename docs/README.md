# Voice Note Organizer — documentation

The [main README](../README.md) covers install and the four commands you need
day to day. These pages cover everything else.

| Page | What's in it |
| --- | --- |
| [The browser UI](ui.md) | Every pane, button, dialog and keyboard shortcut in `vno visualize` |
| [CLI reference](cli-reference.md) | Every command and flag, in full |
| [Configuration](configuration.md) | `~/.vno/config.json`, key by key — including the options only editable by hand |
| [Import & sync](import-and-sync.md) | How volumes are detected, why imports land flat, remembered devices |
| [Transcription](transcription.md) | Whisper models, translation, the `.vtt` format, re-transcribing |
| [Troubleshooting](troubleshooting.md) | Whisper/ffmpeg not found, no volumes detected, port and browser issues |
| [Architecture](architecture.md) | Source layout, the local HTTP API, and how to work on the code |

## Where to start

- **Just installed it?** Run `vno setup` to get ffmpeg + whisper in place
  ([what it does](cli-reference.md#vno-setup)), then
  [CLI reference](cli-reference.md) → [Configuration](configuration.md).
- **Living in the browser UI?** [The browser UI](ui.md).
- **Recorder buries files in nested folders?** [Import & sync](import-and-sync.md).
- **Transcripts wrong, slow, or in the wrong language?** [Transcription](transcription.md).
- **Something's broken?** [Troubleshooting](troubleshooting.md).
- **Contributing?** [Architecture](architecture.md).
