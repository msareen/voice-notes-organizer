import { state } from "./state.js";

// Nothing in the page can install these, so the warning sends you to the CLI,
// where `vno setup` will offer to do it. Shared by the Transcribe and Import
// panels, which both start a whisper run.
export function missingDeps() {
  var missing = [];
  if (!state.FFMPEG) missing.push("ffmpeg");
  if (!state.WHISPER) missing.push("whisper");
  if (!missing.length) return null;
  return missing.join(" and ") + (missing.length > 1 ? " aren't" : " isn't") +
    " on your PATH. Run `vno setup` in a terminal to install " +
    (missing.length > 1 ? "them." : "it.");
}
