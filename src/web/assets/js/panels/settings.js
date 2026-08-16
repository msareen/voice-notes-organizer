// Settings panel: transcription defaults, import behaviour, and the
// source-folders editor (including its own server-side folder browser).
import { state } from "../state.js";
import { api, toast } from "../api.js";
import { button, modal, selectField } from "../widgets.js";
import { modelOptions } from "../models.js";

var LANGUAGE_LABELS = {
  auto: "Auto-detect",
  hi: "Hindi",
  en: "English"
};

export function openSettings() {
  var autoSel, modelSel, languageSel, openSel, rememberSel, gpuSel;
  var sourceRows = [];
  modal({
    title: "Settings",
    message: null,
    confirmLabel: "Save",
    panel: true,
    build: function (host) {
      var CONFIG = state.CONFIG;
      var grid = document.createElement("div");
      grid.className = "settings-grid";
      host.appendChild(grid);

      var transcriptionCol = document.createElement("div");
      transcriptionCol.className = "settings-col";
      var th = document.createElement("h4");
      th.textContent = "Transcription";
      transcriptionCol.appendChild(th);
      grid.appendChild(transcriptionCol);

      autoSel = selectField(transcriptionCol, "Auto-translate imports", [
        { label: "On — always translate imports", value: "true" },
        { label: "Off — never translate on import", value: "false" },
        { label: "Ask each time", value: "null" }
      ], String(CONFIG.autoTranslate));

      modelSel = selectField(transcriptionCol, "Default whisper model",
        modelOptions(),
        CONFIG.defaultModel);

      languageSel = selectField(transcriptionCol, "Transcription language",
        state.LANGUAGES.map(function (l) { return { label: LANGUAGE_LABELS[l] || l, value: l }; }),
        CONFIG.transcribeLanguage || "auto");
      var lh = document.createElement("p");
      lh.className = "hint";
      lh.textContent = "Pin this if auto-detect keeps guessing the wrong language for you (e.g. Hindi heard as Urdu) - Hindi still handles English mixed in fine.";
      transcriptionCol.appendChild(lh);

      var gpu = CONFIG.gpu || {};
      gpuSel = null;
      if (gpu.available) {
        gpuSel = selectField(transcriptionCol, "GPU acceleration", [
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
        transcriptionCol.appendChild(gh);
      }

      var importCol = document.createElement("div");
      importCol.className = "settings-col";
      var ih = document.createElement("h4");
      ih.textContent = "Import";
      importCol.appendChild(ih);
      grid.appendChild(importCol);

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
      ph.textContent = "Every import — a detected volume or a source folder below — copies into here. " +
        "Change it with \"vno setting\" — moving it needs a re-scan.";
      pathField.appendChild(ph);
      importCol.appendChild(pathField);

      openSel = selectField(importCol, "Open this viewer when a run finishes", [
        { label: "On — launch the viewer after import/transcribe", value: "true" },
        { label: "Off — finish quietly", value: "false" }
      ], String(CONFIG.openWhenDone !== false));

      rememberSel = selectField(importCol, "Remember deleted recordings", [
        { label: "On — don't re-import what I deleted here", value: "true" },
        { label: "Off — import whatever the device has", value: "false" }
      ], String(CONFIG.rememberDeletions !== false));
      var rh = document.createElement("p");
      rh.className = "hint";
      rh.textContent = "Deletes made here and by cleanup are logged, so importing again won't copy them back. \"vno cleanup ledger\" forgets them.";
      importCol.appendChild(rh);

      var sourcesSection = document.createElement("div");
      sourcesSection.className = "settings-full";
      host.appendChild(sourcesSection);

      var sourcesLabel = document.createElement("h4");
      sourcesLabel.textContent = "Source folders";
      sourcesSection.appendChild(sourcesLabel);
      var sh = document.createElement("p");
      sh.className = "hint";
      sh.textContent = "Folders synced every time you import, in addition to detected volumes — e.g. wherever a " +
        "phone's Quick Share/Quick Send drops files. Pattern is a \"*\"/\"?\" wildcard against the filename " +
        "(\"*\" = any audio file). \"Delete after import\" removes the file from this folder once it's safely " +
        "copied in — only turn this on for a disposable landing folder, not a real archive.";
      sourcesSection.appendChild(sh);

      var sourcesBox = document.createElement("div");
      sourcesBox.className = "picklist";
      sourcesSection.appendChild(sourcesBox);

      var allExts = CONFIG.audioExtensions || [];

      function addSourceRow(entry) {
        var row = document.createElement("div");
        row.className = "pick source-row";
        row.style.flexWrap = "wrap";
        row.style.gap = "6px";

        var pathInput = document.createElement("input");
        pathInput.type = "text";
        pathInput.placeholder = "Folder path (paste or type)";
        pathInput.value = entry.path || "";
        pathInput.style.flex = "2";
        pathInput.style.minWidth = "220px";
        row.appendChild(pathInput);

        row.appendChild(button("Browse…", "", function () {
          browseFsFolders(pathInput.value.trim() || null, function (chosen) {
            pathInput.value = chosen;
          });
        }, "Pick a folder on this computer"));

        var chipsWrap = document.createElement("div");
        chipsWrap.className = "ext-chips";
        chipsWrap.title = "Which audio file types to pick up from this folder";
        var extState = {};
        extsFromPattern(entry.pattern, allExts).forEach(function (e) { extState[e] = true; });
        allExts.forEach(function (ext) {
          var chip = document.createElement("button");
          chip.type = "button";
          chip.className = "chip" + (extState[ext] ? " on" : "");
          chip.textContent = ext;
          chip.addEventListener("click", function () {
            extState[ext] = !extState[ext];
            chip.classList.toggle("on", extState[ext]);
          });
          chipsWrap.appendChild(chip);
        });
        row.appendChild(chipsWrap);

        var recWrap = document.createElement("label");
        recWrap.className = "check";
        var recCb = document.createElement("input");
        recCb.type = "checkbox";
        recCb.checked = !!entry.recursive;
        recWrap.appendChild(recCb);
        recWrap.appendChild(document.createTextNode("Include subfolders"));
        recWrap.title = "Off scans only this folder itself; on also picks up files nested in subfolders";
        row.appendChild(recWrap);

        var delWrap = document.createElement("label");
        delWrap.className = "check";
        var delCb = document.createElement("input");
        delCb.type = "checkbox";
        delCb.checked = !!entry.deleteAfterImport;
        delWrap.appendChild(delCb);
        delWrap.appendChild(document.createTextNode("Delete after import"));
        row.appendChild(delWrap);

        var removeBtn = button("Remove", "", function () {
          sourcesBox.removeChild(row);
          sourceRows = sourceRows.filter(function (r) { return r.row !== row; });
        });
        row.appendChild(removeBtn);

        sourcesBox.appendChild(row);
        sourceRows.push({
          row: row,
          pathInput: pathInput,
          recCb: recCb,
          delCb: delCb,
          selectedExts: function () { return allExts.filter(function (e) { return extState[e]; }); }
        });
      }

      (CONFIG.sources || []).forEach(addSourceRow);
      sourcesSection.appendChild(button("Add folder", "", function () { addSourceRow({ path: "", pattern: "*", recursive: false, deleteAfterImport: false }); }));
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
      var sources = sourceRows
        .map(function (r) {
          return {
            path: r.pathInput.value.trim(),
            pattern: patternFromExts(r.selectedExts(), state.CONFIG.audioExtensions || []),
            recursive: r.recCb.checked,
            deleteAfterImport: r.delCb.checked
          };
        })
        .filter(function (s) { return s.path; });
      return api("/api/settings", { method: "POST", body: patch })
        .then(function () { return api("/api/sources", { method: "POST", body: { sources: sources } }); })
        .then(function (res) {
          state.CONFIG = res.config;
          toast("Settings saved", "ok");
        });
    }
  });
}

// General-purpose folder browser for source folders, which - unlike volume
// subfolders in the Import panel - can live anywhere on disk. Browsers can't
// hand a real filesystem path back from window.showDirectoryPicker(), so
// this walks the tree server-side instead, starting from the drive/root list.
function browseFsFolders(currentPath, onPick, closePrev) {
  api("/api/browse-fs" + (currentPath ? "?path=" + encodeURIComponent(currentPath) : ""))
    .then(function (res) {
      var level = modal({
        title: "Choose a folder",
        message: null,
        confirmLabel: "Use this folder",
        build: function (host) {
          var crumb = document.createElement("div");
          crumb.className = "crumb";
          crumb.textContent = res.current || "Drives";
          host.appendChild(crumb);

          var box = document.createElement("div");
          box.className = "picklist";
          if (res.parent) {
            box.appendChild(fsFolderRow(".. (up one level)", function () {
              browseFsFolders(res.parent, onPick, level.close);
            }));
          } else if (res.current) {
            box.appendChild(fsFolderRow(".. (all drives)", function () {
              browseFsFolders(null, onPick, level.close);
            }));
          }
          if (!res.folders.length) {
            var none = document.createElement("div");
            none.className = "pick";
            none.textContent = "(no subfolders)";
            box.appendChild(none);
          }
          res.folders.forEach(function (name) {
            box.appendChild(fsFolderRow(name, function () {
              var next = res.current
                ? res.current + (res.current.slice(-1) === res.sep ? "" : res.sep) + name
                : name;
              browseFsFolders(next, onPick, level.close);
            }));
          });
          host.appendChild(box);
        },
        onConfirm: function () {
          if (!res.current) throw new Error("Pick a drive or folder first");
          onPick(res.current);
        }
      });
      if (closePrev) closePrev();
    })
    .catch(function (err) { toast(String(err.message || err), "err"); });
}

function fsFolderRow(label, onClick) {
  var row = document.createElement("div");
  row.className = "pick";
  row.style.cursor = "pointer";
  row.textContent = label;
  row.addEventListener("click", onClick);
  return row;
}

// "*" (or empty/legacy) means "any audio file" - shown as every extension
// selected, since that's the equivalent state in the multi-select. A
// pattern this UI didn't produce (a hand-edited config.json with a custom
// wildcard like "VN*.m4a") has no clean multi-select equivalent, so it
// also falls back to "everything selected" rather than silently dropping
// files - the config file value itself isn't touched until Save.
function extsFromPattern(pattern, allExts) {
  if (!pattern || pattern === "*") return allExts.slice();
  var parts = pattern.split(",").map(function (p) { return p.trim().toLowerCase(); });
  var matched = allExts.filter(function (ext) { return parts.indexOf("*" + ext) !== -1; });
  return matched.length ? matched : allExts.slice();
}

function patternFromExts(selected, allExts) {
  if (!selected.length || selected.length === allExts.length) return "*";
  return selected.map(function (ext) { return "*" + ext; }).join(",");
}
