// Shared mutable app state. A single object (not exported `let` bindings) so
// every module that imports `state` sees the same live object and can write
// to its fields directly - ES module bindings can't be reassigned from
// outside the module that declares them, but object properties can.
import type { Note, StateConfig, Theme } from "../../../types.ts";

declare global {
  interface Window {
    /** Inlined into the HTML by web/page.ts, so it never travels in an asset URL. */
    __VNO_TOKEN: string;
  }
}

export interface AppState {
  TOKEN: string;
  NOTES: Note[];
  /** Empty until the first /api/state lands - see the cast below. */
  CONFIG: StateConfig;
  MODELS: string[];
  MODEL_AVAILABILITY: Record<string, boolean>;
  LANGUAGES: readonly { code: string; label: string }[];
  THEMES: readonly Theme[];
  WHISPER: boolean;
  FFMPEG: boolean;
  selectedRel: string | null;
  searchTerm: string;
  alive: boolean;
}

export const state: AppState = {
  TOKEN: window.__VNO_TOKEN,
  NOTES: [],
  // Typed as a loaded config rather than `StateConfig | null`: it's replaced
  // wholesale by the first /api/state before anything reads a field, and the
  // nullable form would put a guard in front of every `state.CONFIG.x` in the
  // panels for a state that never reaches them.
  CONFIG: {} as StateConfig,
  MODELS: [],
  MODEL_AVAILABILITY: {},
  LANGUAGES: [],
  THEMES: [],
  WHISPER: true,
  FFMPEG: true,
  selectedRel: null,
  // Current filter-box term, normalised + lowercased (see js/search.ts). Shared
  // so the deck can highlight the same term it was filtered by.
  searchTerm: "",
  alive: true
};

export function noteFor(rel: string): Note | null {
  for (var i = 0; i < state.NOTES.length; i++) if (state.NOTES[i].rel === rel) return state.NOTES[i];
  return null;
}

export function mergeNote(updated: Note): void {
  for (var i = 0; i < state.NOTES.length; i++) {
    if (state.NOTES[i].rel === updated.rel) { state.NOTES[i] = updated; return; }
  }
  state.NOTES.push(updated);
}
