export const LOCAL_USER_EMAIL = "local@localhost.com";

export const DEFAULT_MODELS_BY_PROVIDER = {
  gemini: [
    "gemini-3.1-flash-lite-preview",
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3-pro-preview",
    "gemini-2.5-flash-lite-preview-09-2025",
    "gemini-2.5-flash-preview-09-2025",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro-preview",
    "gemini-2.5-pro-preview-05-06",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "gemini-2.0-flash-001",
    "gemini-2.0-flash-lite-001",
    "gemini-2.0-flash",
    "gemini-2.0-flash-lite",
    "gemma-4-31b-it",
    "gemma-4-26b-a4b-it"
  ],
  puter: [
    // Popular models from Puter's multi-vendor catalog (https://api.puter.com/puterai/chat/models/details).
    // These are the bare `id` field values — not OpenRouter-style slugs. Puter
    // resolves them to the best available upstream vendor at request time.
    // Anthropic Claude family
    "claude-sonnet-5",
    "claude-opus-4-7",
    "claude-opus-4-5",
    "claude-haiku-4-5",
    // OpenAI family (served via Azure / OpenAI-completion / OpenAI-responses)
    "gpt-5",
    "gpt-5-mini",
    "gpt-5-nano",
    "gpt-5.1",
    "gpt-5.2",
    "gpt-5.4",
    "gpt-4.1",
    "gpt-4.1-mini",
    "gpt-4o",
    "gpt-4o-mini",
    "o1",
    "o3",
    "o3-mini",
    "o4-mini",
    // Google Gemini family
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.0-flash",
    "gemini-3-flash-preview",
    "gemini-3.1-pro-preview",
    // xAI Grok family
    "grok-4-1-fast",
    "grok-4-1-fast-reasoning",
    "grok-4-fast-non-reasoning",
    "grok-4-20-reasoning",
    "grok-code-fast-1",
    // Alibaba Qwen family
    "qwen3-max",
    "qwen3-coder-plus",
    "qwen3-vl-plus",
    "qwen3-235b-a22b",
    // Mistral family
    "mistral-large-2512",
    "codestral-2508",
    "devstral-2512",
    "magistral-medium-2509",
    // DeepSeek
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    // Z.AI GLM family
    "glm-5",
    "glm-4.6",
    // Moonshot Kimi
    "kimi-k2.5",
    "kimi-k2.6",
    // Other vendors (NVIDIA Nemotron, Llama, etc.)
    "minimax-m2.7",
    "minimax-m3"
  ],
  ollama: [
    "llama3.2",
    "qwen2.5-coder",
    "mistral",
    "phi4",
    "deepseek-r1"
  ],
  nvidia: [
    "deepseek-ai/deepseek-v4-flash",
    "deepseek-ai/deepseek-v4-pro",
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "nvidia/nemotron-4-340b-instruct",
    "nvidia/nemotron-3-super-120b-a12b",
    "nvidia/usdcode",
    "nvidia/nemotron-mini-4b-instruct",
    "nvidia/llama-3.3-nemotron-super-49b-v1",
    "nvidia/llama-3.3-nemotron-super-49b-v1.5",
    "nvidia/llama-3.1-nemotron-nano-vl-8b-v1",
    "nvidia/llama-3.1-nemotron-nano-8b-v1",
    "nvidia/ising-calibration-1-35b-a3b",
    "nvidia/nvidia-nemotron-nano-9b-v2",
    "meta/llama-3.1-405b-instruct",
    "meta/llama-3.1-70b-instruct",
    "meta/llama-3.1-8b-instruct",
    "meta/llama-3.3-70b-instruct",
    "meta/llama-3.2-3b-instruct",
    "meta/llama-3.2-11b-vision-instruct",
    "meta/llama-3.2-90b-vision-instruct",
    "meta/llama-3.2-1b-instruct",
    "meta/llama-4-maverick-17b-128e-instruct",
    "mistralai/mistral-large-2-instruct",
    "mistralai/mistral-7b-instruct-v0.3",
    "mistralai/mixtral-8x7b-instruct-v0.1",
    "mistralai/mixtral-8x22b-instruct-v0.1",
    "mistralai/mistral-nemotron",
    "mistralai/mistral-medium-3-instruct",
    "mistralai/magistral-small-2506",
    "mistralai/mistral-small-4-119b-2603",
    "google/gemma-2-27b-it",
    "google/gemma-2-9b-it",
    "google/gemma-2-2b-it",
    "google/gemma-3n-e4b-it",
    "google/gemma-3n-e2b-it",
    "google/gemma-4-31b-it",
    "microsoft/phi-3-medium-128k-instruct",
    "microsoft/phi-4-mini-instruct",
    "microsoft/phi-4-multimodal-instruct",
    "qwen/qwen2.5-72b-instruct",
    "qwen/qwen2.5-coder-32b-instruct",
    "qwen/qwen3-coder-480b-a35b-instruct",
    "qwen/qwen3-next-80b-a3b-instruct",
    "qwen/qwen3-next-80b-a3b-thinking",
    "qwen/qwen3.5-122b-a10b",
    "moonshotai/kimi-k2-instruct",
    "moonshotai/kimi-k2-instruct-0905",
    "abacusai/dracarys-llama-3.1-70b-instruct",
    "stockmark/stockmark-2-100b-instruct",
    "z-ai/glm-5.1",
    "z-ai/glm-4.7",
    "bytedance/seed-oss-36b-instruct",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "sarvamai/sarvam-m",
    "minimaxai/minimax-m3",
    "minimaxai/minimax-m2.7",
    "minimaxai/minimax-m2.5"
  ],
  groq: [
    "llama-3.3-70b-versatile",
    "llama-3.1-8b-instant",
    "openai/gpt-oss-20b",
    "openai/gpt-oss-120b",
    "moonshotai/kimi-k2-instruct-0905"
  ],
  huggingface: [
    "Qwen/Qwen2.5-Coder-32B-Instruct",
    "meta-llama/Llama-3.3-70B-Instruct",
    "mistralai/Mistral-7B-Instruct-v0.3",
    "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B",
    "google/gemma-3-27b-it"
  ],
  minimax: [
    "MiniMax-M3",
    "MiniMax-M2.7",
    "MiniMax-M2.7-highspeed",
    "MiniMax-M2.5",
    "MiniMax-M2.5-highspeed",
    "MiniMax-M2.1",
    "MiniMax-M2.1-highspeed",
    "MiniMax-M2"
  ],
  openrouter: [
    // Curated starter set across major providers. Users should hit
    // "Refresh" in the Settings UI to pull the full live catalog from
    // https://openrouter.ai/api/v1/models (OpenRouter follows the
    // OpenAI-compatible { data: [{ id }] } shape, which our parser
    // already handles).
    "anthropic/claude-sonnet-5",
    "anthropic/claude-opus-4.8",
    "openai/gpt-5.5",
    "openai/gpt-5.5-pro",
    "openai/gpt-5.4",
    "google/gemini-3.1-pro-preview",
    "google/gemini-3.1-flash-lite-preview",
    "google/gemini-3-pro-preview",
    "minimax/minimax-m3",
    "minimax/minimax-m2.7",
    "minimax/minimax-m2.5",
    "x-ai/grok-4.20",
    "deepseek/deepseek-v4-pro",
    "deepseek/deepseek-v4-flash",
    "qwen/qwen3.7-plus",
    "qwen/qwen3.7-max",
    "meta-llama/llama-4-maverick",
    "mistralai/mistral-large-2512",
    "mistralai/mistral-medium-3.5",
    "z-ai/glm-5.2",
    "z-ai/glm-5.1"
  ]
} as const;

export const DEFAULT_BASE_URL_BY_PROVIDER = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  puter: "https://api.puter.com/puterai/openai/v1/",
  ollama: "https://ollama.com/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  groq: "https://api.groq.com/openai/v1",
  huggingface: "https://router.huggingface.co/v1",
  minimax: "https://api.minimax.io/v1",
  openrouter: "https://openrouter.ai/api/v1"
} as const;

export function getDefaultModels(provider: string): string[] {
  return [...(DEFAULT_MODELS_BY_PROVIDER[provider as keyof typeof DEFAULT_MODELS_BY_PROVIDER] ?? DEFAULT_MODELS_BY_PROVIDER.gemini)];
}

export function getDefaultBaseUrl(provider: string): string {
  return DEFAULT_BASE_URL_BY_PROVIDER[provider as keyof typeof DEFAULT_BASE_URL_BY_PROVIDER] ?? DEFAULT_BASE_URL_BY_PROVIDER.gemini;
}
