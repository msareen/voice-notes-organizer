// Fetch wrapper (token header, JSON in/out) plus the toast notification used
// to surface errors from any panel.
import { state } from "./state.js";

/* Every call carries the session token the CLI minted, so nothing else on
   this machine can drive the file-touching endpoints. */
export function api(path, options) {
  options = options || {};
  var headers = { "X-VNO-Token": state.TOKEN };
  if (options.body) headers["Content-Type"] = "application/json";
  return fetch(path, {
    method: options.method || "GET",
    headers: headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  }).then(function (res) {
    if (!res.ok) {
      return res.text().then(function (t) { throw new Error(t || ("HTTP " + res.status)); });
    }
    return res.status === 204 ? null : res.json();
  });
}

var toastTimer = null;
export function toast(message, kind) {
  var existing = document.querySelector(".toast");
  if (existing) existing.remove();
  var el = document.createElement("div");
  el.className = "toast" + (kind ? " " + kind : "");
  el.textContent = message;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.remove(); }, kind === "err" ? 6000 : 2600);
}

export function fail(err) { toast(String(err.message || err), "err"); }
