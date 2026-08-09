(function () {
  var TOKEN = window.__VNO_TOKEN;
  var NOTES = [];
  var CONFIG = {};
  var MODELS = [];
  var MODEL_AVAILABILITY = {};
  var LANGUAGES = [];
  var WHISPER = true;
  var FFMPEG = true;
  var selectedRel = null;
  var alive = true;

  var list = document.getElementById("list");
  var shown = document.getElementById("shown");
  var q = document.getElementById("q");
  var placeholder = document.getElementById("placeholder");
  var body = document.getElementById("detailBody");
  var detail = document.getElementById("detail");
  var sidebar = document.querySelector(".sidebar");
  var divider = document.getElementById("divider");
  var live = document.getElementById("live");

  /* ---- API plumbing. Every call carries the session token the CLI minted,
     so nothing else on this machine can drive the file-touching endpoints. -- */
  function api(path, options) {
    options = options || {};
    var headers = { "X-VNO-Token": TOKEN };
    if (options.body) headers["Content-Type"] = "application/json";
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error(t || ("HTTP " + res.status)); });
      }
      return res.status === 204 ? null : res.json();
    });
  }

  var toastTimer = null;
  function toast(message, kind) {
    var existing = document.querySelector(".toast");
    if (existing) existing.remove();
    var el = document.createElement("div");
    el.className = "toast" + (kind ? " " + kind : "");
    el.textContent = message;
    document.body.appendChild(el);
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.remove(); }, kind === "err" ? 6000 : 2600);
  }
  function fail(err) { toast(String(err.message || err), "err"); }

  /* ---- Draggable divider: resize the takes list ---- */
  (function () {
    var MIN = 240, MAX_FRAC = 0.7, STEP = 24, KEY = "vno-sidebar-w";
    function setWidth(px) {
      var max = Math.max(MIN, window.innerWidth * MAX_FRAC);
      px = Math.max(MIN, Math.min(max, px));
      sidebar.style.width = px + "px";
      try { localStorage.setItem(KEY, String(px)); } catch (e) {}
    }
    var saved = (function () { try { return parseFloat(localStorage.getItem(KEY)); } catch (e) { return NaN; } })();
    if (saved > 0) setWidth(saved);

    var dragging = false;
    divider.addEventListener("pointerdown", function (e) {
      dragging = true;
      divider.classList.add("dragging");
      document.body.classList.add("resizing");
      divider.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    divider.addEventListener("pointermove", function (e) {
      if (!dragging) return;
      setWidth(e.clientX - sidebar.getBoundingClientRect().left);
    });
    function endDrag(e) {
      if (!dragging) return;
      dragging = false;
      divider.classList.remove("dragging");
      document.body.classList.remove("resizing");
      try { divider.releasePointerCapture(e.pointerId); } catch (err) {}
    }
    divider.addEventListener("pointerup", endDrag);
    divider.addEventListener("pointercancel", endDrag);
    divider.addEventListener("keydown", function (e) {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      setWidth(sidebar.getBoundingClientRect().width + (e.key === "ArrowRight" ? STEP : -STEP));
    });
    divider.addEventListener("dblclick", function () {
      sidebar.style.width = "";
      try { localStorage.removeItem(KEY); } catch (e) {}
    });
  })();

  function fmt(t) {
    t = Math.max(0, t | 0);
    var m = (t / 60) | 0, s = t % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }
  function fmtDur(sec) {
    if (sec == null) return "--";
    sec = Math.round(sec);
    var h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
    var p = function (n) { return (n < 10 ? "0" : "") + n; };
    return h > 0 ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
  }
  function fmtSize(b) {
    if (b == null) return "--";
    var u = ["B", "KB", "MB", "GB"], i = 0, n = b;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
  }
  function extOf(name) {
    var d = name.lastIndexOf(".");
    return d >= 0 ? name.slice(d + 1).toUpperCase() : "AUDIO";
  }
  function noteFor(rel) {
    for (var i = 0; i < NOTES.length; i++) if (NOTES[i].rel === rel) return NOTES[i];
    return null;
  }
  function button(label, cls, onClick, title) {
    var b = document.createElement("button");
    b.className = "btn" + (cls ? " " + cls : "");
    b.type = "button";
    b.textContent = label;
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  }

  /* ---- Collapsed-folder state persists across visits, keyed by folder ---- */
  var COLLAPSE_KEY = "vno-collapsed";
  var collapsed = {};
  try { collapsed = JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || {}; } catch (e) {}
  function saveCollapsed() {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify(collapsed)); } catch (e) {}
  }

  var rows = [];
  var groups = [];

  /* ---- Build the left takes list, grouped by folder ---- */
  function renderList() {
    list.textContent = "";
    rows = [];
    groups = [];
    var groupByKey = {};

    var totalSec = 0;
    for (var n = 0; n < NOTES.length; n++) {
      if (NOTES[n].durationSec != null) totalSec += NOTES[n].durationSec;
    }
    document.getElementById("statTakes").textContent = NOTES.length;
    document.getElementById("statTotal").textContent = fmtDur(totalSec);

    // NOTES is newest-first, so first-seen order puts the group holding the
    // newest take first, and each group's rows stay newest-first too.
    NOTES.forEach(function (note) {
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
        gname.textContent = g.key === "" ? CONFIG.rootLabel : g.key;
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
        list.appendChild(header);
        g.header = header;
      }
      var wrap = document.createElement("div");
      wrap.className = "group-body";
      wrap.setAttribute("role", "group");
      g.rows.forEach(function (r) { wrap.appendChild(r); });
      list.appendChild(wrap);
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
  list.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    var vis = rows.filter(rowVisible);
    if (!vis.length) return;
    var pos = vis.indexOf(document.activeElement);
    if (pos === -1) {
      for (var i = 0; i < vis.length; i++) if (vis[i]._rel === selectedRel) { pos = i; break; }
    }
    pos = Math.max(0, Math.min(vis.length - 1, pos + (e.key === "ArrowDown" ? 1 : -1)));
    var target = vis[pos];
    target.focus();
    select(target._rel);
  });

  function markActive() {
    rows.forEach(function (r) {
      var on = r._rel === selectedRel;
      r.classList.toggle("active", on);
      r.setAttribute("aria-selected", on ? "true" : "false");
    });
  }

  function chip(label, value, valueId) {
    var c = document.createElement("span");
    c.className = "chip";
    c.appendChild(document.createTextNode(label + " "));
    var b = document.createElement("b");
    if (valueId) b.id = valueId;
    b.textContent = value;
    c.appendChild(b);
    return c;
  }

  /* ---- Right playback deck ---- */
  function select(rel) {
    var note = noteFor(rel);
    if (!note) return showPlaceholder("Select a take to play");
    selectedRel = rel;
    markActive();

    detail.classList.remove("playing");
    body.textContent = "";

    var eyebrow = document.createElement("div");
    eyebrow.className = "eyebrow";
    eyebrow.appendChild(document.createTextNode("Now Playing"));
    var eq = document.createElement("span");
    eq.className = "eq";
    for (var b2 = 0; b2 < 5; b2++) eq.appendChild(document.createElement("i"));
    eyebrow.appendChild(eq);
    body.appendChild(eyebrow);

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
    body.appendChild(head);

    var readout = document.createElement("div");
    readout.className = "readout-line";
    if (note.dateStr) readout.appendChild(chip("REC", note.dateStr + " " + note.timeStr));
    readout.appendChild(chip("LEN", fmtDur(note.durationSec), "lenChipValue"));
    readout.appendChild(chip("SIZE", fmtSize(note.size)));
    readout.appendChild(chip("FMT", extOf(note.name)));
    body.appendChild(readout);

    var audio = document.createElement("audio");
    audio.controls = true;
    audio.preload = "metadata";
    audio.src = note.src + "?t=" + encodeURIComponent(TOKEN);
    audio.addEventListener("play", function () { detail.classList.add("playing"); });
    audio.addEventListener("pause", function () { detail.classList.remove("playing"); });
    audio.addEventListener("ended", function () { detail.classList.remove("playing"); });
    body.appendChild(audio);

    var transcript = document.createElement("div");
    transcript.className = "transcript";
    transcript.id = "transcript";
    renderTranscript(transcript, note, audio);
    body.appendChild(transcript);

    placeholder.classList.add("hidden");
    body.classList.remove("hidden");

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
        if (selectedRel !== rel) return;
        var lenChip = document.getElementById("lenChipValue");
        if (lenChip) lenChip.textContent = fmtDur(res.note.durationSec);
        var transcriptHost = document.getElementById("transcript");
        var audio = body.querySelector("audio");
        if (transcriptHost && audio) renderTranscript(transcriptHost, res.note, audio);
      })
      .catch(function () {
        // A stale cached duration/transcript isn't worth surfacing an error for.
      });
  }

  function showPlaceholder(message) {
    selectedRel = null;
    placeholder.textContent = "";
    var big = document.createElement("div");
    big.className = "big";
    big.textContent = message;
    placeholder.appendChild(big);
    placeholder.classList.remove("hidden");
    body.classList.add("hidden");
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

  function mergeNote(updated) {
    for (var i = 0; i < NOTES.length; i++) {
      if (NOTES[i].rel === updated.rel) { NOTES[i] = updated; return; }
    }
    NOTES.push(updated);
  }

  /* ---- Destructive + OS actions ---- */
  function confirmDelete(note) {
    modal({
      title: "Delete recording",
      message: "Permanently delete " + note.name + " and its transcript from disk? This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
      onConfirm: function () {
        return api("/api/notes/delete", { method: "POST", body: { rel: note.rel } })
          .then(function (res) {
            NOTES = NOTES.filter(function (n) { return n.rel !== note.rel; });
            if (selectedRel === note.rel) selectedRel = null;
            renderList();
            if (selectedRel) select(selectedRel);
            else if (NOTES.length) select(NOTES[0].rel);
            else showPlaceholder("No takes left in this folder");
            toast("Deleted " + res.removed + " file(s)", "ok");
          });
      }
    });
  }

  function revealFile(rel) {
    api("/api/reveal", { method: "POST", body: { rel: rel } })
      .then(function () { toast("Opened file location"); })
      .catch(fail);
  }
  function revealFolder(dir) {
    api("/api/reveal", { method: "POST", body: { dir: dir || "" } })
      .then(function () { toast("Opened folder"); })
      .catch(fail);
  }

  document.getElementById("btnFolder").addEventListener("click", function () { revealFolder(""); });

  /* ---- Settings ---- */
  document.getElementById("btnSettings").addEventListener("click", openSettings);

  var LANGUAGE_LABELS = {
    auto: "Auto-detect",
    hi: "Hindi",
    en: "English"
  };

  // Marks each model option with whether it's already downloaded, so picking
  // one that isn't doesn't silently kick off a gigabyte download.
  function modelOptions() {
    return MODELS.map(function (m) {
      var known = Object.prototype.hasOwnProperty.call(MODEL_AVAILABILITY, m);
      var tag = known ? (MODEL_AVAILABILITY[m] ? "downloaded" : "will download") : "";
      return { label: tag ? m + " (" + tag + ")" : m, value: m };
    });
  }

  function openSettings() {
    var autoSel, modelSel, languageSel, openSel, rememberSel, gpuSel;
    modal({
      title: "Settings",
      message: null,
      confirmLabel: "Save",
      build: function (host) {
        var pathField = document.createElement("div");
        pathField.className = "field";
        var pl = document.createElement("label");
        pl.textContent = "Target folder";
        pathField.appendChild(pl);
        var pv = document.createElement("div");
        pv.className = "path";
        pv.textContent = CONFIG.target;
        pathField.appendChild(pv);
        var ph = document.createElement("p");
        ph.className = "hint";
        ph.textContent = "Change this with \"vno setting\" — moving it needs a re-scan.";
        pathField.appendChild(ph);
        host.appendChild(pathField);

        autoSel = selectField(host, "Auto-translate imports", [
          { label: "On — always translate imports", value: "true" },
          { label: "Off — never translate on import", value: "false" },
          { label: "Ask each time", value: "null" }
        ], String(CONFIG.autoTranslate));

        modelSel = selectField(host, "Default whisper model",
          modelOptions(),
          CONFIG.defaultModel);

        languageSel = selectField(host, "Transcription language",
          LANGUAGES.map(function (l) { return { label: LANGUAGE_LABELS[l] || l, value: l }; }),
          CONFIG.transcribeLanguage || "auto");
        var lh = document.createElement("p");
        lh.className = "hint";
        lh.textContent = "Pin this if auto-detect keeps guessing the wrong language for you (e.g. Hindi heard as Urdu) - Hindi still handles English mixed in fine.";
        host.appendChild(lh);

        var gpu = CONFIG.gpu || {};
        gpuSel = null;
        if (gpu.available) {
          gpuSel = selectField(host, "GPU acceleration", [
            { label: "On — transcribe on " + (gpu.name || "the GPU"), value: "true" },
            { label: "Off — transcribe on the CPU", value: "false" }
          ], String(gpu.use !== false));
        } else {
          // The accelerator backend is fixed by whichever whisper.cpp build
          // "vno setup" installed — the browser can't install anything itself.
          var gh = document.createElement("p");
          gh.className = "hint";
          gh.textContent = gpu.checked
            ? "GPU acceleration: no accelerator build available on this machine — transcription runs on the CPU."
            : "GPU acceleration: run \"vno setup\" in a terminal to install whisper.cpp and check for one.";
          host.appendChild(gh);
        }

        openSel = selectField(host, "Open this viewer when a run finishes", [
          { label: "On — launch the viewer after import/transcribe", value: "true" },
          { label: "Off — finish quietly", value: "false" }
        ], String(CONFIG.openWhenDone !== false));

        rememberSel = selectField(host, "Remember deleted recordings", [
          { label: "On — don't re-import what I deleted here", value: "true" },
          { label: "Off — import whatever the device has", value: "false" }
        ], String(CONFIG.rememberDeletions !== false));
        var rh = document.createElement("p");
        rh.className = "hint";
        rh.textContent = "Deletes made here and by cleanup are logged, so importing again won't copy them back. \"vno cleanup ledger\" forgets them.";
        host.appendChild(rh);
      },
      onConfirm: function () {
        var patch = {
          autoTranslate: autoSel.value === "null" ? null : autoSel.value === "true",
          defaultModel: modelSel.value,
          transcribeLanguage: languageSel.value,
          openWhenDone: openSel.value === "true",
          rememberDeletions: rememberSel.value === "true"
        };
        if (gpuSel) patch.useGpu = gpuSel.value === "true";
        return api("/api/settings", { method: "POST", body: patch }).then(function (res) {
          CONFIG = res.config;
          toast("Settings saved", "ok");
        });
      }
    });
  }

  function selectField(host, labelText, options, value) {
    var field = document.createElement("div");
    field.className = "field";
    var label = document.createElement("label");
    label.textContent = labelText;
    field.appendChild(label);
    var sel = document.createElement("select");
    options.forEach(function (o) {
      var opt = document.createElement("option");
      opt.value = o.value;
      opt.textContent = o.label;
      if (o.value === value) opt.selected = true;
      sel.appendChild(opt);
    });
    field.appendChild(sel);
    host.appendChild(field);
    return sel;
  }

  /* ---- Modal ---- */
  function modal(spec) {
    var backdrop = document.createElement("div");
    backdrop.className = "backdrop";
    var box = document.createElement("div");
    box.className = "modal";
    backdrop.appendChild(box);

    var h = document.createElement("h3");
    h.textContent = spec.title;
    box.appendChild(h);
    if (spec.message) {
      var p = document.createElement("p");
      p.textContent = spec.message;
      box.appendChild(p);
    }
    if (spec.build) spec.build(box);

    var actions = document.createElement("div");
    actions.className = "modal-actions";
    var cancel = button("Cancel", "", close);
    actions.appendChild(cancel);
    var confirm = null;
    if (spec.onConfirm) {
      confirm = button(spec.confirmLabel || "OK", spec.danger ? "danger" : "primary", function () {
        confirm.disabled = true;
        cancel.disabled = true;
        // new Promise() so a synchronous throw inside onConfirm is caught too.
        new Promise(function (resolve) { resolve(spec.onConfirm()); })
          .then(close)
          .catch(function (err) {
            confirm.disabled = false;
            cancel.disabled = false;
            fail(err);
          });
      });
      actions.appendChild(confirm);
    } else {
      cancel.textContent = "Close";
    }
    box.appendChild(actions);

    function close() {
      backdrop.remove();
      document.removeEventListener("keydown", onKey);
    }
    function isTopmost() {
      var all = document.querySelectorAll(".backdrop");
      return all.length === 0 || all[all.length - 1] === backdrop;
    }
    function onKey(e) {
      // Modals stack (the folder browser opens over Import), so Escape must
      // only dismiss the one on top.
      if (e.key === "Escape" && isTopmost()) { e.preventDefault(); close(); }
    }
    backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });
    document.addEventListener("keydown", onKey);
    document.body.appendChild(backdrop);
    (confirm || cancel).focus();
    return { close: close };
  }

  /* ---- Filter box ---- */
  function applyFilter() {
    var term = q.value.trim().toLowerCase();
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
    shown.textContent = visible + " / " + rows.length + " takes";
  }
  q.addEventListener("input", applyFilter);

  /* ---- Lifecycle: the page owns the CLI. A heartbeat keeps the server up;
     closing the tab tells it to exit, and if the server goes away first the
     page drops into a read-only "disconnected" state. ---- */
  function goodbye() {
    if (!alive) return;
    alive = false;
    try {
      var blob = new Blob([JSON.stringify({ token: TOKEN })], { type: "text/plain;charset=UTF-8" });
      navigator.sendBeacon("/api/bye", blob);
    } catch (e) {}
  }
  window.addEventListener("pagehide", goodbye);
  window.addEventListener("beforeunload", goodbye);

  var missed = 0;
  setInterval(function () {
    if (!alive) return;
    api("/api/ping", { method: "POST", body: {} })
      .then(function () { missed = 0; setLive(true); })
      .catch(function () { if (++missed >= 2) setLive(false); });
  }, 3000);

  function setLive(on) {
    live.classList.toggle("dead", !on);
    live.title = on ? "Connected to the vno server" : "Disconnected — the vno server has stopped";
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
          alive = false;
          setLive(false);
        });
      }
    });
  });

  /* ---- Jobs: one long-running CLI operation at a time, streamed over SSE ---- */
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

  function connectEvents() {
    var es = new EventSource("/api/events?t=" + encodeURIComponent(TOKEN));
    es.addEventListener("job", function (e) { renderJob(JSON.parse(e.data)); });
    es.addEventListener("notes", function () { reloadState(); });
  }

  function reloadState() {
    return api("/api/state").then(function (state) {
      NOTES = state.notes;
      CONFIG = state.config;
      MODELS = state.models;
      MODEL_AVAILABILITY = state.modelAvailability || {};
      LANGUAGES = state.languages || [];
      WHISPER = state.whisper;
      FFMPEG = state.ffmpeg;
      document.getElementById("folderLabel").textContent = CONFIG.rootLabel;
      renderList();
      if (selectedRel && noteFor(selectedRel)) select(selectedRel);
      else if (NOTES.length) select(NOTES[0].rel);
      else showPlaceholder("Nothing here yet — use Import to bring recordings in");
      if (state.job) renderJob(state.job);
      return state;
    });
  }

  /* ---- Reusable checkbox list for the command modals ---- */
  function pickList(host, items) {
    var bar = document.createElement("div");
    bar.className = "pickbar";
    var count = document.createElement("span");
    bar.appendChild(count);
    var spacer = document.createElement("span");
    spacer.className = "spacer";
    bar.appendChild(spacer);
    bar.appendChild(button("All", "", function () { setAll(true); }));
    bar.appendChild(button("None", "", function () { setAll(false); }));
    host.appendChild(bar);

    var box = document.createElement("div");
    box.className = "picklist";
    var boxes = [];

    items.forEach(function (item) {
      var row = document.createElement("label");
      row.className = "pick";
      var cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = item.checked !== false;
      cb.value = item.value;
      cb.addEventListener("change", update);
      row.appendChild(cb);

      var main = document.createElement("div");
      main.className = "pk-main";
      var name = document.createElement("div");
      name.className = "pk-name";
      name.textContent = item.name;
      main.appendChild(name);
      if (item.sub) {
        var sub = document.createElement("div");
        sub.className = "pk-sub";
        sub.textContent = item.sub;
        main.appendChild(sub);
      }
      row.appendChild(main);

      if (item.right) {
        var right = document.createElement("span");
        right.className = "pk-right";
        right.textContent = item.right;
        row.appendChild(right);
      }
      if (item.extra) row.appendChild(item.extra);

      box.appendChild(row);
      boxes.push(cb);
    });

    host.appendChild(box);

    function setAll(on) {
      boxes.forEach(function (b) { b.checked = on; });
      update();
    }
    function update() {
      count.textContent = selected().length + " of " + boxes.length + " selected";
    }
    function selected() {
      return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
    }
    update();
    return { selected: selected, boxes: boxes };
  }

  function checkbox(host, labelText, checked) {
    var wrap = document.createElement("label");
    wrap.className = "check";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !!checked;
    wrap.appendChild(cb);
    wrap.appendChild(document.createTextNode(labelText));
    host.appendChild(wrap);
    return cb;
  }

  /* ---- Transcribe ---- */
  document.getElementById("btnTranscribe").addEventListener("click", function () { openTranscribe(null); });

  // Nothing in the page can install these, so the warning sends you to the CLI,
  // where `vno setup` will offer to do it.
  function missingDeps() {
    var missing = [];
    if (!FFMPEG) missing.push("ffmpeg");
    if (!WHISPER) missing.push("whisper");
    if (!missing.length) return null;
    return missing.join(" and ") + (missing.length > 1 ? " aren't" : " isn't") +
      " on your PATH. Run `vno setup` in a terminal to install " +
      (missing.length > 1 ? "them." : "it.");
  }

  function openTranscribe(onlyRel) {
    var candidates = onlyRel ? NOTES.filter(function (n) { return n.rel === onlyRel; }) : NOTES;
    if (!candidates.length) return toast("No recordings to transcribe", "err");

    // Default to the ones with nothing yet - that's the common case. Asking
    // for one specific note is explicit, so that one starts checked, as does
    // everything when there's no backlog left to single out.
    var pending = candidates.filter(function (n) { return !n.hasTranscript; });
    var defaultOn = (onlyRel || pending.length === 0) ? null : pending;

    var picks, modelSel, translateChk;
    modal({
      title: onlyRel ? "Transcribe this take" : "Transcribe",
      message: missingDeps(),
      confirmLabel: "Start",
      build: function (host) {
        picks = pickList(host, candidates.map(function (n) {
          return {
            value: n.rel,
            name: n.name,
            sub: n.dir || CONFIG.rootLabel,
            right: n.hasTranscript ? "has transcript" : "no transcript",
            checked: defaultOn ? defaultOn.indexOf(n) !== -1 : true
          };
        }));
        modelSel = selectField(host, "Whisper model",
          modelOptions(),
          CONFIG.defaultModel);
        translateChk = checkbox(host, "Translate to English instead of a verbatim transcript", false);
      },
      onConfirm: function () {
        var rels = picks.selected();
        if (!rels.length) throw new Error("Nothing selected");
        return api("/api/transcribe", {
          method: "POST",
          body: { rels: rels, model: modelSel.value, translate: translateChk.checked }
        }).then(function () { toast("Started on " + rels.length + " file(s)"); });
      }
    });
  }

  /* ---- Import ---- */
  document.getElementById("btnImport").addEventListener("click", openImport);

  function openImport() {
    // Volume detection shells out to the OS and can take a few seconds, so say
    // something rather than leaving the button looking dead.
    toast("Detecting volumes…");
    api("/api/volumes").then(function (res) {
      if (!res.volumes.length) {
        return modal({
          title: "Import",
          message: "No external or removable volumes are connected. Plug in your recorder or SD card, " +
            "or add a folder to \"sources\" in the config file, then try again.",
          onConfirm: null
        });
      }

      var picks, translateChk, rememberChk;
      var subdirs = {};
      res.volumes.forEach(function (v) { subdirs[v.id] = (v.known && v.known.sourceSubdir) || ""; });

      modal({
        title: "Import",
        // The translate option below needs whisper, so say up front when it
        // isn't there rather than letting the job log report it afterwards.
        message: "Choose which volumes to pull voice notes from." + (missingDeps() ? " " + missingDeps() : ""),
        confirmLabel: "Import",
        build: function (host) {
          picks = pickList(host, res.volumes.map(function (v) {
            var browse = document.createElement("button");
            browse.type = "button";
            browse.className = "btn";
            browse.textContent = subdirs[v.id] ? "…/" + subdirs[v.id].split(/[\\/]/).pop() : "Subfolder";
            browse.title = "Sync only a subfolder of this volume";
            browse.addEventListener("click", function (e) {
              e.preventDefault();
              e.stopPropagation();
              browseFolders(v, subdirs[v.id], function (chosen) {
                subdirs[v.id] = chosen || "";
                browse.textContent = chosen ? "…/" + chosen.split(/[\\/]/).pop() : "Subfolder";
              });
            });
            return {
              value: v.id,
              name: v.name + (v.isManualSource ? "  (configured source)" : ""),
              sub: v.mountPath + (v.known && v.known.lastSynced ? "  · last synced " + v.known.lastSynced.slice(0, 10) : ""),
              extra: browse,
              checked: v.isManualSource || !!(v.known && v.known.autoImport)
            };
          }));
          translateChk = checkbox(host, "Translate newly imported notes to English with whisper",
            CONFIG.autoTranslate === true);
          rememberChk = checkbox(host, "Remember these volumes and auto-import them next time", true);
        },
        onConfirm: function () {
          var ids = picks.selected();
          if (!ids.length) throw new Error("No volumes selected");
          return api("/api/import", {
            method: "POST",
            body: {
              volumes: ids.map(function (id) {
                return { id: id, subdir: subdirs[id], remember: rememberChk.checked };
              }),
              translate: translateChk.checked
            }
          }).then(function () { toast("Import started"); });
        }
      });
    }).catch(fail);
  }

  // Walks a volume's folder tree one level at a time so a recorder that buries
  // audio under PRIVATE/SONY/... can be pinned without typing the path.
  // closePrev closes the level we came from, leaving the Import modal below
  // it untouched.
  function browseFolders(volume, sub, onPick, closePrev) {
    api("/api/browse?volume=" + encodeURIComponent(volume.id) + "&sub=" + encodeURIComponent(sub || ""))
      .then(function (res) {
        var level = modal({
          title: "Choose a subfolder",
          message: null,
          confirmLabel: "Use this folder",
          build: function (host) {
            var crumb = document.createElement("div");
            crumb.className = "crumb";
            crumb.textContent = res.current;
            host.appendChild(crumb);

            var box = document.createElement("div");
            box.className = "picklist";
            if (res.sub) {
              box.appendChild(folderRow(".. (up one level)", function () {
                var parts = res.sub.split("/");
                parts.pop();
                browseFolders(volume, parts.join("/"), onPick, level.close);
              }));
            }
            if (!res.folders.length && !res.sub) {
              var none = document.createElement("div");
              none.className = "pick";
              none.textContent = "(no subfolders)";
              box.appendChild(none);
            }
            res.folders.forEach(function (name) {
              box.appendChild(folderRow(name + "/", function () {
                browseFolders(volume, res.sub ? res.sub + "/" + name : name, onPick, level.close);
              }));
            });
            host.appendChild(box);

            if (res.sub) {
              var clear = document.createElement("div");
              clear.style.marginTop = "12px";
              clear.appendChild(button("Reset to whole volume", "", function () {
                onPick("");
                level.close();
              }));
              host.appendChild(clear);
            }
          },
          onConfirm: function () { onPick(res.sub); }
        });
        if (closePrev) closePrev();
      })
      .catch(fail);

    function folderRow(label, onClick) {
      var row = document.createElement("div");
      row.className = "pick";
      row.style.cursor = "pointer";
      row.textContent = label;
      row.addEventListener("click", onClick);
      return row;
    }
  }

  /* ---- Cleanup ---- */
  document.getElementById("btnCleanup").addEventListener("click", openCleanup);

  function openCleanup() {
    var thresholdInput;
    modal({
      title: "Cleanup short recordings",
      message: "Scans for recordings shorter than the threshold - usually accidental button presses. " +
        "Deleting removes the audio and its transcript.",
      confirmLabel: "Scan",
      build: function (host) {
        var field = document.createElement("div");
        field.className = "field";
        var label = document.createElement("label");
        label.textContent = "Threshold (seconds)";
        field.appendChild(label);
        thresholdInput = document.createElement("input");
        thresholdInput.type = "number";
        thresholdInput.min = "0";
        thresholdInput.step = "0.5";
        thresholdInput.value = "3";
        field.appendChild(thresholdInput);
        host.appendChild(field);
      },
      onConfirm: function () {
        var threshold = parseFloat(thresholdInput.value) || 3;
        return api("/api/cleanup/scan?threshold=" + encodeURIComponent(threshold))
          .then(function (res) { showCleanupResults(res); });
      }
    });
  }

  function showCleanupResults(res) {
    if (!res.short.length) {
      return modal({
        title: "Cleanup",
        message: "Nothing shorter than " + res.threshold + "s among " + res.scanned + " recording(s).",
        onConfirm: null
      });
    }
    var picks;
    modal({
      title: "Delete short recordings",
      message: res.short.length + " recording(s) under " + res.threshold + "s. This can't be undone.",
      confirmLabel: "Delete",
      danger: true,
      build: function (host) {
        picks = pickList(host, res.short.map(function (s) {
          return { value: s.rel, name: s.name, sub: s.rel, right: s.durationSec.toFixed(1) + "s" };
        }));
      },
      onConfirm: function () {
        var rels = picks.selected();
        if (!rels.length) throw new Error("Nothing selected");
        return api("/api/cleanup", { method: "POST", body: { rels: rels } }).then(function (out) {
          toast("Deleted " + out.removed + " file(s)", "ok");
        });
      }
    });
  }

  /* ---- Boot ---- */
  reloadState()
    .then(connectEvents)
    .catch(function (err) {
      showPlaceholder("Couldn't load notes");
      fail(err);
    });
})();
