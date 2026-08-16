// Cleanup panel: scan for recordings under a duration threshold and delete
// the ones picked from the results.
import { api, toast } from "../api.js";
import { modal, pickList } from "../widgets.js";

export function openCleanup() {
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
