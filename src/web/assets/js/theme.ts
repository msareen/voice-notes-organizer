// The colour theme is an id on <html>; every palette lives in app.css keyed
// off that attribute, so switching one is a single attribute write and no
// stylesheet has to be swapped. The server stamps the saved theme into the
// page shell (page.ts), which is why nothing here runs on load - this only
// handles changes: the settings dialog's live preview, and a state reload
// after the change is saved.
var FALLBACK = "tape";

// Mirrors the saved theme into localStorage so offline.html - served by the
// service worker with no server to ask - can still paint something close to
// the user's theme instead of a hardcoded one. Call only with a confirmed
// saved value (page.ts's initial stamp, or a post-save state reload), never
// with a settings-dialog live preview - a preview that never gets saved
// shouldn't outlive the page it was shown on.
export function rememberTheme(id: string | null | undefined): void {
  if (!id) return;
  try {
    localStorage.setItem("vno-theme", id);
  } catch {
    // Private browsing / storage disabled - offline.html just falls back.
  }
}

export function applyTheme(id: string | null | undefined): void {
  if (!id) return;
  document.documentElement.setAttribute("data-theme", id);
}

export function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") || FALLBACK;
}
