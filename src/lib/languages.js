/**
 * The languages whisper.cpp can transcribe, as ids and labels only.
 *
 * Lives in lib/ rather than web/ for the same reason themes.js does: both
 * `vno setting` and the browser's Settings dialog offer the same list, and
 * lib/ is what the CLI and the browser paths share. Before this existed the
 * list was written out three times - two of them (auto/hi/en) a subset the
 * other disagreed with, so the web route rejected codes the CLI accepted.
 *
 * The codes are whisper.cpp's own (`whisper_lang_str`), which are ISO-639-1
 * apart from `haw` and `yue`. Sorted by label, since that's the order every
 * menu wants; `LANGUAGE_CODES` preserves it.
 */
export const WHISPER_LANGUAGES = [
  { code: "af", label: "Afrikaans" },
  { code: "sq", label: "Albanian" },
  { code: "am", label: "Amharic" },
  { code: "ar", label: "Arabic" },
  { code: "hy", label: "Armenian" },
  { code: "as", label: "Assamese" },
  { code: "az", label: "Azerbaijani" },
  { code: "ba", label: "Bashkir" },
  { code: "eu", label: "Basque" },
  { code: "be", label: "Belarusian" },
  { code: "bn", label: "Bengali" },
  { code: "bs", label: "Bosnian" },
  { code: "br", label: "Breton" },
  { code: "bg", label: "Bulgarian" },
  { code: "yue", label: "Cantonese" },
  { code: "ca", label: "Catalan" },
  { code: "zh", label: "Chinese" },
  { code: "hr", label: "Croatian" },
  { code: "cs", label: "Czech" },
  { code: "da", label: "Danish" },
  { code: "nl", label: "Dutch" },
  { code: "en", label: "English" },
  { code: "et", label: "Estonian" },
  { code: "fo", label: "Faroese" },
  { code: "fi", label: "Finnish" },
  { code: "fr", label: "French" },
  { code: "gl", label: "Galician" },
  { code: "ka", label: "Georgian" },
  { code: "de", label: "German" },
  { code: "el", label: "Greek" },
  { code: "gu", label: "Gujarati" },
  { code: "ht", label: "Haitian Creole" },
  { code: "ha", label: "Hausa" },
  { code: "haw", label: "Hawaiian" },
  { code: "he", label: "Hebrew" },
  { code: "hi", label: "Hindi" },
  { code: "hu", label: "Hungarian" },
  { code: "is", label: "Icelandic" },
  { code: "id", label: "Indonesian" },
  { code: "it", label: "Italian" },
  { code: "ja", label: "Japanese" },
  { code: "jw", label: "Javanese" },
  { code: "kn", label: "Kannada" },
  { code: "kk", label: "Kazakh" },
  { code: "km", label: "Khmer" },
  { code: "ko", label: "Korean" },
  { code: "lo", label: "Lao" },
  { code: "la", label: "Latin" },
  { code: "lv", label: "Latvian" },
  { code: "ln", label: "Lingala" },
  { code: "lt", label: "Lithuanian" },
  { code: "lb", label: "Luxembourgish" },
  { code: "mk", label: "Macedonian" },
  { code: "mg", label: "Malagasy" },
  { code: "ms", label: "Malay" },
  { code: "ml", label: "Malayalam" },
  { code: "mt", label: "Maltese" },
  { code: "mi", label: "Maori" },
  { code: "mr", label: "Marathi" },
  { code: "mn", label: "Mongolian" },
  { code: "my", label: "Myanmar" },
  { code: "ne", label: "Nepali" },
  { code: "no", label: "Norwegian" },
  { code: "nn", label: "Nynorsk" },
  { code: "oc", label: "Occitan" },
  { code: "ps", label: "Pashto" },
  { code: "fa", label: "Persian" },
  { code: "pl", label: "Polish" },
  { code: "pt", label: "Portuguese" },
  { code: "pa", label: "Punjabi" },
  { code: "ro", label: "Romanian" },
  { code: "ru", label: "Russian" },
  { code: "sa", label: "Sanskrit" },
  { code: "sr", label: "Serbian" },
  { code: "sn", label: "Shona" },
  { code: "sd", label: "Sindhi" },
  { code: "si", label: "Sinhala" },
  { code: "sk", label: "Slovak" },
  { code: "sl", label: "Slovenian" },
  { code: "so", label: "Somali" },
  { code: "es", label: "Spanish" },
  { code: "su", label: "Sundanese" },
  { code: "sw", label: "Swahili" },
  { code: "sv", label: "Swedish" },
  { code: "tl", label: "Tagalog" },
  { code: "tg", label: "Tajik" },
  { code: "ta", label: "Tamil" },
  { code: "tt", label: "Tatar" },
  { code: "te", label: "Telugu" },
  { code: "th", label: "Thai" },
  { code: "bo", label: "Tibetan" },
  { code: "tr", label: "Turkish" },
  { code: "tk", label: "Turkmen" },
  { code: "uk", label: "Ukrainian" },
  { code: "ur", label: "Urdu" },
  { code: "uz", label: "Uzbek" },
  { code: "vi", label: "Vietnamese" },
  { code: "cy", label: "Welsh" },
  { code: "yi", label: "Yiddish" },
  { code: "yo", label: "Yoruba" },
];

export const LANGUAGE_CODES = WHISPER_LANGUAGES.map((l) => l.code);

/** Display name for a code, falling back to the code itself. */
export function languageLabel(code) {
  if (code === "auto") return "Auto-detect";
  const found = WHISPER_LANGUAGES.find((l) => l.code === code);
  return found ? found.label : code;
}

/** Whether a value is a pinnable language: a real code, or "auto". */
export function isLanguageChoice(value) {
  return value === "auto" || LANGUAGE_CODES.includes(value);
}

/**
 * Cleans a cross-language override map into something safe to act on.
 *
 * The single validator for both `loadConfig` and the settings route, so a
 * hand-edited config and a POSTed one can't disagree about what's valid.
 * Unknown codes are dropped rather than rejected - a map is a convenience,
 * and refusing to load a config over one bad pair would be out of proportion.
 *
 * "auto" is dropped on either side (it isn't a detection *result*, and
 * rewriting something to "auto" would just re-enter detection), and so are
 * identity pairs, which would be a no-op the UI shouldn't show as a rule.
 */
export function normalizeLanguageMap(raw) {
  const map = {};
  if (!raw || typeof raw !== "object") return map;
  for (const [from, to] of Object.entries(raw)) {
    const key = String(from || "").trim().toLowerCase();
    const value = String(to || "").trim().toLowerCase();
    if (!LANGUAGE_CODES.includes(key) || !LANGUAGE_CODES.includes(value)) continue;
    if (key === value) continue;
    map[key] = value;
  }
  return map;
}
