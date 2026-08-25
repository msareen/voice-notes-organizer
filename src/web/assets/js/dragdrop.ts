import { state } from "./state.ts";
import { toast, fail } from "./api.ts";

/* ---- Drag-and-drop import: drop audio/video files anywhere on the page.
   Each file is POSTed raw (no multipart) to /api/upload, which streams it
   straight to disk - see server/routes/import.ts:upload. Kept as its own
   fixed regex rather than derived from state.CONFIG.mediaExtensions (the
   server's lib/import/sync.ts:MEDIA_EXTENSIONS is authoritative; this only needs to
   avoid uploading obviously-wrong files before the server rejects them). ---- */
var MEDIA_EXT_RE = /\.(mp3|wav|m4a|aac|flac|ogg|oga|opus|wma|aiff|amr|3gp|mp4|m4v|mov|mkv|webm|avi)$/i;

export function initDragDrop(): void {
  var overlay: HTMLDivElement | null = null;
  var dragDepth = 0;

  function hasFiles(e: DragEvent) {
    var types = e.dataTransfer && e.dataTransfer.types;
    return !!types && Array.prototype.indexOf.call(types, "Files") !== -1;
  }
  function showOverlay() {
    if (overlay) return;
    overlay = document.createElement("div");
    overlay.className = "dropzone";
    overlay.innerHTML = '<div class="dropzone-msg">Drop audio/video files to import</div>';
    document.body.appendChild(overlay);
  }
  function hideOverlay() {
    dragDepth = 0;
    if (overlay) { overlay.remove(); overlay = null; }
  }

  window.addEventListener("dragenter", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    showOverlay();
  });
  window.addEventListener("dragover", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
  });
  window.addEventListener("dragleave", function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) hideOverlay();
  });
  window.addEventListener("drop", function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    hideOverlay();
    if (!state.alive) return fail(new Error("vno server stopped - reload the page"));
    uploadDropped(Array.prototype.slice.call(e.dataTransfer!.files || []));
  });
}

function uploadDropped(files: File[]): void {
  var audio = files.filter(function (f) { return MEDIA_EXT_RE.test(f.name); });
  var skippedType = files.length - audio.length;
  if (!audio.length) return toast("No audio or video files in that drop", "err");

  toast("Importing " + audio.length + " file(s)…");
  var i = 0, imported = 0, skipped = 0, failed = 0;

  function next(): void {
    if (i >= audio.length) {
      var msg = "Imported " + imported + " file(s)" +
        (skipped ? ", " + skipped + " already there" : "") +
        (failed ? ", " + failed + " failed" : "") +
        (skippedType ? ", " + skippedType + " skipped (not audio/video)" : "");
      return toast(msg, failed ? "err" : "ok");
    }
    var file = audio[i++];
    var url = "/api/upload?name=" + encodeURIComponent(file.name) + "&t=" + encodeURIComponent(state.TOKEN);
    fetch(url, { method: "POST", headers: { "X-VNO-Token": state.TOKEN }, body: file })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (out: any) {
          if (!res.ok) throw new Error(out.error || ("HTTP " + res.status));
          return out;
        });
      })
      .then(function (out: any) { if (out && out.skipped) skipped++; else imported++; })
      .catch(function () { failed++; })
      .then(next);
  }
  next();
}
