/**
 * Type shims for the two inquirer internals `searchableCheckbox.ts` extends.
 *
 * inquirer v9 publishes no types of its own (the `@types/inquirer` package
 * covers the public API only), and these deep paths are explicitly internal -
 * there is nothing upstream to import. The searchable picker subclasses the
 * stock checkbox prompt precisely to inherit its rendering, pagination and
 * checked-state handling, so the base has to be a real class here rather than
 * `any`, or `extends` wouldn't typecheck at all.
 *
 * The index signature is what lets the subclass reach the base's own fields
 * (`opt`, `rl`, `pointer`, `screen`, `paginator`, ...) without restating an
 * internal API that upstream is free to change.
 */

declare module "inquirer/lib/prompts/checkbox.js" {
  export default class CheckboxPrompt {
    constructor(question: unknown, readline: unknown, answers: unknown);
    [key: string]: any;
  }
}

declare module "inquirer/lib/utils/events.js" {
  import type { Observable } from "rxjs";

  /** Turns a readline interface into the keypress/line streams inquirer drives prompts from. */
  export default function observe(rl: unknown): {
    line: Observable<any>;
    keypress: Observable<{ value?: string; key?: Record<string, any> }>;
    [key: string]: any;
  };
}
