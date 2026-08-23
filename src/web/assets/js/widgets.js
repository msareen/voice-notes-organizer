// Generic DOM widgets (buttons, the modal shell, form fields, checkbox
// picklists) reused by every panel - nothing here knows about notes or jobs.
import { fail } from "./api.js";

export function button(label, cls, onClick, title) {
  var b = document.createElement("button");
  b.className = "btn" + (cls ? " " + cls : "");
  b.type = "button";
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

export function chip(label, value, valueId) {
  var c = document.createElement("span");
  c.className = "chip";
  c.appendChild(document.createTextNode(label + " "));
  var b = document.createElement("b");
  if (valueId) b.id = valueId;
  b.textContent = value;
  c.appendChild(b);
  return c;
}

/* ---- Modal ---- */
export function modal(spec) {
  var backdrop = document.createElement("div");
  backdrop.className = "backdrop" + (spec.panel ? " panel" : "");
  var box = document.createElement("div");
  box.className = "modal" + (spec.panel ? " panel" : spec.wide ? " wide" : "");
  backdrop.appendChild(box);

  var h = document.createElement("h3");
  h.textContent = spec.title;
  box.appendChild(h);

  // Content scrolls in its own element rather than the whole dialog, so the
  // title stays put and the action row sits on the bottom edge instead of
  // wherever the content happens to end. `build` is handed this rather than
  // the box - every caller only appends, so it can't tell the difference.
  var body = document.createElement("div");
  body.className = "modal-body";
  box.appendChild(body);

  if (spec.message) {
    var p = document.createElement("p");
    p.textContent = spec.message;
    body.appendChild(p);
  }
  if (spec.build) spec.build(body);

  var actions = document.createElement("div");
  actions.className = "modal-actions";
  var cancel = button("Cancel", "", close);
  actions.appendChild(cancel);
  var confirm = null;
  var confirmed = false;
  if (spec.onConfirm) {
    confirm = button(spec.confirmLabel || "OK", spec.danger ? "danger" : "primary", function () {
      confirm.disabled = true;
      cancel.disabled = true;
      // new Promise() so a synchronous throw inside onConfirm is caught too.
      new Promise(function (resolve) { resolve(spec.onConfirm()); })
        .then(function () { confirmed = true; close(); })
        .catch(function (err) {
          confirm.disabled = false;
          cancel.disabled = false;
          fail(err);
        });
    });
    actions.appendChild(confirm);
  } else {
    cancel.textContent = "Close";
  }
  box.appendChild(actions);

  // `onCancel` fires for every way out that isn't a completed confirm
  // (Cancel, Escape, a click on the backdrop), which is what a dialog with a
  // live preview needs to put back what the user was looking at.
  function close() {
    backdrop.remove();
    document.removeEventListener("keydown", onKey);
    if (!confirmed && spec.onCancel) spec.onCancel();
  }
  function isTopmost() {
    var all = document.querySelectorAll(".backdrop");
    return all.length === 0 || all[all.length - 1] === backdrop;
  }
  function onKey(e) {
    // Modals stack (the folder browser opens over Import), so Escape must
    // only dismiss the one on top.
    if (e.key === "Escape" && isTopmost()) { e.preventDefault(); close(); }
  }
  backdrop.addEventListener("click", function (e) { if (e.target === backdrop) close(); });
  document.addEventListener("keydown", onKey);
  document.body.appendChild(backdrop);
  // preventScroll is belt and braces now that the action row sits outside
  // the scrolling body - it used to be load-bearing, when focusing it would
  // scroll a tall dialog (Settings) straight past its own first section.
  (confirm || cancel).focus({ preventScroll: true });
  return { close: close };
}

/**
 * A "?" that shows and hides a paragraph of help, so a dialog can explain
 * itself without a wall of prose above every control. Returns both pieces
 * rather than placing them: the button belongs beside a label or heading,
 * the text belongs below whatever it explains, and only the caller knows
 * where those are.
 *
 * Collapsed by default - the help is for the first time you meet a setting,
 * not every time.
 */
export function helpToggle(text) {
  var hint = document.createElement("p");
  hint.className = "hint hidden";
  hint.textContent = text;

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "help-toggle";
  btn.textContent = "?";
  btn.title = "What is this?";
  btn.setAttribute("aria-expanded", "false");
  btn.addEventListener("click", function () {
    var open = !hint.classList.toggle("hidden");
    btn.setAttribute("aria-expanded", String(open));
    btn.classList.toggle("on", open);
  });

  return { button: btn, hint: hint };
}

export function selectField(host, labelText, options, value, helpText) {
  var field = document.createElement("div");
  field.className = "field";
  var label = document.createElement("label");
  label.textContent = labelText;
  field.appendChild(label);
  // Inside the field, not after it, so the field's own bottom margin still
  // separates it from the next one whether the help is open or shut.
  var helpHint = null;
  if (helpText) {
    var h = helpToggle(helpText);
    label.appendChild(h.button);
    helpHint = h.hint;
  }
  var sel = document.createElement("select");
  options.forEach(function (o) {
    var opt = document.createElement("option");
    opt.value = o.value;
    opt.textContent = o.label;
    if (o.value === value) opt.selected = true;
    sel.appendChild(opt);
  });
  field.appendChild(sel);
  if (helpHint) field.appendChild(helpHint);
  host.appendChild(field);
  return sel;
}

/* ---- Reusable checkbox list for the command modals ---- */
export function pickList(host, items) {
  var bar = document.createElement("div");
  bar.className = "pickbar";
  var count = document.createElement("span");
  bar.appendChild(count);
  var spacer = document.createElement("span");
  spacer.className = "spacer";
  bar.appendChild(spacer);
  bar.appendChild(button("All", "", function () { setAll(true); }));
  bar.appendChild(button("None", "", function () { setAll(false); }));
  host.appendChild(bar);

  var box = document.createElement("div");
  box.className = "picklist";
  var boxes = [];

  items.forEach(function (item) {
    var row = document.createElement("label");
    row.className = "pick";
    var cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.checked !== false;
    cb.value = item.value;
    cb.addEventListener("change", update);
    row.appendChild(cb);

    var main = document.createElement("div");
    main.className = "pk-main";
    var name = document.createElement("div");
    name.className = "pk-name";
    name.textContent = item.name;
    main.appendChild(name);
    if (item.sub) {
      var sub = document.createElement("div");
      sub.className = "pk-sub";
      sub.textContent = item.sub;
      main.appendChild(sub);
    }
    row.appendChild(main);

    if (item.right) {
      var right = document.createElement("span");
      right.className = "pk-right";
      right.textContent = item.right;
      row.appendChild(right);
    }
    if (item.extra) row.appendChild(item.extra);

    box.appendChild(row);
    boxes.push(cb);
  });

  host.appendChild(box);

  function setAll(on) {
    boxes.forEach(function (b) { b.checked = on; });
    update();
  }
  function update() {
    count.textContent = selected().length + " of " + boxes.length + " selected";
  }
  function selected() {
    return boxes.filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
  }
  update();
  return { selected: selected, boxes: boxes };
}

export function checkbox(host, labelText, checked) {
  var wrap = document.createElement("label");
  wrap.className = "check";
  var cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!checked;
  wrap.appendChild(cb);
  wrap.appendChild(document.createTextNode(labelText));
  host.appendChild(wrap);
  return cb;
}
