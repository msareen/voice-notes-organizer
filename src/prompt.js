import inquirer from "inquirer";

/** Resolved by `prompt` when the user pressed Esc to back out of a menu. */
export const CANCELLED = Symbol("prompt.cancelled");

/** Thrown by `promptStrict` on Esc, so callers can bail out of a whole flow. */
export class PromptCancelled extends Error {
  constructor() {
    super("Prompt cancelled");
    this.name = "PromptCancelled";
  }
}

/**
 * inquirer.prompt with Esc-to-cancel. Resolves to the answers object normally,
 * or to the CANCELLED sentinel if the user presses Esc. Inquirer's own prompts
 * ignore Esc, so we watch stdin's keypress stream ourselves and tear the active
 * prompt down cleanly (its close() removes listeners and closes the readline).
 */
export function prompt(questions) {
  const run = inquirer.prompt(questions);
  const ui = run.ui;
  const input = process.stdin;

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (act) => {
      if (settled) return;
      settled = true;
      if (input.isTTY) input.removeListener("keypress", onKeypress);
      act();
    };

    const onKeypress = (_chunk, key) => {
      if (key && key.name === "escape" && !key.ctrl && !key.meta && !key.shift) {
        finish(() => resolve(CANCELLED));
        try {
          ui.close();
        } catch {
          // already closing - nothing to do
        }
      }
    };

    if (input.isTTY) input.on("keypress", onKeypress);

    run.then(
      (answers) => finish(() => resolve(answers)),
      (err) => finish(() => reject(err))
    );
  });
}

/** Like `prompt`, but throws PromptCancelled on Esc instead of returning a sentinel. */
export async function promptStrict(questions) {
  const answer = await prompt(questions);
  if (answer === CANCELLED) throw new PromptCancelled();
  return answer;
}
