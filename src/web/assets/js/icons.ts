// The handful of icons the client builds at runtime (the topbar's are inline
// in page.ts instead, since that markup is server-rendered). SVG elements
// have to be created in their own namespace - createElement("svg") makes an
// unknown HTML element that renders as nothing.
// `as const` so createElementNS resolves to its SVG overload rather than the
// generic one that returns a bare Element.
var NS = "http://www.w3.org/2000/svg" as const;

interface IconSpec {
  fill: boolean;
  d: string[];
}

var ICONS: Record<string, IconSpec> = {
  play: { fill: true, d: ["M8 5.2v13.6L19 12z"] },
  pause: { fill: true, d: ["M8 5h3.2v14H8z", "M12.8 5H16v14h-3.2z"] },
  "chevron-up": { fill: false, d: ["M6 15l6-6 6 6"] },
  "chevron-down": { fill: false, d: ["M6 9l6 6 6-6"] },
  folder: { fill: false, d: ["M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z"] }
};

export function icon(name: string, size?: number): SVGSVGElement {
  var spec = ICONS[name];
  var svg = document.createElementNS(NS, "svg");
  svg.setAttribute("class", "ico");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", String(size || 16));
  svg.setAttribute("height", String(size || 16));
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("fill", spec.fill ? "currentColor" : "none");
  if (!spec.fill) {
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "1.7");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
  }
  spec.d.forEach(function (d) {
    var p = document.createElementNS(NS, "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  });
  return svg;
}
