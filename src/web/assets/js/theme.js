// The colour theme is an id on <html>; every palette lives in app.css keyed
// off that attribute, so switching one is a single attribute write and no
// stylesheet has to be swapped. The server stamps the saved theme into the
// page shell (page.js), which is why nothing here runs on load - this only
// handles changes: the settings dialog's live preview, and a state reload
// after the change is saved.
var FALLBACK = "tape";

export function applyTheme(id) {
  if (!id) return;
  document.documentElement.setAttribute("data-theme", id);
}

export function currentTheme() {
  return document.documentElement.getAttribute("data-theme") || FALLBACK;
}
