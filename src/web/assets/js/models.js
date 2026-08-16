import { state } from "./state.js";

// Marks each model option with whether it's already downloaded, so picking
// one that isn't doesn't silently kick off a gigabyte download. Shared by
// the Settings and Transcribe panels.
export function modelOptions() {
  return state.MODELS.map(function (m) {
    var known = Object.prototype.hasOwnProperty.call(state.MODEL_AVAILABILITY, m);
    var tag = known ? (state.MODEL_AVAILABILITY[m] ? "downloaded" : "will download") : "";
    return { label: tag ? m + " (" + tag + ")" : m, value: m };
  });
}
