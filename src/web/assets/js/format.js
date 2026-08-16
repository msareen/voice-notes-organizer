// Pure display formatters for durations, sizes and file extensions.
export function fmt(t) {
  t = Math.max(0, t | 0);
  var m = (t / 60) | 0, s = t % 60;
  return m + ":" + (s < 10 ? "0" : "") + s;
}

export function fmtDur(sec) {
  if (sec == null) return "--";
  sec = Math.round(sec);
  var h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
  var p = function (n) { return (n < 10 ? "0" : "") + n; };
  return h > 0 ? h + ":" + p(m) + ":" + p(s) : m + ":" + p(s);
}

export function fmtSize(b) {
  if (b == null) return "--";
  var u = ["B", "KB", "MB", "GB"], i = 0, n = b;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i === 0 ? n : n.toFixed(1)) + " " + u[i];
}

export function extOf(name) {
  var d = name.lastIndexOf(".");
  return d >= 0 ? name.slice(d + 1).toUpperCase() : "AUDIO";
}
