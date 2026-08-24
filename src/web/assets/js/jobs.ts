// Lifecycle: the page owns the CLI. A heartbeat keeps the server up; closing
// the tab tells it to exit, and if the server goes away first the page drops
// into a read-only "disconnected" state. Also owns the job strip, which
// streams one long-running CLI operation at a time over SSE.
import { state, noteFor } from "./state.ts";
import { dom } from "./dom.ts";
import { api, toast, fail } from "./api.ts";
import { modal } from "./widgets.ts";
import { applyTheme } from "./theme.ts";
import { renderList } from "./list.ts";
import { select, showPlaceholder } from "./deck.ts";
import type { Job, StateResponse } from "../../../types.ts";

var jobstrip = document.getElementById("jobstrip")!;
var jobTitle = document.getElementById("jobTitle")!;
var jobBar = document.getElementById("jobBar")!;
var jobPct = document.getElementById("jobPct")!;
var opButtons = ["btnImport", "btnTranscribe", "btnCleanup"].map(function (id) {
  return document.getElementById(id) as HTMLButtonElement;
});
var currentJob: Job | null = null;
var logBox: HTMLDivElement | null = null;
var hideTimer: ReturnType<typeof setTimeout> | undefined;

function renderJob(j: Job | null) {
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
  var body = logBox.querySelector(".logbox-body") as HTMLElement;
  body.textContent = "";
  var lines = (currentJob && currentJob.lines) || [];
  lines.forEach(function (line) {
    var el = document.createElement("div");
    if (line.indexOf("FAILED") === 0) el.className = "bad";
    el.textContent = line;
    body.appendChild(el);
  });
  body.scrollTop = body.scrollHeight;
}

function closeLog() {
  if (!logBox) return;
  logBox.remove();
  logBox = null;
}

document.getElementById("btnLog")!.addEventListener("click", function () {
  if (logBox) { closeLog(); return; }
  logBox = document.createElement("div");
  logBox.className = "logbox";
  var head = document.createElement("div");
  head.className = "logbox-head";
  var close = document.createElement("button");
  close.className = "btn icon logbox-close";
  close.title = "Close log";
  close.setAttribute("aria-label", "Close log");
  close.textContent = "×";
  close.addEventListener("click", closeLog);
  head.appendChild(close);
  var body = document.createElement("div");
  body.className = "logbox-body";
  logBox.appendChild(head);
  logBox.appendChild(body);
  document.body.appendChild(logBox);
  renderLog();
});

export function connectEvents(): void {
  var es = new EventSource("/api/events?t=" + encodeURIComponent(state.TOKEN));
  es.addEventListener("job", function (e) { renderJob(JSON.parse((e as MessageEvent).data)); });
  es.addEventListener("notes", function () { reloadState(); });
}

export function reloadState(): Promise<StateResponse> {
  return api<StateResponse>("/api/state").then(function (s) {
    state.NOTES = s.notes;
    state.CONFIG = s.config;
    state.MODELS = s.models;
    state.MODEL_AVAILABILITY = s.modelAvailability || {};
    state.LANGUAGES = s.languages || [];
    state.THEMES = s.themes || [];
    state.WHISPER = s.whisper;
    state.FFMPEG = s.ffmpeg;
    // Normally a no-op (page.ts stamped the same theme onto <html> before
    // first paint), but it's what re-applies the saved one if a preview was
    // left behind, or picks up a theme changed elsewhere.
    applyTheme(state.CONFIG.theme);
    document.getElementById("folderLabel")!.textContent = state.CONFIG.rootLabel;
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

function setLive(on: boolean) {
  dom.live.classList.toggle("dead", !on);
  dom.live.title = on ? "Connected to the vno server" : "Disconnected — the vno server has stopped";
  if (!on && !document.querySelector(".toast.err")) {
    toast("vno server stopped — this page is now read-only", "err");
  }
}

var quitOverlay: HTMLDivElement | null = null;
function showQuitOverlay(title: string, detail: string) {
  if (!quitOverlay) {
    quitOverlay = document.createElement("div");
    quitOverlay.className = "quit-overlay";
    var eq = document.createElement("span");
    eq.className = "eq";
    for (var i = 0; i < 5; i++) eq.appendChild(document.createElement("i"));
    quitOverlay.appendChild(eq);
    quitOverlay.appendChild(document.createElement("h1"));
    quitOverlay.appendChild(document.createElement("p"));
    document.body.appendChild(quitOverlay);
  }
  quitOverlay.querySelector("h1")!.textContent = title;
  quitOverlay.querySelector("p")!.textContent = detail;
}

/* Confirms the server has actually gone (not just that /api/bye was sent -
   the process takes a moment to unwind, and closing the window before it's
   really down would just reopen the "disconnected" state on anything still
   watching). Once a ping genuinely fails to connect, it's safe to try
   closing the window - best-effort, since a tab the user opened by hand
   (rather than via window.open) will refuse to be closed by script in most
   browsers, which is why the overlay's text still doubles as the fallback. */
function waitForShutdown(triesLeft: number) {
  fetch("/api/ping?t=" + encodeURIComponent(state.TOKEN), { method: "POST", cache: "no-store" })
    .then(function () {
      if (triesLeft > 0) setTimeout(function () { waitForShutdown(triesLeft - 1); }, 300);
      else finishShutdown(); // gave it its chance; stop waiting either way
    })
    .catch(finishShutdown);
}

function finishShutdown() {
  showQuitOverlay("vno has stopped", "You can close this tab now.");
  try { window.close(); } catch (e) {}
}

document.getElementById("btnQuit")!.addEventListener("click", function () {
  modal({
    title: "Quit vno",
    message: "Stop the server and end the CLI session? You can close this tab afterwards.",
    confirmLabel: "Quit",
    danger: true,
    onConfirm: function () {
      state.alive = false; // stop the regular heartbeat from also reacting to this
      showQuitOverlay("Shutting down vno…", "Waiting for the server to stop.");
      return api("/api/bye", { method: "POST", body: { quit: true } })
        .then(function () { waitForShutdown(20); }, function () { waitForShutdown(20); });
    }
  });
});
