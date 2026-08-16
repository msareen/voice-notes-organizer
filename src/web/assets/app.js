/* Entry point, loaded as a native ES module - no bundler, no build step. Wires
   the top bar buttons to their panels and boots the initial state load. Each
   screen/panel lives under js/: list.js + deck.js are the takes list and
   playback deck, js/panels/* are the four command modals, jobs.js is the SSE
   job strip + page lifecycle. */
import { initDivider } from "./js/divider.js";
import { initDragDrop } from "./js/dragdrop.js";
import { revealFolder } from "./js/actions.js";
import { showPlaceholder } from "./js/deck.js";
import { openSettings } from "./js/panels/settings.js";
import { openImport } from "./js/panels/import.js";
import { openTranscribe } from "./js/panels/transcribe.js";
import { openCleanup } from "./js/panels/cleanup.js";
import { reloadState, connectEvents } from "./js/jobs.js";
import { fail } from "./js/api.js";

initDivider();
initDragDrop();

document.getElementById("btnFolder").addEventListener("click", function () { revealFolder(""); });
document.getElementById("btnSettings").addEventListener("click", openSettings);
document.getElementById("btnImport").addEventListener("click", openImport);
document.getElementById("btnTranscribe").addEventListener("click", function () { openTranscribe(null); });
document.getElementById("btnCleanup").addEventListener("click", openCleanup);

reloadState()
  .then(connectEvents)
  .catch(function (err) {
    showPlaceholder("Couldn't load notes");
    fail(err);
  });
