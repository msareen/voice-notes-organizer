/**
 * llama.cpp (optional summarization engine) is installed via `brew`/`winget`
 * - see lib/llama/llamacpp.ts - so it has no binary release URL of its own
 * here. Unlike whisper.cpp's fixed model set, summarization models are a
 * curated pick list of small "edge" instruct models people can actually run
 * on a laptop, each in its own Hugging Face repo - `vno setup --llama`
 * offers these instead of just pointing at an empty folder and hoping the
 * user knows what a GGUF is.
 */
import type { ModelSource, LlamaModelSource } from "./interfaces.ts";

const LLAMA_MODEL_CATALOG: LlamaModelSource[] = [
  {
    alias: "qwen3.5-0.8b",
    label: "Qwen 3.5 0.8B",
    group: "Tier 1 — sub-1GB",
    repo: "unsloth/Qwen3.5-0.8B-GGUF",
    filename: "Qwen3.5-0.8B-Q4_K_M.gguf",
    approxBytes: 533_000_000,
    sha256: "bd258782e35f7f458f8aced1adc053e6e92e89bc735ba3be89d38a06121dc517",
  },
  {
    alias: "lfm2.5-1.2b",
    label: "LFM 2.5 1.2B Instruct",
    group: "Tier 1 — sub-1GB",
    repo: "LiquidAI/LFM2.5-1.2B-Instruct-GGUF",
    filename: "LFM2.5-1.2B-Instruct-Q4_K_M.gguf",
    approxBytes: 731_000_000,
    sha256: "b1b3de114215d9507409a662a501a631095a479a419584e8a2ded6304b19b4f5",
  },
  {
    alias: "llama-3.2-1b",
    label: "Llama 3.2 1B Instruct",
    group: "Tier 1 — sub-1GB",
    repo: "bartowski/Llama-3.2-1B-Instruct-GGUF",
    filename: "Llama-3.2-1B-Instruct-Q4_K_M.gguf",
    approxBytes: 808_000_000,
    sha256: "6f85a640a97cf2bf5b8e764087b1e83da0fdb51d7c9fab7d0fece9385611df83",
  },

  {
    alias: "qwen3.5-2b",
    label: "Qwen 3.5 2B",
    group: "Tier 2 — 1-2GB",
    repo: "unsloth/Qwen3.5-2B-GGUF",
    filename: "Qwen3.5-2B-Q4_K_M.gguf",
    approxBytes: 1_280_000_000,
    sha256: "aaf42c8b7c3cab2bf3d69c355048d4a0ee9973d48f16c731c0520ee914699223",
  },
  {
    alias: "lfm2.5-2.6b",
    label: "LFM 2.5 2.6B",
    group: "Tier 2 — 1-2GB",
    repo: "bartowski/LiquidAI_LFM2.5-2.6B-GGUF",
    filename: "LiquidAI_LFM2.5-2.6B-Q4_K_M.gguf",
    approxBytes: 1_680_000_000,
    sha256: "03ab6106f4636ae7f316245d2adf7394ccf3cd80a684ec0c473b1a4720f3108e",
  },
  {
    alias: "smollm3-3b",
    label: "Smol LM3 3B",
    group: "Tier 2 — 1-2GB",
    repo: "unsloth/SmolLM3-3B-GGUF",
    filename: "SmolLM3-3B-Q4_K_M.gguf",
    approxBytes: 1_920_000_000,
    sha256: "4de907d2d388a5508fb7cb443a06effe14cce3518b0a78d3bdd9e74d9edce989",
  },
  {
    alias: "llama-3.2-3b",
    label: "Llama 3.2 3B Instruct",
    group: "Tier 2 — 1-2GB",
    repo: "bartowski/Llama-3.2-3B-Instruct-GGUF",
    filename: "Llama-3.2-3B-Instruct-Q4_K_M.gguf",
    approxBytes: 2_020_000_000,
    sha256: "6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff",
  },

  {
    alias: "phi-4-mini",
    label: "Phi-4 Mini Instruct",
    group: "Tier 3 — 2-4GB",
    repo: "unsloth/Phi-4-mini-instruct-GGUF",
    filename: "Phi-4-mini-instruct-Q4_K_M.gguf",
    approxBytes: 2_490_000_000, // unverified, ±10%
    sha256: "88c00229914083cd112853aab84ed51b87bdf6b9ce42f532d8c85c7c63b1730a",
  },
  {
    alias: "qwen3.5-4b",
    label: "Qwen3.5 4B",
    group: "Tier 3 — 2-4GB",
    repo: "unsloth/Qwen3.5-4B-GGUF",
    filename: "Qwen3.5-4B-Q4_K_M.gguf",
    approxBytes: 2_740_000_000,
    sha256: "00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4",
  },
  {
    alias: "gemma-4-e2b",
    label: "Gemma 4 E2B Instruct",
    group: "Tier 3 — 2-4GB",
    repo: "unsloth/gemma-4-E2B-it-GGUF",
    filename: "gemma-4-E2B-it-Q4_K_M.gguf",
    approxBytes: 3_110_000_000,
    sha256: "740185b21d22ceb83a11c3aa62ad5842ef32c70f6096d756bbee85a1e4ec34b8",
  },

  {
    alias: "gemma-4-e4b",
    label: "Gemma 4 E4B Instruct",
    group: "Tier 4 — 4-6GB",
    repo: "unsloth/gemma-4-E4B-it-GGUF",
    filename: "gemma-4-E4B-it-Q4_K_M.gguf",
    approxBytes: 4_980_000_000,
    sha256: "85a896a047553e842f25297ee5b031d64ff30147d9c4af17b1e4b394cd1fab87",
  },
  {
    alias: "qwen3.5-9b",
    label: "Qwen3.5 9B",
    group: "Tier 4 — 4-6GB",
    repo: "unsloth/Qwen3.5-9B-GGUF",
    filename: "Qwen3.5-9B-Q4_K_M.gguf",
    approxBytes: 5_680_000_000,
    sha256: "03b74727a860a56338e042c4420bb3f04b2fec5734175f4cb9fa853daf52b7e8",
  },
];

export function llamaModelCatalog(): LlamaModelSource[] {
  return LLAMA_MODEL_CATALOG;
}

// Same hf-mirror.com fallback story as the whisper models - identical path
// layout, useful wherever huggingface.co itself is blocked or throttled.
export function llamaModelSources(repo: string): ModelSource[] {
  const override = process.env.VNO_MODEL_BASE?.trim();
  if (override) return [{ label: override, base: override.replace(/\/+$/, "") }];
  return [
    { label: "Hugging Face", base: `https://huggingface.co/${repo}/resolve/main` },
    { label: "hf-mirror.com", base: `https://hf-mirror.com/${repo}/resolve/main` },
  ];
}
