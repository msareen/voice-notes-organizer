// Element refs shared across modules. Grabbed once at module load, which
// happens after DOM parsing since <script type="module"> is deferred by
// default.
export const dom = {
  list: document.getElementById("list"),
  shown: document.getElementById("shown"),
  q: document.getElementById("q"),
  placeholder: document.getElementById("placeholder"),
  body: document.getElementById("detailBody"),
  detail: document.getElementById("detail"),
  sidebar: document.querySelector(".sidebar"),
  divider: document.getElementById("divider"),
  live: document.getElementById("live")
};
