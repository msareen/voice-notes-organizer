// Full-text search over take names and their transcripts, shared by the
// filter box (list.js) and the deck's transcript highlight (deck.js).
//
// Matching runs over a whitespace-normalised copy of the transcript, not the
// text as stored: a timed transcript is joined cue-by-cue with newlines, so a
// phrase the speaker said across a cue boundary ("the budget review") only
// reads as contiguous once every run of whitespace collapses to one space.
// Name and path go into the same string, so a single indexOf answers both
// halves of the search.
//
// Those strings are built once per note and kept in a WeakMap. The notes
// array is replaced wholesale on every state reload, so entries for notes
// that went away are collectable and there is nothing to invalidate by hand -
// an edited transcript arrives as a new note object with an empty slot.

var index = new WeakMap();

export function normalize(s) {
  return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
}

function entryFor(note) {
  var e = index.get(note);
  if (!e) {
    var text = normalize(note.text);
    e = {
      text: text, // display copy, original case, for snippets
      lower: text.toLowerCase(),
      hay: (normalize(note.title) + " " + normalize(note.name) + " " + text).toLowerCase()
    };
    index.set(note, e);
  }
  return e;
}

/**
 * Builds the index ahead of the first keystroke, in idle slices, so a library
 * with thousands of transcripts doesn't pay for all of them at once the
 * moment someone types. Purely an optimisation - `matches` builds whatever
 * this hasn't reached yet.
 */
export function warmIndex(notes) {
  var i = 0;
  function slice(deadline) {
    // A budget as well as the deadline, since the setTimeout fallback has no
    // deadline to consult and mustn't run the whole library in one frame.
    var budget = 250;
    while (i < notes.length && budget-- > 0 && (!deadline || deadline.timeRemaining() > 1)) {
      entryFor(notes[i++]);
    }
    if (i < notes.length) schedule(slice);
  }
  schedule(slice);
}

function schedule(fn) {
  if (window.requestIdleCallback) window.requestIdleCallback(fn, { timeout: 500 });
  else setTimeout(function () { fn(null); }, 0);
}

/** `term` must already be normalised and lowercased - see `normalize`. */
export function matches(note, term) {
  return !term || entryFor(note).hay.indexOf(term) !== -1;
}

/**
 * Transcript context around the first hit, as `{ before, hit, after }` with
 * ellipses where the text was cut, or null when the term isn't in the
 * transcript (a name-only match). This is what tells someone why a take with
 * an unrelated filename is still in their filtered list.
 */
export function snippet(note, term, pad) {
  if (!term) return null;
  var e = entryFor(note);
  var at = e.lower.indexOf(term);
  if (at === -1) return null;
  pad = pad || 48;
  var from = Math.max(0, at - pad);
  var to = Math.min(e.text.length, at + term.length + pad);
  return {
    before: (from > 0 ? "…" : "") + e.text.slice(from, at),
    hit: e.text.slice(at, at + term.length),
    after: e.text.slice(at + term.length, to) + (to < e.text.length ? "…" : "")
  };
}

/**
 * Fills `el` with `text`, wrapping each occurrence of `term` in a <mark>.
 * Built from text nodes rather than innerHTML: transcript text is user
 * content and never goes near an HTML parser anywhere else in this UI.
 * Returns the number of marks added.
 */
export function markInto(el, text, term) {
  el.textContent = "";
  if (!term) { el.textContent = text; return 0; }
  var lower = text.toLowerCase();
  var at = 0;
  var hits = 0;
  for (;;) {
    var i = lower.indexOf(term, at);
    if (i === -1) break;
    if (i > at) el.appendChild(document.createTextNode(text.slice(at, i)));
    var m = document.createElement("mark");
    m.className = "hit";
    m.textContent = text.slice(i, i + term.length);
    el.appendChild(m);
    at = i + term.length;
    hits++;
  }
  el.appendChild(document.createTextNode(text.slice(at)));
  return hits;
}
