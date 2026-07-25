import inquirer from "inquirer";
import chalk from "chalk";
import { map, takeUntil } from "rxjs";
import CheckboxPrompt from "inquirer/lib/prompts/checkbox.js";
import observe from "inquirer/lib/utils/events.js";

const ANSI = /\[[0-9;]*m/g;

/**
 * A checkbox prompt you can filter by typing. Extends inquirer's classic
 * checkbox so it keeps the same rendering, pagination and checked-state
 * handling, but adds:
 *   - type any printable character to filter the list live (matches the
 *     visible row text, case-insensitively; Backspace edits the filter)
 *   - Up/Down move without wrapping (clear top/bottom)
 *   - Space toggles the highlighted row, Ctrl+A toggles all visible rows
 *   - Enter confirms the rows that are both checked AND currently visible
 *     (what you see is what you get)
 * Esc-to-cancel is handled by the surrounding `prompt()` wrapper.
 */
export default class SearchableCheckboxPrompt extends CheckboxPrompt {
  _run(cb) {
    this.done = cb;

    // The full, unfiltered collection. `this.opt.choices` becomes a filtered
    // *view* of it (see applyFilter); checked state lives on the shared Choice
    // objects, so it survives filtering.
    this.master = this.opt.choices;
    this.searchTerm = typeof this.opt.initialFilter === "string" ? this.opt.initialFilter : "";
    this.applyFilter();

    const events = observe(this.rl);

    const validation = this.handleSubmitEvents(
      events.line.pipe(map(this.getCurrentValue.bind(this)))
    );
    validation.success.forEach(this.onEnd.bind(this));
    validation.error.forEach(this.onError.bind(this));

    // One handler for every key: we route printable characters to the filter
    // instead of letting letters act as shortcuts, so typing always searches.
    events.keypress
      .pipe(takeUntil(validation.success))
      .forEach(this.onKeypress.bind(this));

    this.render();
    this.firstRender = false;
    return this;
  }

  /** Rebuilds `this.opt.choices` as a filtered view of the master collection. */
  applyFilter() {
    const q = this.searchTerm.trim().toLowerCase();
    const master = this.master;
    // Inherit the collection's methods/getters (getChoice, realLength, ...)
    // but swap in filtered backing arrays.
    const view = Object.create(master);
    view.choices = master.choices.filter((choice) => {
      if (choice.type === "separator" || choice.disabled) return false;
      if (!q) return true;
      const hay = String(choice.name).replace(ANSI, "").toLowerCase();
      return hay.includes(q);
    });
    view.realChoices = view.choices;
    this.opt.choices = view;

    const last = view.realChoices.length - 1;
    if (this.pointer > last) this.pointer = Math.max(0, last);
  }

  onKeypress({ value, key }) {
    key = key || {};
    if (key.name === "escape") return; // handled by the prompt() wrapper

    if (key.name === "up") {
      if (this.pointer > 0) this.pointer -= 1;
      this.render();
      return;
    }
    if (key.name === "down") {
      if (this.pointer < this.opt.choices.realChoices.length - 1) this.pointer += 1;
      this.render();
      return;
    }
    if (key.name === "space") {
      this.toggleChoice(this.pointer);
      this.render();
      return;
    }
    if (key.ctrl && key.name === "a") {
      const rows = this.opt.choices.realChoices;
      const shouldCheck = rows.some((c) => !c.checked);
      for (const c of rows) c.checked = shouldCheck;
      this.render();
      return;
    }
    if (key.name === "backspace") {
      if (this.searchTerm) {
        this.searchTerm = this.searchTerm.slice(0, -1);
        this.applyFilter();
        this.render();
      }
      return;
    }

    // Any other printable character filters.
    if (
      typeof value === "string" &&
      value.length >= 1 &&
      value.charCodeAt(0) >= 32 &&
      !key.ctrl &&
      !key.meta
    ) {
      this.searchTerm += value;
      this.pointer = 0;
      this.applyFilter();
      this.render();
    }
  }

  render(error) {
    let message = this.getQuestion();
    let bottomContent = "";

    if (this.status === "answered") {
      message += chalk.cyan(this.selection.join(", "));
      this.screen.render(message, bottomContent);
      return;
    }

    const total = this.master.realChoices.length;
    const shown = this.opt.choices.realChoices.length;
    const term = this.searchTerm;

    message +=
      chalk.dim(" — type to filter · ↑↓ move · space select · ^a all · enter go · esc quit");
    message +=
      "\n" +
      chalk.dim("filter: ") +
      (term ? chalk.white(term) : chalk.dim("(none)")) +
      chalk.dim(`   ${shown}/${total} shown`);

    if (shown === 0) {
      message += "\n  " + chalk.yellow(`No files match "${term}"`);
    } else {
      const choicesStr = renderChoices(this.opt.choices.realChoices, this.pointer);
      message += "\n" + this.paginator.paginate(choicesStr, this.pointer, this.opt.pageSize);
    }

    if (error) bottomContent = chalk.red(">> ") + error;
    this.screen.render(message, bottomContent);
  }
}

function renderChoices(rows, pointer) {
  let out = "";
  rows.forEach((choice, i) => {
    const box = choice.checked ? chalk.green("◉") : "◯";
    const line = box + " " + choice.name;
    out += (i === pointer ? chalk.cyan("❯ " + line) : "  " + line) + "\n";
  });
  return out.replace(/\n$/, "");
}

inquirer.registerPrompt("searchable-checkbox", SearchableCheckboxPrompt);
