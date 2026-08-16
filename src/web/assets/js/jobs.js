// Lifecycle: the page owns the CLI. A heartbeat keeps the server up; closing
// the tab tells it to exit, and if the server goes away first the page drops
// into a read-only "disconnected" state. Also owns the job strip, which
// streams one long-running CLI operation at a time over SSE.
import { state, noteFor } from "./state.js";
import { dom } from "./dom.js";
import { api, toast, fail } from "./api.js";
import { modal } from "./widgets.js";
import { renderList } from "./list.js";
import { select, showPlaceholder } from "./deck.js";

var jobstrip = document.getElementById("jobstrip");
var jobTitle = document.getElementById("jobTitle");
var jobBar = document.getElementById("jobBar");
var jobPct = document.getElementById("jobPct");
var opButtons = ["btnImport", "btnTranscribe", "btnCleanup"].map(function (id) {
  return document.getElementById(id);
});
var currentJob = null;
var logBox = null;
var hideTimer = null;

function renderJob(j) {
  currentJob = j;
  if (!j) { jobstrip.classList.remove("on"); return; }
  jobstrip.classList.add("on");
  jobTitle.textContent = j.title;
  var pct = j.total ? Math.min(100, Math.round((j.done / j.total) * 100)) : 0;
  jobBar.style.width = pct + "%";
  jobPct.textContent = j.running ? pct + "%" : (j.error ? "failed" : "done");
  opButtons.forEach(function (b) { b.disabled = !!j.running; });
  if (logBox) renderLog();
  clearTimeout(hideTimer);
  if (!j.running) {
    if (j.error) fail(new Error(j.error));
    hideTimer = setTimeout(function () {
      if (currentJob && !currentJob.running) jobstrip.classList.remove("on");
    }, 10000);
  }
}

function renderLog() {
  if (!logBox) return;
  logBox.textContent = "";
  var lines = (currentJob && currentJob.lines) || [];
  lines.forEach(function (line) {
    var el = document.createElement("div");
    if (line.indexOf("FAILED") === 0) el.className = "bad";
    el.textContent = line;
    logBox.appendChild(el);
  });
  logBox.scrollTop = logBox.scrollHeight;
}

document.getElementById("btnLog").addEventListener("click", function () {
  if (logBox) { logBox.remove(); logBox = null; return; }
  logBox = document.createElement("div");
  logBox.className = "logbox";
  document.body.appendChild(logBox);
  renderLog();
});

export function connectEvents() {
  var es = new EventSource("/api/events?t=" + encodeURIComponent(state.TOKEN));
  es.addEventListener("job", function (e) { renderJob(JSON.parse(e.data)); });
  es.addEventListener("notes", function () { reloadState(); });
}

export function reloadState() {
  return api("/api/state").then(function (s) {
    state.NOTES = s.notes;
    state.CONFIG = s.config;
    state.MODELS = s.models;
    state.MODEL_AVAILABILITY = s.modelAvailability || {};
    state.LANGUAGES = s.languages || [];
    state.WHISPER = s.whisper;
    state.FFMPEG = s.ffmpeg;
    document.getElementById("folderLabel").textContent = state.CONFIG.rootLabel;
    renderList();
    if (state.selectedRel && noteFor(state.selectedRel)) select(state.selectedRel);
    else if (state.NOTES.length) select(state.NOTES[0].rel);
    else showPlaceholder("Nothing here yet — use Import to bring recordings in");
    if (s.job) renderJob(s.job);
    return s;
  });
}

function goodbye() {
  if (!state.alive) return;
  state.alive = false;
  try {
    var blob = new Blob([JSON.stringify({ token: state.TOKEN })], { type: "text/plain;charset=UTF-8" });
    navigator.sendBeacon("/api/bye", blob);
  } catch (e) {}
}
window.addEventListener("pagehide", goodbye);
window.addEventListener("beforeunload", goodbye);

var missed = 0;
setInterval(function () {
  if (!state.alive) return;
  api("/api/ping", { method: "POST", body: {} })
    .then(function () { missed = 0; setLive(true); })
    .catch(function () { if (++missed >= 2) setLive(false); });
}, 3000);

function setLive(on) {
  dom.live.classList.toggle("dead", !on);
  dom.live.title = on ? "Connected to the vno server" : "Disconnected — the vno server has stopped";
  if (!on && !document.querySelector(".toast.err")) {
    toast("vno server stopped — this page is now read-only", "err");
  }
}

document.getElementById("btnQuit").addEventListener("click", function () {
  modal({
    title: "Quit vno",
    message: "Stop the server and end the CLI session? You can close this tab afterwards.",
    confirmLabel: "Quit",
    danger: true,
    onConfirm: function () {
      return api("/api/bye", { method: "POST", body: { quit: true } }).then(function () {
        state.alive = false;
        setLive(false);
      });
    }
  });
});
