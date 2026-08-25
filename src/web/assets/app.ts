/* Entry point, loaded as a native ES module - no bundler, no build step. The
   server transpiles each module on the way out (web/server/assets.ts), so the
   browser resolves these imports directly and an edit shows up on reload.
   Wires the top bar buttons to their panels and boots the initial state load.
   Each screen/panel lives under js/: list.ts + deck.ts are the takes list and
   playback deck, js/panels/* are the four command modals, jobs.ts is the SSE
   job strip + page lifecycle. */
import { initDivider } from "./js/divider.ts";
import { initDragDrop } from "./js/dragdrop.ts";
import { revealFolder } from "./js/actions.ts";
import { showPlaceholder } from "./js/deck.ts";
import { openSettings } from "./js/panels/settings.ts";
import { openImport } from "./js/panels/import.ts";
import { openTranscribe } from "./js/panels/transcribe.ts";
import { openCleanup } from "./js/panels/cleanup.ts";
import { reloadState, connectEvents } from "./js/jobs.ts";
import { fail } from "./js/api.ts";
import { initPwa } from "./js/pwa.ts";

initDivider();
initDragDrop();
initPwa();

document.getElementById("btnFolder")!.addEventListener("click", function () { revealFolder(""); });
document.getElementById("btnSettings")!.addEventListener("click", openSettings);
document.getElementById("btnImport")!.addEventListener("click", openImport);
document.getElementById("btnTranscribe")!.addEventListener("click", function () { openTranscribe(null); });
document.getElementById("btnCleanup")!.addEventListener("click", openCleanup);

reloadState()
  .then(connectEvents)
  .catch(function (err: unknown) {
    showPlaceholder("Couldn't load notes");
    fail(err);
  });
