// Import panel: pick detected volumes/configured sources and, per volume,
// drill into its folder tree to pin a subfolder before syncing.
import { state } from "../state.js";
import { api, toast, fail } from "../api.js";
import { button, modal, pickList, checkbox } from "../widgets.js";
import { missingDeps } from "../deps.js";

export function openImport() {
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
          // Configured source folders always sync their whole folder
          // (optionally pattern-filtered), so there's nothing to browse.
          var extra;
          if (v.isManualSource) {
            var tags = [];
            if (v.pattern && v.pattern !== "*") tags.push("pattern " + v.pattern);
            tags.push(v.recursive ? "includes subfolders" : "this folder only");
            if (v.deleteAfterImport) tags.push("deletes source");
            extra = document.createElement("span");
            extra.className = "pk-right";
            extra.textContent = tags.join(", ");
          } else {
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
            extra = browse;
          }
          return {
            value: v.id,
            name: v.name + (v.isManualSource ? "  (configured source)" : ""),
            sub: v.mountPath + (v.known && v.known.lastSynced ? "  · last synced " + v.known.lastSynced.slice(0, 10) : ""),
            extra: extra,
            checked: v.isManualSource || !!(v.known && v.known.autoImport)
          };
        }));
        translateChk = checkbox(host, "Translate newly imported notes to English with whisper",
          state.CONFIG.autoTranslate === true);
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
