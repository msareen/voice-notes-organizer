// The left takes list, grouped by folder. Mutually referential with deck.js
// (selecting a row plays it; the deck's actions refresh the list) - safe as
// an ES module cycle since every cross-reference here is called from inside
// an event handler, never during module evaluation.
import { state } from "./state.js";
import { dom } from "./dom.js";
import { fmtDur, fmtSize } from "./format.js";
import { select } from "./deck.js";
import { revealFolder } from "./actions.js";

/* ---- Collapsed-folder state persists across visits, keyed by folder ---- */
var COLLAPSE_KEY = "vno-collapsed";
var collapsed = {};
try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (e) {}
function saveCollapsed() {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (e) {}
}

var rows = [];
var groups = [];

export function renderList() {
  dom.list.textContent = "";
  rows = [];
  groups = [];
  var groupByKey = {};

  var totalSec = 0;
  for (var n = 0; n < state.NOTES.length; n++) {
    if (state.NOTES[n].durationSec != null) totalSec += state.NOTES[n].durationSec;
  }
  document.getElementById("statTakes").textContent = state.NOTES.length;
  document.getElementById("statTotal").textContent = fmtDur(totalSec);

  // NOTES is newest-first, so first-seen order puts the group holding the
  // newest take first, and each group's rows stay newest-first too.
  state.NOTES.forEach(function (note) {
    var row = document.createElement("div");
    row.className = "row";
    row.tabIndex = 0;
    row.setAttribute("role", "option");
    row._rel = note.rel;

    var led = document.createElement("span");
    led.className = "led" + (note.hasTranscript ? " on" : "");
    led.title = note.hasTranscript ? "Transcript available" : "No transcript yet";
    row.appendChild(led);

    var main = document.createElement("div");
    main.className = "row-main";
    var name = document.createElement("div");
    name.className = "row-name";
    name.textContent = note.name;
    main.appendChild(name);
    var sub = document.createElement("div");
    sub.className = "row-sub";
    sub.textContent = note.dateStr ? note.dateStr + "  " + note.timeStr : "no date";
    main.appendChild(sub);
    row.appendChild(main);

    var right = document.createElement("div");
    right.className = "row-right";
    var dur = document.createElement("div");
    dur.className = "row-dur";
    dur.textContent = fmtDur(note.durationSec);
    var size = document.createElement("div");
    size.className = "row-size";
    size.textContent = fmtSize(note.size);
    right.appendChild(dur);
    right.appendChild(size);
    row.appendChild(right);

    row._haystack = (note.title + " " + (note.name || "") + " " + (note.text || "")).toLowerCase();
    row.addEventListener("click", function () { select(note.rel); });
    row.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); select(note.rel); }
    });

    var key = note.dir || "";
    var g = groupByKey[key];
    if (!g) { g = { key: key, rows: [], header: null, body: null }; groupByKey[key] = g; groups.push(g); }
    g.rows.push(row);
    row._group = g;
    rows.push(row);
  });

  // With a single folder there's nothing to group under, so skip the headers
  // and render a plain flat list.
  var showGroups = groups.length > 1;

  groups.forEach(function (g) {
    if (showGroups) {
      var header = document.createElement("button");
      header.type = "button";
      header.className = "group-head";
      var chev = document.createElement("span");
      chev.className = "chev";
      chev.textContent = "▾";
      header.appendChild(chev);
      var gname = document.createElement("span");
      gname.className = "g-name";
      gname.textContent = g.key === "" ? state.CONFIG.rootLabel : g.key;
      header.appendChild(gname);
      var gopen = document.createElement("span");
      gopen.className = "g-open";
      gopen.textContent = "⧉";
      gopen.title = "Open this folder";
      gopen.addEventListener("click", function (e) {
        e.stopPropagation();
        revealFolder(g.key);
      });
      header.appendChild(gopen);
      var gcount = document.createElement("span");
      gcount.className = "g-count";
      gcount.textContent = g.rows.length;
      header.appendChild(gcount);
      header.addEventListener("click", function () {
        collapsed[g.key] = !collapsed[g.key];
        saveCollapsed();
        applyCollapsed(g);
      });
      dom.list.appendChild(header);
      g.header = header;
    }
    var wrap = document.createElement("div");
    wrap.className = "group-body";
    wrap.setAttribute("role", "group");
    g.rows.forEach(function (r) { wrap.appendChild(r); });
    dom.list.appendChild(wrap);
    g.body = wrap;
    applyCollapsed(g);
  });

  applyFilter();
  markActive();
}

function applyCollapsed(g) {
  var c = !!collapsed[g.key];
  if (g.header) {
    g.header.classList.toggle("collapsed", c);
    g.header.setAttribute("aria-expanded", String(!c));
  }
  if (g.body) g.body.classList.toggle("collapsed", c);
}

// A row counts as navigable only when it's neither filtered out nor tucked
// inside a collapsed folder.
function rowVisible(r) {
  return !r.classList.contains("hidden") &&
    !(r._group.body && r._group.body.classList.contains("collapsed"));
}

// Arrow-key navigation moves through the currently visible takes.
dom.list.addEventListener("keydown", function (e) {
  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
  e.preventDefault();
  var vis = rows.filter(rowVisible);
  if (!vis.length) return;
  var pos = vis.indexOf(document.activeElement);
  if (pos === -1) {
    for (var i = 0; i < vis.length; i++) if (vis[i]._rel === state.selectedRel) { pos = i; break; }
  }
  pos = Math.max(0, Math.min(vis.length - 1, pos + (e.key === "ArrowDown" ? 1 : -1)));
  var target = vis[pos];
  target.focus();
  select(target._rel);
});

export function markActive() {
  rows.forEach(function (r) {
    var on = r._rel === state.selectedRel;
    r.classList.toggle("active", on);
    r.setAttribute("aria-selected", on ? "true" : "false");
  });
}

/* ---- Filter box ---- */
export function applyFilter() {
  var term = dom.q.value.trim().toLowerCase();
  var visible = 0;
  rows.forEach(function (row) {
    var match = !term || row._haystack.indexOf(term) !== -1;
    row.classList.toggle("hidden", !match);
    if (match) visible++;
  });
  // Drop headers for folders with no surviving rows; while a search is active
  // force every remaining folder open so matches aren't hidden by collapse.
  groups.forEach(function (g) {
    var anyMatch = g.rows.some(function (r) { return !r.classList.contains("hidden"); });
    if (g.header) g.header.classList.toggle("hidden", !anyMatch);
    if (g.body) g.body.classList.toggle("collapsed", term ? false : !!collapsed[g.key]);
  });
  dom.shown.textContent = visible + " / " + rows.length + " takes";
}
dom.q.addEventListener("input", applyFilter);
