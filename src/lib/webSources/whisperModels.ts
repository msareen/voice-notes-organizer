/**
 * Every static internet location whisper.cpp's install/model-download code
 * pulls from: the binary (GitHub Releases) and the ggml models (Hugging
 * Face). Kept in one file so a mirror change, a moved repo, or a new
 * fallback host has exactly one place to look.
 */
import type { ModelSource, WhisperModelSource } from "./interfaces.ts";

export const WHISPERCPP_VERSION = "v1.9.2";
export const WHISPERCPP_REPO = "ggml-org/whisper.cpp";

const GITHUB_BASE = "https://github.com";
const GITHUB_API_BASE = "https://api.github.com";

// Homebrew's own URL, not whisper.cpp-specific - llama.cpp's mac install
// (lib/llama/llamacpp.ts) points here too when `brew` itself is missing.
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

// The whisper.cpp models themselves - every ggml-*.bin whispercpp.ts knows
// how to fetch. `modelSources()` above supplies the base URL(s); this just
// says which files exist and what they should look like.
const WHISPER_MODEL_CATALOG: WhisperModelSource[] = [
  {
    stem: "tiny",
    approxBytes: 77_700_000,
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
  },
  {
    stem: "base",
    approxBytes: 148_000_000,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
  },
  {
    stem: "small",
    approxBytes: 488_000_000,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
  },
  {
    stem: "medium",
    approxBytes: 1_530_000_000,
    sha256: "6c14d5adee5f86394037b4e4e8b59f1673b6cee10e3cf0b11bbdbee79c156208",
  },
  {
    stem: "large-v3",
    aliases: ["large"],
    approxBytes: 3_100_000_000,
    sha256: "64d182b440b98d5203c4f9bd541544d84c605196c4f7b845dfa11fb23594d1e2",
  },
  {
    stem: "large-v3-turbo",
    aliases: ["turbo"],
    approxBytes: 1_620_000_000,
    sha256: "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69",
  },
];

export function whisperModelCatalog(): WhisperModelSource[] {
  return WHISPER_MODEL_CATALOG;
}

// The Silero VAD model whisper.cpp's `--vad` needs, used by the adaptive
// decode ladder (lib/whisper/decodeProfile.ts) to keep silence away from the
// decoder, which is where phantom text comes from.
//
// Note the different Hugging Face repo: the VAD models live under
// `ggml-org/whisper-vad`, not the `ggerganov/whisper.cpp` repo the transcription
// models come from, so this can't ride on `modelSources()` above. That's
// whisper.cpp's own split too - it ships models/download-vad-model.sh
// separately from download-ggml-model.sh for exactly this reason.
const WHISPER_VAD_BASE = "https://huggingface.co/ggml-org/whisper-vad/resolve/main";

/** Where the VAD model comes from, honouring the same VNO_MODEL_BASE override. */
export function vadModelSources(): ModelSource[] {
  const override = process.env.VNO_MODEL_BASE?.trim();
  if (override) return [{ label: override, base: override.replace(/\/+$/, "") }];
  return [{ label: "Hugging Face", base: WHISPER_VAD_BASE }];
}

/**
 * The VAD model vno installs. Under a megabyte, so `vno setup` just fetches
 * it rather than asking - unlike the transcription models, where the smallest
 * is 77MB and the largest 3.1GB.
 */
export const WHISPER_VAD_MODEL: WhisperModelSource = {
  stem: "silero-v5.1.2",
  approxBytes: 885_098,
  sha256: "29940d98d42b91fbd05ce489f3ecf7c72f0a42f027e4875919a28fb4c04ea2cf",
};

/** The stems `vno setup` fetches unless told otherwise - see whispercpp.ts:DEFAULT_MODELS. */
export const WHISPER_DEFAULT_MODELS = ["small", "turbo"];
