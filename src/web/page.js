/* --------------------------------------------------------------------------
 * The page shell. Styles and behaviour live in assets/app.css and
 * assets/app.js, which the server hands out as plain static files - there is
 * still no build step. The shell below ships empty and the client fills it
 * from /api/state, so every edit/delete/setting change is reflected without
 * regenerating a file.
 *
 * The session token is inlined here rather than fetched, so it never travels
 * in an asset URL: app.js reads it off window on its first line.
 * ------------------------------------------------------------------------ */

export function renderPage({ rootLabel, token }) {
  const folderName = escapeHtml(rootLabel);

  return `<!doctype html>
<html lang="en">
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
    <span class="rec" id="live" aria-hidden="true"></span>
    <span class="wordmark">Voice Notes</span>
    <span class="folder" id="folderLabel">${folderName}</span>
    <button class="btn" id="btnImport" title="Detect volumes and import voice notes">Import</button>
    <button class="btn" id="btnTranscribe" title="Run whisper over your recordings">Transcribe</button>
    <button class="btn" id="btnCleanup" title="Delete very short recordings">Cleanup</button>
    <button class="btn" id="btnFolder" title="Open the target folder in Explorer / Finder (same as vno explore)">Explore</button>
    <button class="btn" id="btnSettings">Settings</button>
    <span class="spacer"></span>
    <div class="readout">
      <div class="stat"><b id="statTakes">—</b><span>Recordings</span></div>
      <div class="stat"><b id="statTotal">—</b><span>Total time</span></div>
    </div>
    <button class="btn danger" id="btnQuit" title="Stop the vno server and close this page">Quit</button>
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
        <input id="q" type="search" placeholder="filter takes…" aria-label="Filter takes" />
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
<script src="/assets/app.js"></script>
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
