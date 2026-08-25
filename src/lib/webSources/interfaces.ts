/**
 * Shared shapes for the two model catalogs (whisperModels.ts, llamaModels.ts)
 * and the mirror-list type both engines' `*ModelSources()` functions return.
 * Kept separate from the data itself so either catalog file can be read
 * without wading through the other's entries.
 */

// Where a model's bytes come from, tried in order - a Hugging Face repo plus
// its hf-mirror.com fallback, or a single `VNO_MODEL_BASE` override. Shared
// by whisperModels.ts:modelSources and llamaModels.ts:llamaModelSources.
export interface ModelSource {
  label: string;
  base: string;
}

/**
 * One whisper.cpp ggml model. `ggml-<stem>.bin` is the filename on
 * whisper.cpp's Hugging Face repo, and what vno-install.json's `models` map
 * keys on.
 */
export interface WhisperModelSource {
  stem: string;
  /** Other names this project accepts for the same stem, e.g. "turbo" -> "large-v3-turbo" - see whispercpp.ts:normalizeModelName. */
  aliases?: string[];
  /** Sanity-check only, ~10% tolerance - see whispercpp.ts:validateModelFile. */
  approxBytes: number;
  /**
   * SHA-256 of the file, read from the repo's git-LFS pointer
   * (huggingface.co/ggerganov/whisper.cpp/raw/main/ggml-<stem>.bin) at the
   * time this entry was added. Checked once, right after download - see
   * whispercpp.ts:downloadModel. Left unset for anything not yet verified;
   * downloadModel skips the check entirely rather than treating "unset" as a
   * failure.
   */
  sha256?: string;
}

/**
 * One curated llama.cpp summarization model - unlike whisper.cpp's fixed
 * model set, these are entirely optional and each lives in its own Hugging
 * Face repo.
 */
export interface LlamaModelSource {
  /** What `vno setup --summary-model <alias>` and the setup wizard's picker use. */
  alias: string;
  label: string;
  /** Size tier heading the setup wizard's picker groups entries under, and shows again while downloading. */
  group: string;
  /** The Hugging Face repo holding the quantized file. */
  repo: string;
  filename: string;
  /** Sanity-check only, ~10% tolerance - see llamacpp.ts:validateModelFile. */
  approxBytes: number;
  /**
   * SHA-256 of the file, read from the repo's git-LFS pointer
   * (huggingface.co/<repo>/raw/main/<filename>) at the time this entry was
   * added. Checked once, right after download - see llamacpp.ts:downloadModel.
   * Left unset for anything not yet verified; downloadModel skips the check
   * entirely rather than treating "unset" as a failure.
   */
  sha256?: string;
}
