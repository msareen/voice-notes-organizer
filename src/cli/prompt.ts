import inquirer from "inquirer";
import type { Answers, QuestionCollection } from "inquirer";

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
 * The `readline` keypress event's second argument. Node types this loosely, and
 * only the modifier flags and `name` matter here.
 */
interface KeypressEvent {
  name?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}

/**
 * inquirer.prompt with Esc-to-cancel. Resolves to the answers object normally,
 * or to the CANCELLED sentinel if the user presses Esc. Inquirer's own prompts
 * ignore Esc, so we watch stdin's keypress stream ourselves and tear the active
 * prompt down cleanly (its close() removes listeners and closes the readline).
 */
export function prompt<T extends Answers = Answers>(
  questions: QuestionCollection<T>
): Promise<T | typeof CANCELLED> {
  const run = inquirer.prompt(questions);
  // `ui` isn't in inquirer's published types, but it's what exposes the
  // close() that tears an in-flight prompt down without leaking listeners.
  const ui = (run as unknown as { ui: { close(): void } }).ui;
  const input = process.stdin;

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      if (input.isTTY) input.removeListener("keypress", onKeypress);
      act();
    };

    const onKeypress = (_chunk: string, key: KeypressEvent | undefined) => {
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
      (answers) => finish(() => resolve(answers as T)),
      (err) => finish(() => reject(err))
    );
  });
}

/** Like `prompt`, but throws PromptCancelled on Esc instead of returning a sentinel. */
export async function promptStrict<T extends Answers = Answers>(
  questions: QuestionCollection<T>
): Promise<T> {
  const answer = await prompt<T>(questions);
  if (answer === CANCELLED) throw new PromptCancelled();
  return answer;
}
