// OS-reveal actions shared by the takes list (folder icon) and the deck
// (per-note "Open file location").
import { api, toast, fail } from "./api.ts";

export function revealFile(rel: string): void {
  api("/api/reveal", { method: "POST", body: { rel: rel } })
    .then(function () { toast("Opened file location"); })
    .catch(fail);
}

export function revealFolder(dir: string): void {
  api("/api/reveal", { method: "POST", body: { dir: dir || "" } })
    .then(function () { toast("Opened folder"); })
    .catch(fail);
}
