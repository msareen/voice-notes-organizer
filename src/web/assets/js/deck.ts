// The right-hand playback deck: selecting a take, rendering/editing its
// transcript, and the destructive actions off it. Mutually referential with
// list.ts - see the note there.
import { state, noteFor, mergeNote } from "./state.ts";
import { dom } from "./dom.ts";
import { api, toast, fail } from "./api.ts";
import { fmt, fmtDur, fmtSize, extOf, isVideo } from "./format.ts";
import { button, modal, chip } from "./widgets.ts";
import { icon } from "./icons.ts";
import { renderList, markActive } from "./list.ts";
import { markInto } from "./search.ts";
import { revealFile } from "./actions.ts";
import { openTranscribe } from "./panels/transcribe.ts";
import { renderMarkdown } from "./markdown.ts";
import type { Cue, Note } from "../../../types.ts";

/**
 * The deck's playback element - an <audio> for most recordings, a <video> for
 * one of the video extensions in format.ts:isVideo. Both are HTMLMediaElement,
 * so everything past `buildTransport` (play/pause, currentTime, playbackRate,
 * the timeupdate/ended events) works identically either way; only the element
 * tag and whether it's visible differ. Also carries the hook that lets a
 * transcript arriving after the deck was drawn re-tick the scrub rail without
 * disturbing playback.
 */
interface DeckMedia extends HTMLMediaElement {
  _retick?: (cues: Cue[] | null | undefined) => void;
}

/** One run of transcript text the filter term can be re-marked into. */
interface HighlightTarget {
  el: HTMLElement;
  text: string;
}

/**
 * The transcript container. `_editing` is what keeps the timeupdate highlight
 * and the filter's re-marking away from the editor's unsaved textareas.
 */
interface TranscriptHost extends HTMLElement {
  _hlTargets?: HighlightTarget[];
  _editing?: boolean;
}

/** Which of the deck's two content tabs is showing. Reset on every select(). */
var activeDeckTab: "transcript" | "summary" = "transcript";

export function select(rel: string): void {
  var note = noteFor(rel);
  if (!note) return showPlaceholder("Select a take to play");
  state.selectedRel = rel;
  activeDeckTab = "transcript";
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
  actions.appendChild(button("Open file location", "", function () { revealFile(note!.rel); },
    "Show this file in your file manager"));
  actions.appendChild(button(note.hasTranscript ? "Re-transcribe" : "Transcribe", "",
    function () { openTranscribe(note!.rel); },
    "Run whisper on this recording"));
  actions.appendChild(button(note.hasSummary ? "Re-summarize" : "Summarize", "",
    function () { requestSummarize(note!); },
    "Summarize this recording's transcript with llama.cpp (optional)"));
  actions.appendChild(button("Edit transcript", "", function () { startEdit(note!); },
    "Edit the transcript text (timings are kept)"));
  actions.appendChild(button("Delete", "danger", function () { confirmDelete(note!); },
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

  var audio = buildTransport(note, dom.body);
  audio.addEventListener("play", function () { dom.detail.classList.add("playing"); });
  audio.addEventListener("pause", function () { dom.detail.classList.remove("playing"); });
  audio.addEventListener("ended", function () { dom.detail.classList.remove("playing"); });

  dom.body.appendChild(buildDeckTabs(note));

  var transcript = document.createElement("div") as TranscriptHost;
  transcript.className = "transcript";
  transcript.id = "transcript";
  renderDeckContent(transcript, note, audio);
  dom.body.appendChild(transcript);

  dom.placeholder.classList.add("hidden");
  dom.body.classList.remove("hidden");
  // After the deck is visible: scrolling the first hit into view needs the
  // transcript laid out, and a hidden body has no layout to scroll.
  if (state.searchTerm) highlightTranscript(true);

  refreshSelected(rel);
}

/* ---- Transport ----------------------------------------------------------
   The deck plays through its own controls rather than the browser's default
   <audio controls>/<video controls> chrome, which can't be themed and looks
   like a different application on every platform. The media element is still
   the single source of playback truth - it stays in the DOM (without native
   controls) and everything below only reads from it or seeks it, so cue
   clicks and the timeupdate-driven transcript highlighting keep working
   unchanged regardless of whether it's audio or video.
   Returns the media element, appended along with its controls to `host`. */
function buildTransport(note: Note, host: HTMLElement): DeckMedia {
  var video = isVideo(note.name);
  var audio = document.createElement(video ? "video" : "audio") as DeckMedia;
  audio.preload = "metadata";
  audio.src = note.src + "?t=" + encodeURIComponent(state.TOKEN);
  // playsinline keeps a mobile browser from hijacking playback into its own
  // fullscreen native player, which would bypass this transport entirely.
  if (video) (audio as unknown as HTMLVideoElement).playsInline = true;

  if (video) {
    var frame = document.createElement("div");
    frame.className = "video-frame";
    frame.appendChild(audio);
    host.appendChild(frame);
  }

  var wrap = document.createElement("div");
  wrap.className = "transport";

  var playIcon = icon("play", 18);
  var playBtn = document.createElement("button");
  playBtn.type = "button";
  playBtn.className = "play";
  playBtn.setAttribute("aria-label", "Play");
  playBtn.appendChild(playIcon);
  playBtn.addEventListener("click", toggle);
  wrap.appendChild(playBtn);

  var main = document.createElement("div");
  main.className = "transport-main";

  var scrub = document.createElement("div");
  scrub.className = "scrub";
  scrub.tabIndex = 0;
  scrub.setAttribute("role", "slider");
  scrub.setAttribute("aria-label", "Seek");
  scrub.setAttribute("aria-valuemin", "0");
  var rail = document.createElement("div");
  rail.className = "scrub-rail";
  var fill = document.createElement("i");
  fill.className = "scrub-fill";
  rail.appendChild(fill);
  scrub.appendChild(rail);
  var ticks = document.createElement("div");
  ticks.className = "scrub-ticks";
  scrub.appendChild(ticks);
  var thumb = document.createElement("div");
  thumb.className = "scrub-thumb";
  scrub.appendChild(thumb);
  main.appendChild(scrub);

  var meta = document.createElement("div");
  meta.className = "transport-meta";
  var now = document.createElement("span");
  now.className = "tc now";
  now.textContent = fmtDur(0);
  var total = document.createElement("span");
  total.className = "tc total";
  total.textContent = fmtDur(note.durationSec);
  meta.appendChild(now);
  meta.appendChild(total);
  main.appendChild(meta);
  wrap.appendChild(main);

  var keys = document.createElement("div");
  keys.className = "transport-keys";
  keys.appendChild(button("−10s", "", function () { nudge(-10); }, "Back ten seconds"));
  keys.appendChild(button("+10s", "", function () { nudge(10); }, "Forward ten seconds"));
  var RATES = [1, 1.25, 1.5, 2, 0.75];
  var rateIdx = 0;
  var rateBtn = button("1×", "", function () {
    rateIdx = (rateIdx + 1) % RATES.length;
    audio.playbackRate = RATES[rateIdx];
    rateBtn.textContent = RATES[rateIdx] + "×";
  }, "Playback speed");
  keys.appendChild(rateBtn);
  wrap.appendChild(keys);

  // Video already lives in its own frame above the transport (appended
  // there before `wrap` existed); audio has no visible presence of its own,
  // so it just rides along inside the transport bar.
  if (!video) wrap.appendChild(audio);
  host.appendChild(wrap);

  // A duration the browser hasn't parsed yet reads as NaN, and a stream-ish
  // container can report Infinity, so the note's own (ffprobe'd) length is
  // the fallback until metadata lands.
  function duration(): number {
    if (isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    return note.durationSec || 0;
  }

  function toggle() {
    if (!audio.paused) return audio.pause();
    // play() rejects on the ordinary "paused again before it started" race
    // (and when the browser blocks playback outright), which isn't worth an
    // unhandled rejection in the console.
    var started = audio.play();
    if (started && started.catch) started.catch(function () {});
  }

  function nudge(delta: number) {
    var d = duration();
    var t = audio.currentTime + delta;
    if (t < 0) t = 0;
    if (d && t > d) t = d;
    audio.currentTime = t;
  }

  function seekToClientX(clientX: number) {
    var box = scrub.getBoundingClientRect();
    var frac = box.width ? (clientX - box.left) / box.width : 0;
    var d = duration();
    if (!d) return;
    audio.currentTime = Math.max(0, Math.min(d, frac * d));
  }

  function paint() {
    var d = duration();
    var pct = d ? Math.max(0, Math.min(100, (audio.currentTime / d) * 100)) : 0;
    fill.style.width = pct + "%";
    thumb.style.left = pct + "%";
    now.textContent = fmtDur(audio.currentTime);
    total.textContent = fmtDur(d || null);
    scrub.setAttribute("aria-valuemax", String(Math.round(d)));
    scrub.setAttribute("aria-valuenow", String(Math.round(audio.currentTime)));
    scrub.setAttribute("aria-valuetext", fmtDur(audio.currentTime) + " of " + fmtDur(d || null));
  }

  // One tick per cue, thinned out on a long transcript so the rail stays a
  // readable map rather than a solid block. `cues` is re-read rather than
  // captured, so a transcript that arrives after the deck was drawn (a
  // refresh, or a finished transcribe job) can re-tick without disturbing
  // playback - see `audio._retick` below.
  var cues: Cue[] = note.cues || [];
  function paintTicks() {
    ticks.textContent = "";
    var d = duration();
    if (!d || !cues.length) return;
    var step = Math.ceil(cues.length / 200);
    for (var i = 0; i < cues.length; i += step) {
      var pct = (cues[i].start / d) * 100;
      if (pct < 0 || pct > 100) continue;
      var tick = document.createElement("i");
      tick.style.left = pct + "%";
      ticks.appendChild(tick);
    }
  }
  audio._retick = function (next) {
    cues = next || [];
    paintTicks();
  };

  audio.addEventListener("timeupdate", paint);
  audio.addEventListener("seeking", paint);
  audio.addEventListener("loadedmetadata", function () { paint(); paintTicks(); });
  audio.addEventListener("play", function () {
    playBtn.replaceChild(icon("pause", 18), playBtn.firstChild!);
    playBtn.setAttribute("aria-label", "Pause");
  });
  function showPlay() {
    playBtn.replaceChild(icon("play", 18), playBtn.firstChild!);
    playBtn.setAttribute("aria-label", "Play");
  }
  audio.addEventListener("pause", showPlay);
  audio.addEventListener("ended", showPlay);

  var dragging = false;
  scrub.addEventListener("pointerdown", function (e) {
    dragging = true;
    scrub.setPointerCapture(e.pointerId);
    seekToClientX(e.clientX);
    e.preventDefault();
  });
  scrub.addEventListener("pointermove", function (e) {
    if (dragging) seekToClientX(e.clientX);
  });
  function endDrag(e: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    try { scrub.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  scrub.addEventListener("pointerup", endDrag);
  scrub.addEventListener("pointercancel", endDrag);
  scrub.addEventListener("keydown", function (e) {
    var d = duration();
    if (e.key === "ArrowRight") { e.preventDefault(); nudge(5); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); nudge(-5); }
    else if (e.key === "Home") { e.preventDefault(); audio.currentTime = 0; }
    else if (e.key === "End" && d) { e.preventDefault(); audio.currentTime = d; }
    else if (e.key === " " || e.key === "Enter") { e.preventDefault(); toggle(); }
  });

  paint();
  paintTicks();
  return audio;
}

/**
 * The list is built from a cached duration (fast startup on a big library -
 * see lib/notesCache.ts), so it can be stale. Selecting a note is the one
 * moment worth paying for a fresh ffprobe: rechecks just this file and
 * patches the displayed duration + transcript in place, without touching
 * the <audio> element so playback in progress isn't interrupted.
 */
function refreshSelected(rel: string): void {
  api<{ note: Note }>("/api/notes/refresh", { method: "POST", body: { rel: rel } })
    .then(function (res) {
      mergeNote(res.note);
      renderList();
      if (state.selectedRel !== rel) return;
      var lenChip = document.getElementById("lenChipValue");
      if (lenChip) lenChip.textContent = fmtDur(res.note.durationSec);
      var transcriptHost = document.getElementById("transcript") as TranscriptHost | null;
      var audio = dom.body.querySelector("audio, video") as DeckMedia | null;
      if (transcriptHost && audio) {
        renderDeckContent(transcriptHost, res.note, audio);
        if (audio._retick) audio._retick(res.note.cues);
      }
    })
    .catch(function () {
      // A stale cached duration/transcript isn't worth surfacing an error for.
    });
}

export function showPlaceholder(message: string): void {
  state.selectedRel = null;
  dom.placeholder.textContent = "";
  var big = document.createElement("div");
  big.className = "big";
  big.textContent = message;
  dom.placeholder.appendChild(big);
  dom.placeholder.classList.remove("hidden");
  dom.body.classList.add("hidden");
}

/** The Transcript/Summary tab strip above the deck's content host. */
function buildDeckTabs(note: Note): HTMLDivElement {
  var rel = note.rel;
  var strip = document.createElement("div");
  strip.className = "deck-tabs";

  function switchTo(tab: "transcript" | "summary") {
    if (activeDeckTab === tab) return;
    activeDeckTab = tab;
    transcriptTab.classList.toggle("active", tab === "transcript");
    summaryTab.classList.toggle("active", tab === "summary");
    var host = document.getElementById("transcript") as TranscriptHost | null;
    var audio = dom.body.querySelector("audio, video") as DeckMedia | null;
    var current = noteFor(rel);
    if (host && audio && current) renderDeckContent(host, current, audio);
  }

  var transcriptTab = button("Transcript", "tab active", function () { switchTo("transcript"); });
  var summaryTab = button("Summary", "tab", function () { switchTo("summary"); });
  strip.appendChild(transcriptTab);
  strip.appendChild(summaryTab);
  return strip;
}

function renderDeckContent(host: TranscriptHost, note: Note, audio: DeckMedia): void {
  if (activeDeckTab === "summary") renderSummaryTab(host, note);
  else renderTranscriptTab(host, note, audio);
}

function renderSummaryTab(host: TranscriptHost, note: Note): void {
  host.textContent = "";
  host._hlTargets = [];
  if (note.summary) {
    var rendered = document.createElement("div");
    rendered.className = "summary-md";
    // note.summary is the model's own output, never trusted markup -
    // renderMarkdown escapes all text before composing any HTML around it.
    rendered.innerHTML = renderMarkdown(note.summary);
    host.appendChild(rendered);
    return;
  }
  var empty = document.createElement("div");
  empty.className = "empty";
  empty.textContent = state.SUMMARIZATION && state.SUMMARIZATION.available
    ? "No summary yet — click Summarize above."
    : "Summarization isn't set up. Run `vno setup --llama` in a terminal to add it (optional).";
  host.appendChild(empty);
}

/** Fires the Summarize action for the currently selected note - the info modal for the not-set-up case, a fire-and-forget job start otherwise. */
function requestSummarize(note: Note): void {
  if (!state.SUMMARIZATION || !state.SUMMARIZATION.available) {
    modal({
      title: "Summarization isn't set up",
      message: "This is an optional feature. Run `vno setup --llama` in a terminal to install llama.cpp and pick a model, then come back here.",
    });
    return;
  }
  if (!note.hasTranscript) {
    toast("Transcribe this recording first", "error");
    return;
  }
  api("/api/summarize", { method: "POST", body: { rel: note.rel } })
    .then(function () { toast("Summarizing…", "ok"); })
    .catch(fail);
}

function renderTranscriptTab(host: TranscriptHost, note: Note, audio: DeckMedia): void {
  host.textContent = "";
  // What the filter box is searching for gets marked here too, so following a
  // transcript hit from the list lands you on the words that matched. The
  // targets are remembered so `highlightTranscript` can re-mark them as the
  // query changes without rebuilding the deck.
  host._hlTargets = [];
  if (note.cues && note.cues.length) {
    var cueEls: HTMLDivElement[] = [];
    note.cues.forEach(function (cue) {
      var el = document.createElement("div");
      el.className = "cue";
      var t = document.createElement("span");
      t.className = "t";
      t.textContent = fmt(cue.start);
      var tx = document.createElement("span");
      markInto(tx, cue.text, state.searchTerm);
      host._hlTargets!.push({ el: tx, text: cue.text });
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
    markInto(plain, note.text, state.searchTerm);
    host._hlTargets.push({ el: plain, text: note.text });
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

/**
 * Re-marks the open transcript for the current filter term. Called on every
 * filter pass, so it only touches the text nodes rather than re-rendering the
 * deck - and never while the editor owns the transcript, whose textareas are
 * the user's unsaved work.
 */
export function highlightTranscript(scrollToFirst?: boolean): void {
  var host = document.getElementById("transcript") as TranscriptHost | null;
  if (!host || host._editing || !host._hlTargets) return;
  var first: HTMLElement | null = null;
  host._hlTargets.forEach(function (target) {
    if (markInto(target.el, target.text, state.searchTerm) && !first) first = target.el;
  });
  if (scrollToFirst && first) (first as HTMLElement).scrollIntoView({ block: "nearest" });
}

/* ---- Minimal transcript editor. Timed transcripts get one box per cue so
   the timings survive the round-trip; untimed ones get a single box. ---- */
function startEdit(note: Note): void {
  var host = document.getElementById("transcript") as TranscriptHost | null;
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

  var boxes: HTMLTextAreaElement[] = [];
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
      host!.appendChild(row);
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
    api<{ note: Note }>("/api/transcript", { method: "PUT", body: payload })
      .then(function (updated) {
        mergeNote(updated.note);
        host!._editing = false;
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
    if (!host!._editing) return;
    if (e.key === "Escape") { e.preventDefault(); stopEdit(note); }
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); save(); }
  });
}

function autoGrow(ta: HTMLTextAreaElement): void {
  ta.style.height = "auto";
  ta.style.height = Math.min(320, ta.scrollHeight + 2) + "px";
}

function stopEdit(note: Note): void {
  var host = document.getElementById("transcript") as TranscriptHost | null;
  if (host) host._editing = false;
  select(note.rel);
}

/* ---- Destructive actions ---- */
function confirmDelete(note: Note): void {
  modal({
    title: "Delete recording",
    message: "Permanently delete " + note.name + " and its transcript from disk? This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    onConfirm: function () {
      return api<{ removed: number }>("/api/notes/delete", { method: "POST", body: { rel: note.rel } })
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
