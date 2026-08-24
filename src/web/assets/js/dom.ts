// Element refs shared across modules. Grabbed once at module load, which
// happens after DOM parsing since <script type="module"> is deferred by
// default.

/**
 * Every one of these is emitted by web/page.ts, so a miss is a shell/client
 * mismatch rather than something to handle. Throwing names the element instead
 * of leaving a null to surface later as a property access on null.
 */
function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  var node = document.getElementById(id);
  if (!node) throw new Error("Missing #" + id + " in the page shell");
  return node as T;
}

export const dom = {
  list: byId("list"),
  shown: byId("shown"),
  q: byId<HTMLInputElement>("q"),
  placeholder: byId("placeholder"),
  body: byId("detailBody"),
  detail: byId("detail"),
  sidebar: document.querySelector(".sidebar") as HTMLElement,
  divider: byId("divider"),
  live: byId("live")
};
