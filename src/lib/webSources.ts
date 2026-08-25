/**
 * Every static internet location vno's dependency-acquisition code pulls
 * from - the whisper.cpp binary (GitHub Releases) and its models (Hugging
 * Face). Kept in one file so a mirror change, a moved repo, or a new
 * fallback host has exactly one place to look.
 */

export const WHISPERCPP_VERSION = "v1.9.2";
export const WHISPERCPP_REPO = "ggml-org/whisper.cpp";

const GITHUB_BASE = "https://github.com";
const GITHUB_API_BASE = "https://api.github.com";

export const HOMEBREW_URL = "https://brew.sh";

/** Human-facing link to the release page, e.g. for error messages. */
export function whispercppReleaseTagUrl(version: string = WHISPERCPP_VERSION): string {
  return `${GITHUB_BASE}/${WHISPERCPP_REPO}/releases/tag/${version}`;
}

/** GitHub API endpoint listing a release's downloadable assets. */
export function whispercppReleaseApiUrl(version: string = WHISPERCPP_VERSION): string {
  return `${GITHUB_API_BASE}/repos/${WHISPERCPP_REPO}/releases/tags/${version}`;
}

/** Direct download URL for one named asset in a release. */
export function whispercppReleaseAssetUrl(assetName: string, version: string = WHISPERCPP_VERSION): string {
  return `${GITHUB_BASE}/${WHISPERCPP_REPO}/releases/download/${version}/${assetName}`;
}

/** Clone URL for a source build (no prebuilt Linux CUDA asset exists). */
export function whispercppCloneUrl(): string {
  return `${GITHUB_BASE}/${WHISPERCPP_REPO}`;
}

// Where ggml models come from, tried in order. Hugging Face is the canonical
// home - whisper.cpp's own download-ggml-model.sh hardcodes it, and the old
// ggml.ggerganov.com mirror it used to fall back to is gone (404s now), so
// there is no official second source to point at. hf-mirror.com is a
// community mirror with an identical path layout, which is what makes it a
// usable fallback for networks where huggingface.co is blocked or throttled
// rather than a different artifact entirely.
//
// Note the org mismatch is deliberate: the code moved to the ggml-org GitHub
// org, but the *models* still live under `ggerganov` on Hugging Face
// (huggingface.co/ggml-org/whisper.cpp 401s). Don't "fix" this to match
// WHISPERCPP_REPO above.
export interface ModelSource {
  label: string;
  base: string;
}

const HUGGINGFACE_BASE = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main";
const HF_MIRROR_BASE = "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main";

const MODEL_SOURCES: ModelSource[] = [
  { label: "Hugging Face", base: HUGGINGFACE_BASE },
  { label: "hf-mirror.com", base: HF_MIRROR_BASE },
];

/**
 * `VNO_MODEL_BASE` overrides the list entirely with a single base URL, for an
 * internal mirror or an air-gapped copy. It's an env var rather than a config
 * key because the people who need it are usually setting it machine-wide for
 * every tool, not just this one.
 */
export function modelSources(): ModelSource[] {
  const override = process.env.VNO_MODEL_BASE?.trim();
  if (override) return [{ label: override, base: override.replace(/\/+$/, "") }];
  return MODEL_SOURCES;
}
