/**
 * The UI's colour themes. Ids and labels only - every palette itself lives
 * in web/assets/app.css as a `[data-theme="<id>"]` block, so there's one
 * source of truth for the colours and the settings dialog can preview a
 * theme by putting its id on a swatch element rather than repeating hex
 * values in JS. "auto" has no palette of its own: it follows the OS's
 * prefers-color-scheme.
 *
 * Lives in lib/ rather than web/ because `vno setting` offers the same list
 * in the terminal, and lib/ is what the CLI and the browser paths share.
 */
export const THEMES = [
  { id: "auto", label: "Auto", blurb: "Follow the system's light/dark setting" },
  { id: "tape", label: "Tape", blurb: "Warm dark, amber accent" },
  { id: "dusk", label: "Dusk", blurb: "Cool indigo, periwinkle accent" },
  { id: "moss", label: "Moss", blurb: "Deep green, lime accent" },
  { id: "daylight", label: "Daylight", blurb: "Light paper, rust accent" },
  { id: "contrast", label: "Contrast", blurb: "Maximum contrast, heavier hairlines" },
];

export const THEME_IDS = THEMES.map((t) => t.id);
export const DEFAULT_THEME = "tape";

/** The configured theme id, falling back to the default for anything unknown. */
export function themeOf(config) {
  return THEME_IDS.includes(config?.theme) ? config.theme : DEFAULT_THEME;
}
