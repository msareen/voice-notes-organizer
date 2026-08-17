// Cleanup panel: scan for recordings under a duration threshold and delete
// the ones picked from the results. Optionally also offers the damaged
// pre-repair originals kept beside repaired Samsung recordings.
import { api, toast } from "../api.js";
import { modal, pickList, checkbox } from "../widgets.js";

export function openCleanup() {
  var thresholdInput;
  var originalsBox;
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

      originalsBox = checkbox(host, "Also list pre-repair originals (.original.m4a)", false);
      var hint = document.createElement("div");
      hint.className = "hint";
      hint.textContent = "Kept when vno repairs a damaged Samsung recording. Safe to delete once the " +
        "repaired recording sounds right - they're not playable on their own.";
      host.appendChild(hint);
    },
    onConfirm: function () {
      var threshold = parseFloat(thresholdInput.value) || 3;
      var wantOriginals = originalsBox.checked;
      var url = "/api/cleanup/scan?threshold=" + encodeURIComponent(threshold) +
        (wantOriginals ? "&originals=1" : "");
      return api(url).then(function (res) { showCleanupResults(res, wantOriginals); });
    }
  });
}

function sizeLabel(bytes) {
  if (typeof bytes !== "number" || !isFinite(bytes)) return "";
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function showCleanupResults(res, wantOriginals) {
  var originals = res.originals || [];
  if (!res.short.length && !originals.length) {
    return modal({
      title: "Cleanup",
      message: "Nothing shorter than " + res.threshold + "s among " + res.scanned + " recording(s)." +
        (wantOriginals ? " No pre-repair originals either." : ""),
      onConfirm: null
    });
  }

  // Both groups share one pick list so there's a single selection and a single
  // confirm, but they're kept apart on the way out: deleting a recording takes
  // its transcripts and is remembered by the ledger, deleting a pre-repair
  // original does neither.
  var originalRels = {};
  originals.forEach(function (o) { originalRels[o.rel] = true; });

  var items = res.short.map(function (s) {
    return { value: s.rel, name: s.name, sub: s.rel, right: s.durationSec.toFixed(1) + "s" };
  }).concat(originals.map(function (o) {
    return {
      value: o.rel,
      name: o.name,
      sub: "pre-repair original of " + o.recordingName,
      right: sizeLabel(o.size),
      checked: false
    };
  }));

  var parts = [];
  if (res.short.length) parts.push(res.short.length + " recording(s) under " + res.threshold + "s");
  if (originals.length) parts.push(originals.length + " pre-repair original(s)");

  var picks;
  modal({
    title: "Delete files",
    message: parts.join(" and ") + ". This can't be undone.",
    confirmLabel: "Delete",
    danger: true,
    build: function (host) { picks = pickList(host, items); },
    onConfirm: function () {
      var chosen = picks.selected();
      if (!chosen.length) throw new Error("Nothing selected");
      var body = {
        rels: chosen.filter(function (rel) { return !originalRels[rel]; }),
        originals: chosen.filter(function (rel) { return originalRels[rel]; })
      };
      return api("/api/cleanup", { method: "POST", body: body }).then(function (out) {
        var n = (out.removed || 0) + (out.removedOriginals || 0);
        toast("Deleted " + n + " file(s)", "ok");
      });
    }
  });
}
