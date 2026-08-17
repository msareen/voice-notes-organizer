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

      var sourcesHead = document.createElement("div");
      sourcesHead.className = "source-list-head";
      var sourcesLabel = document.createElement("h4");
      sourcesLabel.textContent = "Additional Source Folders";
      sourcesHead.appendChild(sourcesLabel);
      sourcesHead.appendChild(button("Add folder", "", function () {
        addSourceRow({ path: "", pattern: "*", recursive: false, deleteAfterImport: false, mapTo: null });
      }));
      sourcesSection.appendChild(sourcesHead);
      var sh = document.createElement("p");
      sh.className = "hint";
      sh.textContent = "Folders synced every time you import, in addition to detected volumes — e.g. wherever a " +
        "phone's Quick Share/Quick Send drops files. Pattern is a \"*\"/\"?\" wildcard against the filename " +
        "(\"*\" = any audio file). \"Delete after import\" removes the file from this folder once it's safely " +
        "copied in — only turn this on for a disposable landing folder, not a real archive. \"Folder in target\" " +
        "optionally routes this source's files into a specific folder inside your target folder instead of a " +
        "folder named after the source path — leave it blank for the default.";
      sourcesSection.appendChild(sh);

      var sourcesBox = document.createElement("div");
      sourcesBox.className = "source-list";
      sourcesSection.appendChild(sourcesBox);

      var allExts = CONFIG.audioExtensions || [];

      function addSourceRow(entry) {
        var block = document.createElement("div");
        block.className = "source-block";

        var removeBtn = button("Remove", "", function () {
          confirmRemoveSource(pathInput.value.trim(), mapToInput.value.trim() || null, function () {
            sourcesBox.removeChild(block);
            sourceRows = sourceRows.filter(function (r) { return r.row !== block; });
          });
        });
        removeBtn.classList.add("source-remove");
        block.appendChild(removeBtn);

        var pathRow = document.createElement("div");
        pathRow.className = "source-row source-row-path";

        var pathInput = document.createElement("input");
        pathInput.type = "text";
        pathInput.placeholder = "Folder path (paste or type)";
        pathInput.value = entry.path || "";
        pathInput.className = "source-path-input";
        pathRow.appendChild(pathInput);

        pathRow.appendChild(button("Browse…", "", function () {
          browseFsFolders(pathInput.value.trim() || null, function (chosen) {
            pathInput.value = chosen;
          });
        }, "Pick a folder on this computer"));

        block.appendChild(pathRow);

        var mapRow = document.createElement("div");
        mapRow.className = "source-row source-row-map";

        var mapToInput = document.createElement("input");
        mapToInput.type = "text";
        mapToInput.placeholder = "Folder in target (optional)";
        mapToInput.value = entry.mapTo || "";
        mapToInput.className = "source-path-input";
        mapRow.appendChild(mapToInput);

        mapRow.appendChild(button("Browse…", "", function () {
          browseTargetFolder(mapToInput.value.trim() || "", function (chosen) {
            mapToInput.value = chosen;
          });
        }, "Pick a folder inside your target folder"));

        block.appendChild(mapRow);

        var optionsRow = document.createElement("div");
        optionsRow.className = "source-row source-row-options";

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
        optionsRow.appendChild(chipsWrap);

        var recWrap = document.createElement("label");
        recWrap.className = "check";
        var recCb = document.createElement("input");
        recCb.type = "checkbox";
        recCb.checked = !!entry.recursive;
        recWrap.appendChild(recCb);
        recWrap.appendChild(document.createTextNode("Include subfolders"));
        recWrap.title = "Off scans only this folder itself; on also picks up files nested in subfolders";
        optionsRow.appendChild(recWrap);

        var delWrap = document.createElement("label");
        delWrap.className = "check";
        var delCb = document.createElement("input");
        delCb.type = "checkbox";
        delCb.checked = !!entry.deleteAfterImport;
        delWrap.appendChild(delCb);
        delWrap.appendChild(document.createTextNode("Delete after import"));
        optionsRow.appendChild(delWrap);

        block.appendChild(optionsRow);

        sourcesBox.appendChild(block);
        sourceRows.push({
          row: block,
          pathInput: pathInput,
          mapToInput: mapToInput,
          recCb: recCb,
          delCb: delCb,
          selectedExts: function () { return allExts.filter(function (e) { return extState[e]; }); }
        });
      }

      (CONFIG.sources || []).forEach(addSourceRow);
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
            deleteAfterImport: r.delCb.checked,
            mapTo: r.mapToInput.value.trim() || null
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

// Confirms removing a source folder entry before it's actually taken out of
// `sourceRows` - removing it only forgets the sync configuration, it never
// touches files already copied into target, so the dialog makes that
// explicit and offers an Explore button to go see (and reorganize/delete,
// if wanted) what's there. `onRemove` runs only if the user confirms.
function confirmRemoveSource(sourcePath, mapTo, onRemove) {
  modal({
    title: "Remove this source folder?",
    message: null,
    confirmLabel: "Remove",
    danger: true,
    build: function (host) {
      var p = document.createElement("p");
      p.textContent = "This only removes the sync configuration - it won't touch any files already " +
        "imported from this folder. Your target folder's structure stays exactly as is; delete or " +
        "reorganize those files yourself from the folder.";
      host.appendChild(p);
      if (sourcePath) {
        host.appendChild(button("Explore…", "", function () {
          exploreSourceDest(sourcePath, mapTo);
        }, "Open the folder these files currently live in"));
      }
    },
    onConfirm: onRemove
  });
}

function exploreSourceDest(sourcePath, mapTo) {
  return api("/api/sources/explore", { method: "POST", body: { path: sourcePath, mapTo: mapTo } })
    .then(function () { toast("Opened folder"); })
    .catch(function (err) { toast(String(err.message || err), "err"); });
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

// Folder browser for a source's mapping folder, confined to the target
// folder (unlike browseFsFolders above, which can go anywhere on disk) -
// mirrors the server's containment check in routes/import.js:browseTarget.
// `relPath` is target-relative ("" = target root), and that's what's
// returned to `onPick` too, since mapTo is stored relative to target.
function browseTargetFolder(relPath, onPick, closePrev) {
  api("/api/browse-target" + (relPath ? "?sub=" + encodeURIComponent(relPath) : ""))
    .then(function (res) {
      var level = modal({
        title: "Choose a folder in target",
        message: null,
        confirmLabel: "Use this folder",
        build: function (host) {
          var crumb = document.createElement("div");
          crumb.className = "crumb";
          crumb.textContent = res.sub ? res.root + " / " + res.sub : res.root;
          host.appendChild(crumb);

          var box = document.createElement("div");
          box.className = "picklist";
          if (res.sub) {
            var up = res.sub.split("/").slice(0, -1).join("/");
            box.appendChild(fsFolderRow(".. (up one level)", function () {
              browseTargetFolder(up, onPick, level.close);
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
              var next = res.sub ? res.sub + "/" + name : name;
              browseTargetFolder(next, onPick, level.close);
            }));
          });
          host.appendChild(box);
        },
        onConfirm: function () {
          onPick(res.sub || "");
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
