// Settings panel: appearance, transcription defaults, import behaviour, and
// the source-folders editor (including its own server-side folder browser).
import { state } from "../state.ts";
import { api, toast } from "../api.ts";
import { button, modal, selectField, textareaField, helpToggle } from "../widgets.ts";
import { modelOptions, languageOptions } from "../models.ts";
import { applyTheme, currentTheme } from "../theme.ts";
import type { Source, StateConfig, ThemeId } from "../../../../types.ts";
import type { Option } from "../models.ts";

/** One editable source-folder block, and how to read its current values back. */
interface SourceRow {
  row: HTMLElement;
  pathInput: HTMLInputElement;
  mapToInput: HTMLInputElement;
  recCb: HTMLInputElement;
  delCb: HTMLInputElement;
  selectedExts: () => string[];
}

/** The flat scalars POST /api/settings accepts. */
interface SettingsPatch {
  theme: string;
  autoTranslate: boolean | null;
  defaultModel: string;
  transcribeLanguage: string;
  crossLanguageModel: string | null;
  crossLanguageMap: Record<string, string>;
  openWhenDone: boolean;
  rememberDeletions: boolean;
  useGpu?: boolean;
  summaryModel?: string | null;
  summaryPrompt?: string | null;
}

/** One level of the unconfined filesystem browser (GET /api/browse-fs). */
interface FsLevel {
  current: string | null;
  parent: string | null;
  folders: string[];
  sep: string;
}

/** One level of the target-confined browser (GET /api/browse-target). */
interface TargetLevel {
  root: string;
  current: string;
  sub: string;
  folders: string[];
}

function languageLabel(code: string): string {
  var found = state.LANGUAGES.filter(function (l) { return l.code === code; })[0];
  return found ? found.label : code;
}

export function openSettings(): void {
  var autoSel: HTMLSelectElement,
    modelSel: HTMLSelectElement,
    languageSel: HTMLSelectElement,
    openSel: HTMLSelectElement,
    rememberSel: HTMLSelectElement,
    gpuSel: HTMLSelectElement | null;
  var crossModelSel: HTMLSelectElement,
    crossFromSel: HTMLSelectElement,
    crossToSel: HTMLSelectElement,
    crossAddBtn: HTMLButtonElement;
  var summaryModelSel: HTMLSelectElement | null;
  var summaryPromptTa: HTMLTextAreaElement | null;
  var crossMap: Record<string, string> = {};
  var sourceRows: SourceRow[] = [];
  // Theme is previewed live on the whole page, so the panel has to remember
  // what was on when it opened and put it back if the user backs out.
  var startTheme = state.CONFIG.theme || currentTheme();
  var chosenTheme: string = startTheme;
  modal({
    title: "Settings",
    message: null,
    confirmLabel: "Save",
    panel: true,
    onCancel: function () { applyTheme(startTheme); },
    build: function (host) {
      var CONFIG = state.CONFIG;

      var appearance = document.createElement("div");
      appearance.className = "settings-full first";
      var ah = document.createElement("h4");
      ah.textContent = "Appearance";
      var themeHelp = helpToggle("Applies as you pick, and sticks once you save. \"Auto\" follows your " +
        "system's light/dark setting.");
      ah.appendChild(themeHelp.button);
      appearance.appendChild(ah);
      appearance.appendChild(themeHelp.hint);
      appearance.appendChild(themeGrid(chosenTheme, function (id) { chosenTheme = id; }));
      host.appendChild(appearance);

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
        [{ label: "Auto-detect", value: "auto" }].concat(languageOptions()),
        CONFIG.transcribeLanguage || "auto",
        "Pin this if auto-detect keeps guessing the wrong language for you (e.g. Hindi heard as Urdu) - " +
        "Hindi still handles English mixed in fine. Cross-language detection below is the softer version; " +
        "a pin here wins over it.");

      var gpu = CONFIG.gpu || ({} as StateConfig["gpu"]);
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
      var pathHelp = helpToggle("Every import — a detected volume or a source folder below — copies into here. " +
        "Change it with \"vno setting\" — moving it needs a re-scan.");
      pl.appendChild(pathHelp.button);
      pathField.appendChild(pl);
      var pv = document.createElement("div");
      pv.className = "path";
      pv.textContent = CONFIG.target;
      pathField.appendChild(pv);
      pathField.appendChild(pathHelp.hint);
      importCol.appendChild(pathField);

      openSel = selectField(importCol, "Open this viewer when a run finishes", [
        { label: "On — launch the viewer after import/transcribe", value: "true" },
        { label: "Off — finish quietly", value: "false" }
      ], String(CONFIG.openWhenDone !== false));

      rememberSel = selectField(importCol, "Remember deleted recordings", [
        { label: "On — don't re-import what I deleted here", value: "true" },
        { label: "Off — import whatever the device has", value: "false" }
      ], String(CONFIG.rememberDeletions !== false),
        "Deletes made here and by cleanup are logged, so importing again won't copy them back. " +
        "\"vno cleanup ledger\" forgets them.");

      // Summarization. Its own full-width section rather than a field in the
      // Transcription column - the prompt override needs room a half-width
      // column doesn't have. Optional feature, hidden behind its own
      // availability check the same way the GPU field above is when the
      // engine isn't there at all. See lib/llama/llamacpp.ts.
      var summarySection = document.createElement("div");
      summarySection.className = "settings-full";
      host.appendChild(summarySection);

      var sumLabel = document.createElement("h4");
      sumLabel.textContent = "Summarization";
      summarySection.appendChild(sumLabel);

      var summarization = state.SUMMARIZATION;
      summaryModelSel = null;
      summaryPromptTa = null;
      if (summarization && summarization.available) {
        summaryModelSel = selectField(summarySection, "Default model", [
          { label: "None", value: "" }
        ].concat(summarization.models.map(function (m) { return { label: m, value: m }; })),
          CONFIG.summaryModel || "",
          "Used by the deck's Summarize button (optional) and \`vno summarize\`. Drop more .gguf files " +
          "into the llama.cpp models folder, or run \`vno setup --summary-model <name>\`, to add more choices here.");

        summaryPromptTa = textareaField(summarySection, "Override prompt", CONFIG.summaryPrompt || "",
          summarization.defaultPrompt,
          "Replaces the instruction sent to the model before each transcript. Leave blank to use the " +
          "default shown as placeholder above. Whitespace-only input is treated the same as blank.");
      } else {
        var sh = document.createElement("p");
        sh.className = "hint";
        sh.textContent = "Summarization: optional, not set up - run \"vno setup --llama\" in a terminal to add it.";
        summarySection.appendChild(sh);
      }

      // Cross-language detection. A full-width row rather than a field in the
      // Transcription column: three dropdowns and a button don't fit in half
      // the dialog, and the saved rewrites need somewhere to sit.
      var crossSection = document.createElement("div");
      crossSection.className = "settings-full";
      host.appendChild(crossSection);

      var crossLabel = document.createElement("h4");
      crossLabel.textContent = "Cross-language detection";
      var crossHelp = helpToggle("whisper.cpp guesses the language from the first 30 seconds of each recording, " +
        "and it confuses languages that sound alike — Hindi and Urdu are the same language to it, so the same " +
        "voice can come out in Devanagari one day and Arabic script the next. It has no setting for \"prefer " +
        "this one\", only a hard pin that would also mislabel your English notes. So: pick a model here and vno " +
        "runs a quick detection pass before each transcription and rewrites the answer using your list below. " +
        "Leave the model off and nothing extra runs. On costs one extra model load per file — \"small\" is " +
        "already installed and plenty accurate for telling these apart.");
      crossLabel.appendChild(crossHelp.button);
      crossSection.appendChild(crossLabel);
      crossSection.appendChild(crossHelp.hint);

      var crossRow = document.createElement("div");
      crossRow.className = "crosslang-row";
      crossSection.appendChild(crossRow);

      crossModelSel = selectField(crossRow, "Detect model",
        ([{ label: "Off — no detection pass", value: "" }] as Option[]).concat(modelOptions()),
        (CONFIG.crossLanguage || {}).model || "");
      crossFromSel = selectField(crossRow, "When it detects", languageOptions(), "ur");
      crossToSel = selectField(crossRow, "Transcribe as", languageOptions(), "hi");
      crossAddBtn = button("Add", "", function () {
        if (crossFromSel.value === crossToSel.value) return;
        crossMap[crossFromSel.value] = crossToSel.value;
        renderCrossMap();
      });
      crossRow.appendChild(crossAddBtn);

      var crossChips = document.createElement("div");
      crossChips.className = "ext-chips";
      crossSection.appendChild(crossChips);

      function renderCrossMap() {
        crossChips.textContent = "";
        var codes = Object.keys(crossMap);
        if (codes.length === 0) {
          var none = document.createElement("span");
          none.className = "chip";
          none.textContent = "no rewrites yet";
          crossChips.appendChild(none);
          return;
        }
        codes.forEach(function (from) {
          var pill = document.createElement("button");
          pill.type = "button";
          pill.className = "chip on";
          pill.textContent = languageLabel(from) + " → " + languageLabel(crossMap[from]) + " ✕";
          pill.title = "Remove this rewrite";
          pill.addEventListener("click", function () {
            delete crossMap[from];
            renderCrossMap();
          });
          crossChips.appendChild(pill);
        });
      }

      function syncCrossEnabled() {
        var off = !crossModelSel.value;
        crossFromSel.disabled = off;
        crossToSel.disabled = off;
        crossAddBtn.disabled = off;
        crossChips.classList.toggle("is-off", off);
      }

      crossModelSel.addEventListener("change", function () {
        // Detection can't run against a pinned language, and picking a model
        // can only mean the user wants detection - so move the pin rather
        // than silently doing nothing. It's the field right above; they see it.
        if (crossModelSel.value && languageSel.value !== "auto") languageSel.value = "auto";
        syncCrossEnabled();
      });

      crossMap = Object.assign({}, (CONFIG.crossLanguage || {}).map || {});
      renderCrossMap();
      syncCrossEnabled();

      var sourcesSection = document.createElement("div");
      sourcesSection.className = "settings-full";
      host.appendChild(sourcesSection);

      var sourcesHead = document.createElement("div");
      sourcesHead.className = "source-list-head";
      var sourcesLabel = document.createElement("h4");
      sourcesLabel.textContent = "Additional Source Folders";
      var sourcesHelp = helpToggle("Folders synced every time you import, in addition to detected volumes — " +
        "e.g. wherever a phone's Quick Share/Quick Send drops files. Pattern is a \"*\"/\"?\" wildcard against " +
        "the filename (\"*\" = any audio or video file). \"Folder in target\" optionally routes this source's files into " +
        "a specific folder inside your target folder instead of a folder named after the source path — leave it " +
        "blank for the default.");
      sourcesLabel.appendChild(sourcesHelp.button);
      sourcesHead.appendChild(sourcesLabel);
      sourcesHead.appendChild(button("Add folder", "", function () {
        addSourceRow({ path: "", pattern: "*", recursive: false, deleteAfterImport: false, mapTo: null });
      }));
      sourcesSection.appendChild(sourcesHead);
      sourcesSection.appendChild(sourcesHelp.hint);
      // Deliberately not folded into the help above: this one warns about
      // deleting the user's files, and a warning you have to click to see
      // isn't a warning.
      var sw = document.createElement("p");
      sw.className = "hint";
      sw.textContent = "\"Delete after import\" removes the file from the source folder once it's safely copied " +
        "in — only turn that on for a disposable landing folder, not a real archive.";
      sourcesSection.appendChild(sw);

      var sourcesBox = document.createElement("div");
      sourcesBox.className = "source-list";
      sourcesSection.appendChild(sourcesBox);

      var allExts = CONFIG.mediaExtensions || [];

      function addSourceRow(entry: Source) {
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
        chipsWrap.title = "Which audio/video file types to pick up from this folder";
        var extState: Record<string, boolean> = {};
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

      (CONFIG.sources || []).forEach(function (s) { addSourceRow(s); });
    },
    onConfirm: function () {
      var patch: SettingsPatch = {
        theme: chosenTheme,
        autoTranslate: autoSel.value === "null" ? null : autoSel.value === "true",
        defaultModel: modelSel.value,
        transcribeLanguage: languageSel.value,
      crossLanguageModel: crossModelSel.value || null,
      crossLanguageMap: crossMap,
        openWhenDone: openSel.value === "true",
        rememberDeletions: rememberSel.value === "true"
      };
      if (gpuSel) patch.useGpu = gpuSel.value === "true";
      if (summaryModelSel) patch.summaryModel = summaryModelSel.value || null;
      if (summaryPromptTa) patch.summaryPrompt = summaryPromptTa.value.trim() || null;
      var sources = sourceRows
        .map(function (r) {
          return {
            path: r.pathInput.value.trim(),
            pattern: patternFromExts(r.selectedExts(), state.CONFIG.mediaExtensions || []),
            recursive: r.recCb.checked,
            deleteAfterImport: r.delCb.checked,
            mapTo: r.mapToInput.value.trim() || null
          };
        })
        .filter(function (s) { return s.path; });
      return api("/api/settings", { method: "POST", body: patch })
        .then(function () {
          return api<{ config: StateConfig }>("/api/sources", { method: "POST", body: { sources: sources } });
        })
        .then(function (res) {
          state.CONFIG = res.config;
          toast("Settings saved", "ok");
        });
    }
  });
}

/**
 * The theme picker. Each card carries the theme's id on its swatch, so the
 * swatch renders in that theme's own tokens straight out of app.css - no
 * colour value is repeated in JS, and a palette edited in the stylesheet
 * shows up here without touching this file. Picking one previews it on the
 * whole page immediately; the caller decides whether to keep it.
 */
function themeGrid(selected: string, onPick: (id: ThemeId) => void): HTMLElement {
  var wrap = document.createElement("div");
  wrap.className = "theme-grid";
  wrap.setAttribute("role", "group");
  wrap.setAttribute("aria-label", "Theme");

  var cards: HTMLButtonElement[] = [];
  (state.THEMES || []).forEach(function (theme) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "theme-card";
    card.setAttribute("aria-pressed", String(theme.id === selected));

    var swatch = document.createElement("span");
    swatch.className = "swatch";
    swatch.setAttribute("data-theme", theme.id);
    ["s-dot", "s-bar lit", "s-bar"].forEach(function (cls) {
      var part = document.createElement("i");
      part.className = cls;
      swatch.appendChild(part);
    });
    card.appendChild(swatch);

    var name = document.createElement("span");
    name.className = "t-name";
    name.appendChild(document.createTextNode(theme.label));
    var check = document.createElement("span");
    check.className = "t-check";
    check.textContent = "✓";
    name.appendChild(check);
    card.appendChild(name);

    if (theme.blurb) {
      var blurb = document.createElement("span");
      blurb.className = "t-blurb";
      blurb.textContent = theme.blurb;
      card.appendChild(blurb);
    }

    card.addEventListener("click", function () {
      applyTheme(theme.id);
      onPick(theme.id);
      cards.forEach(function (c) { c.setAttribute("aria-pressed", String(c === card)); });
    });
    wrap.appendChild(card);
    cards.push(card);
  });
  return wrap;
}

// Confirms removing a source folder entry before it's actually taken out of
// `sourceRows` - removing it only forgets the sync configuration, it never
// touches files already copied into target, so the dialog makes that
// explicit and offers an Explore button to go see (and reorganize/delete,
// if wanted) what's there. `onRemove` runs only if the user confirms.
function confirmRemoveSource(sourcePath: string, mapTo: string | null, onRemove: () => void): void {
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

function exploreSourceDest(sourcePath: string, mapTo: string | null): Promise<void> {
  return api("/api/sources/explore", { method: "POST", body: { path: sourcePath, mapTo: mapTo } })
    .then(function () { toast("Opened folder"); })
    .catch(function (err) { toast(String(err instanceof Error ? err.message : err), "err"); });
}

// General-purpose folder browser for source folders, which - unlike volume
// subfolders in the Import panel - can live anywhere on disk. Browsers can't
// hand a real filesystem path back from window.showDirectoryPicker(), so
// this walks the tree server-side instead, starting from the drive/root list.
function browseFsFolders(
  currentPath: string | null,
  onPick: (chosen: string) => void,
  closePrev?: () => void
): void {
  api<FsLevel>("/api/browse-fs" + (currentPath ? "?path=" + encodeURIComponent(currentPath) : ""))
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
    .catch(function (err) { toast(String(err instanceof Error ? err.message : err), "err"); });
}

// Folder browser for a source's mapping folder, confined to the target
// folder (unlike browseFsFolders above, which can go anywhere on disk) -
// mirrors the server's containment check in routes/import.ts:browseTarget.
// `relPath` is target-relative ("" = target root), and that's what's
// returned to `onPick` too, since mapTo is stored relative to target.
function browseTargetFolder(
  relPath: string,
  onPick: (chosen: string) => void,
  closePrev?: () => void
): void {
  api<TargetLevel>("/api/browse-target" + (relPath ? "?sub=" + encodeURIComponent(relPath) : ""))
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
    .catch(function (err) { toast(String(err instanceof Error ? err.message : err), "err"); });
}

function fsFolderRow(label: string, onClick: () => void): HTMLElement {
  var row = document.createElement("div");
  row.className = "pick";
  row.style.cursor = "pointer";
  row.textContent = label;
  row.addEventListener("click", onClick);
  return row;
}

// "*" (or empty/legacy) means "any audio or video file" - shown as every extension
// selected, since that's the equivalent state in the multi-select. A
// pattern this UI didn't produce (a hand-edited config.json with a custom
// wildcard like "VN*.m4a") has no clean multi-select equivalent, so it
// also falls back to "everything selected" rather than silently dropping
// files - the config file value itself isn't touched until Save.
function extsFromPattern(pattern: string, allExts: string[]): string[] {
  if (!pattern || pattern === "*") return allExts.slice();
  var parts = pattern.split(",").map(function (p) { return p.trim().toLowerCase(); });
  var matched = allExts.filter(function (ext) { return parts.indexOf("*" + ext) !== -1; });
  return matched.length ? matched : allExts.slice();
}

function patternFromExts(selected: string[], allExts: string[]): string {
  if (!selected.length || selected.length === allExts.length) return "*";
  return selected.map(function (ext) { return "*" + ext; }).join(",");
}
