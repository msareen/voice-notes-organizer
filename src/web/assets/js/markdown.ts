// Minimal, dependency-free markdown -> HTML for model-generated summaries -
// no npm markdown lib fits this repo's "no build step, no bundler" browser
// project (see AGENTS.md), and a summary is short prose, not a document, so
// a small hand-rolled renderer covering what llama.cpp models actually
// produce (headings, bold/italic, inline code, lists, paragraphs) is plenty.
// Deliberately no tables/links/images/blockquotes - keeps the whole thing
// easy to audit for the one thing that matters here: never emitting
// unescaped model text as HTML.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Runs only after escapeHtml, so every replacement below is composing
// already-safe HTML around already-escaped text - there is no path from
// model text to a raw tag.
function inline(s: string): string {
  var out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_]+)__/g, "<strong>$1</strong>");
  out = out.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  out = out.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  return out;
}

/** Renders `text` as markdown -> sanitized HTML, ready for `innerHTML`. */
export function renderMarkdown(text: string): string {
  var lines = text.replace(/\r\n/g, "\n").split("\n");
  var html: string[] = [];
  var paraBuffer: string[] = [];
  var listBuffer: string[] = [];
  var listType: "ul" | "ol" | null = null;

  function flushList(): void {
    if (listType) {
      html.push("<" + listType + ">" + listBuffer.join("") + "</" + listType + ">");
      listBuffer = [];
      listType = null;
    }
  }
  function flushPara(): void {
    if (paraBuffer.length) {
      html.push("<p>" + inline(paraBuffer.join(" ")) + "</p>");
      paraBuffer = [];
    }
  }

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }

    var heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      flushList();
      var level = heading[1].length;
      html.push("<h" + level + ">" + inline(heading[2]) + "</h" + level + ">");
      continue;
    }

    var ordered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    var bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ordered || bullet) {
      flushPara();
      var type: "ul" | "ol" = ordered ? "ol" : "ul";
      if (listType && listType !== type) flushList();
      listType = type;
      var content = ordered ? ordered[1] : (bullet as RegExpExecArray)[1];
      listBuffer.push("<li>" + inline(content) + "</li>");
      continue;
    }

    flushList();
    paraBuffer.push(line.trim());
  }
  flushPara();
  flushList();
  return html.join("\n");
}
