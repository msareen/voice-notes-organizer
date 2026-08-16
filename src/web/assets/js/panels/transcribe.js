// Transcribe panel: pick which recordings to run whisper over, with which
// model, and whether to translate instead of a verbatim transcript.
import { state } from "../state.js";
import { api, toast } from "../api.js";
import { modal, selectField, pickList, checkbox } from "../widgets.js";
import { modelOptions } from "../models.js";
import { missingDeps } from "../deps.js";

export function openTranscribe(onlyRel) {
  var candidates = onlyRel ? state.NOTES.filter(function (n) { return n.rel === onlyRel; }) : state.NOTES;
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
          sub: n.dir || state.CONFIG.rootLabel,
          right: n.hasTranscript ? "has transcript" : "no transcript",
          checked: defaultOn ? defaultOn.indexOf(n) !== -1 : true
        };
      }));
      modelSel = selectField(host, "Whisper model",
        modelOptions(),
        state.CONFIG.defaultModel);
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
