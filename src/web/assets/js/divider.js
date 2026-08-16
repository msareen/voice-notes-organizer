import { dom } from "./dom.js";

/* ---- Draggable divider: resize the takes list ---- */
export function initDivider() {
  var MIN = 240, MAX_FRAC = 0.7, STEP = 24, KEY = "vno-sidebar-w";
  function setWidth(px) {
    var max = Math.max(MIN, window.innerWidth * MAX_FRAC);
    px = Math.max(MIN, Math.min(max, px));
    dom.sidebar.style.width = px + "px";
    try { localStorage.setItem(KEY, String(px)); } catch (e) {}
  }
  var saved = (function () { try { return parseFloat(localStorage.getItem(KEY)); } catch (e) { return NaN; } })();
  if (saved > 0) setWidth(saved);

  var dragging = false;
  dom.divider.addEventListener("pointerdown", function (e) {
    dragging = true;
    dom.divider.classList.add("dragging");
    document.body.classList.add("resizing");
    dom.divider.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  dom.divider.addEventListener("pointermove", function (e) {
    if (!dragging) return;
    setWidth(e.clientX - dom.sidebar.getBoundingClientRect().left);
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    dom.divider.classList.remove("dragging");
    document.body.classList.remove("resizing");
    try { dom.divider.releasePointerCapture(e.pointerId); } catch (err) {}
  }
  dom.divider.addEventListener("pointerup", endDrag);
  dom.divider.addEventListener("pointercancel", endDrag);
  dom.divider.addEventListener("keydown", function (e) {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    e.preventDefault();
    setWidth(dom.sidebar.getBoundingClientRect().width + (e.key === "ArrowRight" ? STEP : -STEP));
  });
  dom.divider.addEventListener("dblclick", function () {
    dom.sidebar.style.width = "";
    try { localStorage.removeItem(KEY); } catch (e) {}
  });
}
