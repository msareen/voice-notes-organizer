/* --------------------------------------------------------------------------
 * The page shell. Styles and behaviour live in assets/app.css and
 * assets/app.js, which the server hands out as plain static files - there is
 * still no build step. The shell below ships empty and the client fills it
 * from /api/state, so every edit/delete/setting change is reflected without
 * regenerating a file.
 *
 * The session token is inlined here rather than fetched, so it never travels
 * in an asset URL: app.js reads it off window on its first line.
 *
 * The theme id is stamped onto <html> here for the same reason the token is
 * inlined: a palette that only arrived with /api/state would paint the
 * default one first and then swap, which reads as a bug.
 * ------------------------------------------------------------------------ */

/* Icons are inline SVG rather than a font or sprite sheet - a handful of
   24-grid stroke paths costs less than another asset request, and they
   inherit `currentColor` so every theme gets them right for free. */
const ICONS = {
  import: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="M7 10l5 5 5-5"/><path d="M12 15V3"/>',
  transcribe: '<path d="M4 9v6"/><path d="M8 5v14"/><path d="M12 8v8"/><path d="M16 4v16"/><path d="M20 10v4"/>',
  cleanup: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>',
  explore: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  quit: '<path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><path d="M12 2v10"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/>',
};

function icon(name) {
  return (
    `<svg class="ico" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ` +
    `stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
  );
}

export function renderPage({ rootLabel, token, theme = "tape" }) {
  const folderName = escapeHtml(rootLabel);

  return `<!doctype html>
<html lang="en" data-theme="${escapeHtml(theme)}">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Voice Notes · ${folderName}</title>
<link rel="icon" type="image/svg+xml" href="/assets/icon.svg" />
<link rel="stylesheet" href="/assets/app.css" />
</head>
<body>
<div class="shell">
  <header class="topbar">
    <div class="brand">
      <span class="rec" id="live" aria-hidden="true"></span>
      <span class="wordmark">Voice Notes</span>
    </div>
    <span class="folder" id="folderLabel">${folderName}</span>
    <nav class="ops" aria-label="Commands">
      <button class="btn" id="btnImport" title="Detect volumes and import voice notes">${icon("import")}<span>Import</span></button>
      <button class="btn" id="btnTranscribe" title="Run whisper over your recordings">${icon("transcribe")}<span>Transcribe</span></button>
      <button class="btn" id="btnCleanup" title="Delete very short recordings">${icon("cleanup")}<span>Cleanup</span></button>
      <button class="btn" id="btnFolder" title="Open the target folder in Explorer / Finder (same as vno explore)">${icon("explore")}<span>Explore</span></button>
    </nav>
    <span class="spacer"></span>
    <div class="readout">
      <div class="stat"><b id="statTakes">—</b><span>Recordings</span></div>
      <div class="stat"><b id="statTotal">—</b><span>Total time</span></div>
    </div>
    <div class="sysbar">
      <button class="btn icon" id="btnSettings" title="Settings" aria-label="Settings">${icon("settings")}</button>
      <button class="btn icon danger" id="btnQuit" title="Stop the vno server and close this page" aria-label="Quit vno">${icon("quit")}</button>
    </div>
  </header>
  <div class="jobstrip" id="jobstrip">
    <span class="jt" id="jobTitle"></span>
    <span class="bar"><i id="jobBar"></i></span>
    <span class="pct" id="jobPct"></span>
    <button class="btn" id="btnLog">Log</button>
  </div>
  <div class="app">
    <aside class="sidebar">
      <div class="side-head">
        <p class="side-label"><span id="shown"></span></p>
        <div class="search">
          ${icon("search")}
          <input id="q" type="search" placeholder="Filter takes…" aria-label="Filter takes" />
        </div>
      </div>
      <div class="filelist" id="list" role="listbox" aria-label="Takes"></div>
    </aside>
    <div class="divider" id="divider" role="separator" aria-orientation="vertical"
         tabindex="0" aria-label="Resize the takes list" title="Drag to resize"></div>
    <main class="detail" id="detail">
      <div class="placeholder" id="placeholder"><div class="big">Loading…</div></div>
      <div class="detail-body hidden" id="detailBody"></div>
    </main>
  </div>
</div>

<script>window.__VNO_TOKEN = ${JSON.stringify(token)};</script>
<script type="module" src="/assets/app.js"></script>
</body>
</html>
`;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
