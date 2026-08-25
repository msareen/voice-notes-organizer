// Transcribe panel: pick which recordings to run whisper over, with which
// model, and whether to translate instead of a verbatim transcript.
import { state } from "../state.ts";
import { api, toast } from "../api.ts";
import { modal, selectField, pickList, checkbox } from "../widgets.ts";
import { modelOptions, languageOptions } from "../models.ts";
import { missingDeps } from "../deps.ts";
import type { Note } from "../../../../types.ts";
import type { PickHandle } from "../widgets.ts";

export function openTranscribe(onlyRel: string | null): void {
  var candidates = onlyRel ? state.NOTES.filter(function (n) { return n.rel === onlyRel; }) : state.NOTES;
  if (!candidates.length) return toast("No recordings to transcribe", "err");

  // Default to the ones with nothing yet - that's the common case. Asking
  // for one specific note is explicit, so that one starts checked, as does
  // everything when there's no backlog left to single out.
  var pending = candidates.filter(function (n) { return !n.hasTranscript; });
  var defaultOn: Note[] | null = (onlyRel || pending.length === 0) ? null : pending;

  var picks: PickHandle;
  var modelSel: HTMLSelectElement;
  var languageSel: HTMLSelectElement | null;
  var translateChk: HTMLInputElement;
  modal({
    title: onlyRel ? "Transcribe this take" : "Transcribe",
    message: missingDeps() ?? undefined,
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
      // Only for a single take: re-running one recording is exactly when a
      // one-off pin makes sense (auto-detect got it wrong, or Settings'
      // pin/cross-language plan doesn't apply here) - batch runs keep using
      // Settings' language plan for every file, same as before.
      languageSel = onlyRel
        ? selectField(host, "Language", [{ label: "Auto-detect", value: "auto" }].concat(languageOptions()),
            state.CONFIG.transcribeLanguage || "auto")
        : null;
      translateChk = checkbox(host, "Translate to English instead of a verbatim transcript", false);
    },
    onConfirm: function () {
      var rels = picks.selected();
      if (!rels.length) throw new Error("Nothing selected");
      var body: Record<string, unknown> = { rels: rels, model: modelSel.value, translate: translateChk.checked };
      if (languageSel) body.language = languageSel.value;
      return api("/api/transcribe", { method: "POST", body: body })
        .then(function () { toast("Started on " + rels.length + " file(s)"); });
    }
  });
}
