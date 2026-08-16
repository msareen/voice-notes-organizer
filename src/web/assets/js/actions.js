// OS-reveal actions shared by the takes list (folder icon) and the deck
// (per-note "Open file location").
import { api, toast, fail } from "./api.js";

export function revealFile(rel) {
  api("/api/reveal", { method: "POST", body: { rel: rel } })
    .then(function () { toast("Opened file location"); })
    .catch(fail);
}

export function revealFolder(dir) {
  api("/api/reveal", { method: "POST", body: { dir: dir || "" } })
    .then(function () { toast("Opened folder"); })
    .catch(fail);
}
