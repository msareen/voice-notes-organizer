// The right-hand playback deck: selecting a take, rendering/editing its
// transcript, and the destructive actions off it. Mutually referential with
// list.js - see the note there.
import { state, noteFor, mergeNote } from "./state.js";
import { dom } from "./dom.js";
import { api, toast, fail } from "./api.js";
import { fmt, fmtDur, fmtSize, extOf } from "./format.js";
import { button, modal, chip } from "./widgets.js";
import { renderList, markActive } from "./list.js";
import { revealFile } from "./actions.js";
import { openTranscribe } from "./panels/transcribe.js";

export function select(rel) {
  var note = noteFor(rel);
  if (!note) return showPlaceholder("Select a take to play");
  state.selectedRel = rel;
  markActive();

  dom.detail.classList.remove("playing");
  dom.body.textContent = "";

  var eyebrow = document.createElement("div");
  eyebrow.className = "eyebrow";
  eyebrow.appendChild(document.createTextNode("Now Playing"));
  var eq = document.createElement("span");
  eq.className = "eq";
  for (var b2 = 0; b2 < 5; b2++) eq.appendChild(document.createElement("i"));
  eyebrow.appendChild(eq);
  dom.body.appendChild(eyebrow);

  var head = document.createElement("div");
  head.className = "deck-head";
  var id = document.createElement("div");
  id.className = "deck-id";
  var h = document.createElement("h2");
  h.className = "deck-title";
  h.textContent = note.name;
  id.appendChild(h);
  if (note.title && note.title !== note.name) {
    var p = document.createElement("div");
    p.className = "deck-path";
    p.textContent = note.title;
    id.appendChild(p);
  }
  head.appendChild(id);

  var actions = document.createElement("div");
  actions.className = "deck-actions";
  actions.appendChild(button("Open file location", "", function () { revealFile(note.rel); },
    "Show this file in your file manager"));
  actions.appendChild(button(note.hasTranscript ? "Re-transcribe" : "Transcribe", "",
    function () { openTranscribe(note.rel); },
    "Run whisper on this recording"));
  actions.appendChild(button("Edit transcript", "", function () { startEdit(note); },
    "Edit the transcript text (timings are kept)"));
  actions.appendChild(button("Delete", "danger", function () { confirmDelete(note); },
    "Delete this recording and its transcript"));
  head.appendChild(actions);
  dom.body.appendChild(head);

  var readout = document.createElement("div");
  readout.className = "readout-line";
  if (note.dateStr) readout.appendChild(chip("REC", note.dateStr + " " + note.timeStr));
  readout.appendChild(chip("LEN", fmtDur(note.durationSec), "lenChipValue"));
  readout.appendChild(chip("SIZE", fmtSize(note.size)));
  readout.appendChild(chip("FMT", extOf(note.name)));
  dom.body.appendChild(readout);

  var audio = document.createElement("audio");
  audio.controls = true;
  audio.preload = "metadata";
  audio.src = note.src + "?t=" + encodeURIComponent(state.TOKEN);
  audio.addEventListener("play", function () { dom.detail.classList.add("playing"); });
  audio.addEventListener("pause", function () { dom.detail.classList.remove("playing"); });
  audio.addEventListener("ended", function () { dom.detail.classList.remove("playing"); });
  dom.body.appendChild(audio);

  var transcript = document.createElement("div");
  transcript.className = "transcript";
  transcript.id = "transcript";
  renderTranscript(transcript, note, audio);
  dom.body.appendChild(transcript);

  dom.placeholder.classList.add("hidden");
  dom.body.classList.remove("hidden");

  refreshSelected(rel);
}

/**
 * The list is built from a cached duration (fast startup on a big library -
 * see lib/notesCache.js), so it can be stale. Selecting a note is the one
 * moment worth paying for a fresh ffprobe: rechecks just this file and
 * patches the displayed duration + transcript in place, without touching
 * the <audio> element so playback in progress isn't interrupted.
 */
function refreshSelected(rel) {
  api("/api/notes/refresh", { method: "POST", body: { rel: rel } })
    .then(function (res) {
      mergeNote(res.note);
      renderList();
      if (state.selectedRel !== rel) return;
      var lenChip = document.getElementById("lenChipValue");
      if (lenChip) lenChip.textContent = fmtDur(res.note.durationSec);
      var transcriptHost = document.getElementById("transcript");
      var audio = dom.body.querySelector("audio");
      if (transcriptHost && audio) renderTranscript(transcriptHost, res.note, audio);
    })
    .catch(function () {
      // A stale cached duration/transcript isn't worth surfacing an error for.
    });
}

export function showPlaceholder(message) {
  state.selectedRel = null;
  dom.placeholder.textContent = "";
  var big = document.createElement("div");
  big.className = "big";
  big.textContent = message;
  dom.placeholder.appendChild(big);
  dom.placeholder.classList.remove("hidden");
  dom.body.classList.add("hidden");
}

function renderTranscript(host, note, audio) {
  host.textContent = "";
  if (note.cues && note.cues.length) {
    var cueEls = [];
    note.cues.forEach(function (cue) {
      var el = document.createElement("div");
      el.className = "cue";
      var t = document.createElement("span");
      t.className = "t";
      t.textContent = fmt(cue.start);
      var tx = document.createElement("span");
      tx.textContent = cue.text;
      el.appendChild(t);
      el.appendChild(tx);
      el.addEventListener("click", function () { audio.currentTime = cue.start; audio.play(); });
      host.appendChild(el);
      cueEls.push(el);
    });
    var activeIdx = -1;
    audio.addEventListener("timeupdate", function () {
      if (host._editing) return;
      var t = audio.currentTime;
      var idx = -1;
      for (var k = 0; k < note.cues.length; k++) {
        if (t >= note.cues[k].start && t < note.cues[k].end) { idx = k; break; }
        if (t >= note.cues[k].start) idx = k; // fall back to last-started cue
      }
      if (idx === activeIdx) return;
      if (activeIdx >= 0 && cueEls[activeIdx]) cueEls[activeIdx].classList.remove("active");
      activeIdx = idx;
      if (idx >= 0 && cueEls[idx]) {
        cueEls[idx].classList.add("active");
        cueEls[idx].scrollIntoView({ block: "nearest" });
      }
    });
  } else if (note.text) {
    var plain = document.createElement("div");
    plain.className = "plain";
    plain.textContent = note.text;
    host.appendChild(plain);
  } else {
    var empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = note.hasTranscript
      ? "(empty transcript)"
      : "No transcript yet — run \"vno transcribe\", or click Edit transcript to write one.";
    host.appendChild(empty);
  }
}

/* ---- Minimal transcript editor. Timed transcripts get one box per cue so
   the timings survive the round-trip; untimed ones get a single box. ---- */
function startEdit(note) {
  var host = document.getElementById("transcript");
  if (!host || host._editing) return;
  host._editing = true;
  host.textContent = "";

  var bar = document.createElement("div");
  bar.className = "editbar";
  var label = document.createElement("span");
  label.textContent = note.cues.length
    ? "Editing " + note.cues.length + " cue(s) — timings are preserved"
    : "Editing plain transcript";
  bar.appendChild(label);
  var spacer = document.createElement("span");
  spacer.style.flex = "1 1 auto";
  bar.appendChild(spacer);
  var saveBtn = button("Save", "primary", function () { save(); });
  var cancelBtn = button("Cancel", "", function () { stopEdit(note); });
  bar.appendChild(saveBtn);
  bar.appendChild(cancelBtn);
  host.appendChild(bar);

  var boxes = [];
  if (note.cues.length) {
    note.cues.forEach(function (cue) {
      var row = document.createElement("div");
      row.className = "edit-row";
      var t = document.createElement("span");
      t.className = "t";
      t.textContent = fmt(cue.start);
      var ta = document.createElement("textarea");
      ta.rows = 1;
      ta.value = cue.text;
      ta.addEventListener("input", function () { autoGrow(ta); });
      row.appendChild(t);
      row.appendChild(ta);
      host.appendChild(row);
      autoGrow(ta); // only meaningful once it's in the document
      boxes.push(ta);
    });
  } else {
    var ta2 = document.createElement("textarea");
    ta2.className = "full";
    ta2.value = note.text || "";
    host.appendChild(ta2);
    boxes.push(ta2);
  }
  if (boxes[0]) boxes[0].focus();

  function save() {
    saveBtn.disabled = true;
    cancelBtn.disabled = true;
    var payload = note.cues.length
      ? { rel: note.rel, cues: boxes.map(function (b) { return b.value; }) }
      : { rel: note.rel, text: boxes[0].value };
    api("/api/transcript", { method: "PUT", body: payload })
      .then(function (updated) {
        mergeNote(updated.note);
        host._editing = false;
        toast("Transcript saved", "ok");
        renderList();
        select(note.rel);
      })
      .catch(function (err) {
        saveBtn.disabled = false;
        cancelBtn.disabled = false;
        fail(err);
      });
  }

  // Ctrl/Cmd+Enter saves, Esc cancels — the two shortcuts anyone expects.
  host.addEventListener("keydown", function (e) {
    if (!host._editing) return;
    if (e.key === "Escape") { e.preventDefault(); stopEdit(note); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
}

function autoGrow(ta) {
  ta.style.height = "auto";
  ta.style.height = Math.min(320, ta.scrollHeight + 2) + "px";
}

function stopEdit(note) {
  var host = document.getElementById("transcript");
  if (host) host._editing = false;
  select(note.rel);
}

/* ---- Destructive actions ---- */
function confirmDelete(note) {
  modal({
    title: "Delete recording",
    message: "Permanently delete " + note.name + " and its transcript from disk? This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: function () {
      return api("/api/notes/delete", { method: "POST", body: { rel: note.rel } })
        .then(function (res) {
          state.NOTES = state.NOTES.filter(function (n) { return n.rel !== note.rel; });
          if (state.selectedRel === note.rel) state.selectedRel = null;
          renderList();
          if (state.selectedRel) select(state.selectedRel);
          else if (state.NOTES.length) select(state.NOTES[0].rel);
          else showPlaceholder("No takes left in this folder");
          toast("Deleted " + res.removed + " file(s)", "ok");
        });
    }
  });
}
