// Shared mutable app state. A single object (not exported `let` bindings) so
// every module that imports `state` sees the same live object and can write
// to its fields directly - ES module bindings can't be reassigned from
// outside the module that declares them, but object properties can.
export const state = {
  TOKEN: window.__VNO_TOKEN,
  NOTES: [],
  CONFIG: {},
  MODELS: [],
  MODEL_AVAILABILITY: {},
  LANGUAGES: [],
  WHISPER: true,
  FFMPEG: true,
  selectedRel: null,
  alive: true
};

export function noteFor(rel) {
  for (var i = 0; i < state.NOTES.length; i++) if (state.NOTES[i].rel === rel) return state.NOTES[i];
  return null;
}

export function mergeNote(updated) {
  for (var i = 0; i < state.NOTES.length; i++) {
    if (state.NOTES[i].rel === updated.rel) { state.NOTES[i] = updated; return; }
  }
  state.NOTES.push(updated);
}
