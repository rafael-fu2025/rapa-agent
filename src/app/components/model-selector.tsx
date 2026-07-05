import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ChevronDown,
  Search as SearchIcon,
  Cpu,
  Check,
  Brain
} from "lucide-react";
import { cn } from "../../lib/utils";
import { motion, AnimatePresence } from "motion/react";
import { getSettings, getProviders, type ReasoningEffort } from "../../lib/api";
import { getProviderIcon } from "../../lib/provider-icons";

const REASONING_EFFORT_OPTIONS: { value: ReasoningEffort; label: string; description: string }[] = [
  { value: "off",    label: "Default", description: "Provider default" },
  { value: "low",    label: "Low",     description: "Light thinking, fastest + cheapest" },
  { value: "medium", label: "Medium",  description: "Balanced reasoning" },
  { value: "high",   label: "High",    description: "Deep thinking, better for complex tasks" },
  { value: "max",    label: "Max",     description: "Maximum effort (when supported)" }
];

/**
 * Hard-coded capability map mirroring
 * `server/src/lib/agent/reasoning-translator.ts`. Kept in sync
 * manually so the dropdown hides itself on non-reasoning
 * providers/models — the translator still gets called for any model
 * (it's a no-op for unsupported ones), but the UI should only show
 * the picker where it's meaningful.
 */
const REASONING_CAPABLE_PROVIDERS = new Set([
  "openai",
  "azure-openai",
  "deepseek",
  "nvidia",
  "anthropic",
  "claude",
  "gemini",
  "ollama",
  "openrouter",
  "puter",
  // MiniMax M3 supports `thinking: { type: "disabled" | "adaptive" }`.
  // Mirrors the backend's REASONING_CAPABLE_PROVIDERS in
  // server/src/lib/agent/reasoning-translator.ts.
  "minimax"
]);

const NON_REASONING_MODEL_PATTERNS: RegExp[] = [
  /^gpt-4o(?!-mini)/i,
  /^gpt-4(?!-turbo|-o|-5)/i,
  /^gemini-2\.0-/i,
  /^gemini-1\./i,
  /^claude-(?:3-(?:opus|sonnet|haiku)|3-5-sonnet)$/i,
  /^text-embedding-/i,
  /^claude-fable-/i,
  // MiniMax M2.x: API docs say thinking cannot be disabled — the
  // `thinking: { type: "disabled" }` field is accepted but ignored.
  // Hide the dropdown so we don't expose a setting that silently
  // does nothing.
  /^MiniMax-M2(?:\.\d+)?(?:-highspeed)?$/i
];

function isReasoningCapableModel(provider: string, model: string): boolean {
  if (!REASONING_CAPABLE_PROVIDERS.has(provider.toLowerCase())) return false;
  if (NON_REASONING_MODEL_PATTERNS.some((p) => p.test(model))) return false;
  return true;
}

// Replaced by `getProviderIcon` from src/lib/provider-icons.ts
// (single source of truth for provider logos).

type ModelItem = {
  id: string;
  name: string;
};

const DEFAULT_MODELS_BY_PROVIDER: Record<string, ModelItem[]> = {
  gemini: [
    { id: "gemini-3.1-flash-lite-preview", name: "gemini-3.1-flash-lite-preview" },
    { id: "gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview" },
    { id: "gemini-3-flash-preview", name: "gemini-3-flash-preview" },
    { id: "gemini-3-pro-preview", name: "gemini-3-pro-preview" },
    { id: "gemini-2.5-flash", name: "gemini-2.5-flash" },
    { id: "gemini-2.5-pro", name: "gemini-2.5-pro" },
    { id: "gemini-2.0-flash-001", name: "gemini-2.0-flash-001" },
    { id: "gemini-2.0-flash", name: "gemini-2.0-flash" },
    { id: "gemma-4-31b-it", name: "gemma-4-31b-it" },
    { id: "gemma-4-26b-a4b-it", name: "gemma-4-26b-a4b-it" },
  ],
  puter: [
    { id: "z-ai/glm-5v-turbo", name: "z-ai/glm-5v-turbo" },
    { id: "moonshotai/kimi-k2.6", name: "moonshotai/kimi-k2.6" },
    { id: "qwen/qwen3-coder:free", name: "qwen/qwen3-coder:free" },
    { id: "google/gemma-4-31b-it:free", name: "google/gemma-4-31b-it:free" },
    { id: "openrouter/elephant-alpha", name: "openrouter/elephant-alpha" },
  ],
  ollama: [
    { id: "llama3.2", name: "llama3.2" },
    { id: "qwen2.5-coder", name: "qwen2.5-coder" },
    { id: "mistral", name: "mistral" },
    { id: "phi4", name: "phi4" },
    { id: "deepseek-r1", name: "deepseek-r1" },
  ],
  nvidia: [
    { id: "deepseek-ai/deepseek-v4-flash", name: "deepseek-ai/deepseek-v4-flash" },
    { id: "deepseek-ai/deepseek-v4-pro", name: "deepseek-ai/deepseek-v4-pro" },
    { id: "nvidia/llama-3.1-nemotron-70b-instruct", name: "nvidia/llama-3.1-nemotron-70b-instruct" },
    { id: "meta/llama-3.1-405b-instruct", name: "meta/llama-3.1-405b-instruct" },
    { id: "meta/llama-3.1-70b-instruct", name: "meta/llama-3.1-70b-instruct" },
    // NVIDIA NIM hosts MiniMax models under the `minimaxai/` prefix (not
    // the native `MiniMax-M3` name used by the dedicated MiniMax provider).
    // Using the native name with the nvidia provider returns an empty
    // response because NVIDIA's catalog doesn't recognize it.
    { id: "minimaxai/minimax-m3", name: "MiniMax-M3 (NVIDIA NIM)" },
    { id: "minimaxai/minimax-m2.7", name: "MiniMax-M2.7 (NVIDIA NIM)" },
    { id: "minimaxai/minimax-m2.5", name: "MiniMax-M2.5 (NVIDIA NIM)" },
  ],
  groq: [
    { id: "llama-3.3-70b-versatile", name: "llama-3.3-70b-versatile" },
    { id: "llama-3.1-8b-instant", name: "llama-3.1-8b-instant" },
    { id: "openai/gpt-oss-20b", name: "openai/gpt-oss-20b" },
    { id: "openai/gpt-oss-120b", name: "openai/gpt-oss-120b" },
    { id: "moonshotai/kimi-k2-instruct-0905", name: "moonshotai/kimi-k2-instruct-0905" },
  ],
  minimax: [
    { id: "MiniMax-M3", name: "MiniMax-M3" },
    { id: "MiniMax-M2.7", name: "MiniMax-M2.7" },
    { id: "MiniMax-M2.7-highspeed", name: "MiniMax-M2.7-highspeed" },
    { id: "MiniMax-M2.5", name: "MiniMax-M2.5" },
    { id: "MiniMax-M2.5-highspeed", name: "MiniMax-M2.5-highspeed" },
    { id: "MiniMax-M2.1", name: "MiniMax-M2.1" },
    { id: "MiniMax-M2.1-highspeed", name: "MiniMax-M2.1-highspeed" },
    { id: "MiniMax-M2", name: "MiniMax-M2" },
  ],
  openrouter: [
    { id: "anthropic/claude-sonnet-5", name: "Anthropic: Claude Sonnet 5" },
    { id: "openai/gpt-5.5", name: "OpenAI: GPT-5.5" },
    { id: "google/gemini-3.1-pro-preview", name: "Google: Gemini 3.1 Pro Preview" },
    { id: "minimax/minimax-m3", name: "MiniMax: MiniMax M3" },
    { id: "minimax/minimax-m2.7", name: "MiniMax: MiniMax M2.7" },
    { id: "x-ai/grok-4.20", name: "xAI: Grok 4.20" },
    { id: "deepseek/deepseek-v4-pro", name: "DeepSeek: V4 Pro" },
    { id: "qwen/qwen3.7-plus", name: "Qwen: Qwen3.7 Plus" },
    { id: "z-ai/glm-5.2", name: "Z.ai: GLM 5.2" }
  ]
};

type KnownProvider = "gemini" | "puter" | "ollama" | "nvidia" | "groq" | "minimax" | "openrouter" | "huggingface";

function getProviderLogo(provider: string) {
  return getProviderIcon(provider);
}

function getProviderLabel(provider: string) {
  if (provider === "gemini") return "Gemini";
  if (provider === "puter") return "Puter";
  if (provider === "ollama") return "Ollama";
  if (provider === "nvidia") return "NVIDIA";
  if (provider === "groq") return "Groq";
  if (provider === "huggingface") return "Hugging Face";
  if (provider === "minimax") return "Minimax";
  if (provider === "openrouter") return "OpenRouter";
  return provider;
}

type ModelSelectorProps = {
  selectedProvider?: string;
  selectedModel?: string;
  onSelectProvider?: (provider: string) => void;
  onSelectModel?: (model: string) => void;
  /// Current reasoning / thinking-mode effort. When the selected
  /// model+provider combination supports reasoning, the dropdown
  /// shows a row with the current value; the user can change it
  /// inline.
  selectedReasoningEffort?: ReasoningEffort;
  onSelectReasoningEffort?: (effort: ReasoningEffort) => void;
};

export const ModelSelector = ({
  selectedProvider,
  selectedModel: selectedModelProp,
  onSelectProvider,
  onSelectModel,
  selectedReasoningEffort = "off",
  onSelectReasoningEffort
}: ModelSelectorProps) => {
  const [isOpen, setIsOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [provider, setInternalProvider] = useState("gemini");
  const [internalSelectedModel, setInternalSelectedModel] = useState("");
  const dropdownRef = useRef<HTMLDivElement>(null);
  const requestedProvidersRef = useRef<Set<string>>(new Set());

  const [modelsByProvider, setModelsByProvider] = useState<Record<string, ModelItem[]>>({});
  const [loadingProviderIds, setLoadingProviderIds] = useState<string[]>([]);
  const [providersList, setProvidersList] = useState<{ id: string; name: string }[]>(() =>
    (Object.keys(DEFAULT_MODELS_BY_PROVIDER) as KnownProvider[]).map((k) => ({
      id: k,
      name: getProviderLabel(k)
    }))
  );

  useEffect(() => {
    getProviders()
      .then((res) => {
        setProvidersList(res.providers.map(p => ({ id: p.provider, name: p.displayName || p.provider })));
      })
      .catch((err) => console.error("Failed to load providers:", err));
  }, []);

  const resolvedProvider = selectedProvider || provider;
  const selectedModel = selectedModelProp || internalSelectedModel;

  const loadModels = useCallback(async (prov: string, force = false) => {
    if (!force && requestedProvidersRef.current.has(prov)) {
      return;
    }

    requestedProvidersRef.current.add(prov);
    setLoadingProviderIds((current) => (current.includes(prov) ? current : [...current, prov]));
    try {
      const settings = await getSettings(prov);
      const models = settings.models ?? [];
      setModelsByProvider((current) => ({
        ...current,
        [prov]: models.map((id) => ({ id, name: id }))
      }));
    } catch {
      setModelsByProvider((current) => current[prov] ? current : { ...current, [prov]: [] });
    } finally {
      setLoadingProviderIds((current) => current.filter((id) => id !== prov));
    }
  }, []);

  useEffect(() => {
    setInternalProvider(resolvedProvider);
    loadModels(resolvedProvider);
  }, [resolvedProvider, loadModels]);

  useEffect(() => {
    providersList.forEach(({ id }) => {
      void loadModels(id);
    });
  }, [providersList, loadModels]);

  const defaultModels = useMemo(
    () => DEFAULT_MODELS_BY_PROVIDER[resolvedProvider] ?? [],
    [resolvedProvider]
  );
  const savedModels = modelsByProvider[resolvedProvider] ?? [];
  const modelsForProvider = savedModels.length > 0 ? savedModels : defaultModels;
  const isLoadingModels = loadingProviderIds.includes(resolvedProvider);

  const filteredModels = modelsForProvider.filter((model) => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return model.name.toLowerCase().includes(q) || model.id.toLowerCase().includes(q);
  });

  useEffect(() => {
    if (!selectedModel || modelsForProvider.length === 0) return;
    const hasSelected = modelsForProvider.some((model) => model.id === selectedModel);
    if (!hasSelected) {
      const fallback = defaultModels[0]?.id ?? "";
      if (fallback) {
        setInternalSelectedModel(fallback);
        onSelectModel?.(fallback);
      }
    }
  }, [modelsForProvider, onSelectModel, selectedModel, defaultModels]);

  useEffect(() => {
    const defaultModel = defaultModels[0]?.id ?? "";
    if (!internalSelectedModel && defaultModel) {
      setInternalSelectedModel(defaultModel);
      if (!selectedModelProp) {
        onSelectModel?.(defaultModel);
      }
    }
  }, [defaultModels, internalSelectedModel, onSelectModel, selectedModelProp]);

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const logo = getProviderLogo(resolvedProvider);

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-border/40 bg-card-3/50 hover:border-border transition-all"
      >
        <div className="flex items-center gap-1.5 max-w-[200px]">
          {logo ? <img src={logo} alt={resolvedProvider} className="w-3.5 h-3.5" /> : <Cpu size={13} className="text-muted-foreground" />}
          <span className="font-mono-tech text-[10px] font-medium truncate text-foreground">
            {selectedModel || getProviderLabel(resolvedProvider)}
          </span>
        </div>
        {/* Reasoning-effort badge. Shown only when the current
            provider+model supports reasoning AND the user has set
            something other than the default ("off"). Hovering shows
            the current level so the user can see at-a-glance what
            setting the next message will use. */}
        {selectedReasoningEffort !== "off"
          && isReasoningCapableModel(resolvedProvider, selectedModel) && (
          <span
            title={`Reasoning: ${selectedReasoningEffort}`}
            className="flex items-center gap-0.5 rounded border border-accent-purple/40 bg-accent-purple/10 px-1.5 py-0.5 font-mono-tech text-[8.5px] font-semibold uppercase tracking-[0.12em] text-accent-purple"
          >
            <Brain size={8} />
            {selectedReasoningEffort}
          </span>
        )}
        <ChevronDown
          size={12}
          className={cn(
            "text-muted-foreground/60 transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>

      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, y: -8, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -8, scale: 0.97 }}
            transition={{ duration: 0.15 }}
            className="absolute bottom-full left-0 mb-2 w-[320px] rounded border border-border/40 bg-card z-50 overflow-hidden"
          >
            <div className="border-b border-border/30 px-3 py-1.5">
              <div className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">select model</div>
            </div>
            
            <div className="px-3 py-1.5 border-b border-border/30">
              <div className="relative">
                <SearchIcon size={11} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/60" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search models..."
                  className="w-full rounded border border-border/40 bg-card-3/50 py-1.5 pl-7 pr-2.5 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus:border-ring transition-colors"
                />
              </div>
            </div>

            {/* Providers section - horizontal scroll */}
            <div className="px-3 py-1.5 border-b border-border/30">
              <h3 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70 mb-1">providers</h3>
              <div className="sidebar-scroll flex gap-1.5 overflow-x-auto pb-1">
                {providersList.map(({ id: provId, name: provLabel }) => {
                  const provLogo = getProviderLogo(provId);
                  const isActive = resolvedProvider === provId;

                  return (
                    <div
                      key={provId}
                      className={cn(
                        "group relative flex items-center justify-center p-1.5 rounded border transition-all cursor-pointer shrink-0",
                        isActive
                          ? "border-accent-orange/40 bg-accent-orange/10"
                          : "border-border/40 bg-card-3/50 hover:border-border hover:bg-card-3/60"
                      )}
                      onClick={() => {
                        if (provId === resolvedProvider) return;
                        setInternalProvider(provId);
                        onSelectProvider?.(provId);
                        setSearchQuery("");
                      }}
                      title={provLabel}
                    >
                      <div
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-transparent bg-transparent"
                      >
                        {provLogo ? (
                          <img src={provLogo} alt={provLabel} className="w-3.5 h-3.5" />
                        ) : (
                          <Cpu
                            size={12}
                            className={cn("text-muted-foreground", isActive && "text-accent-orange")}
                          />
                        )}
                      </div>
                      {isActive && (
                        <Check size={8} className="absolute -bottom-0.5 -right-0.5 text-accent-orange bg-card-3 rounded-full" />
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Models section - vertical scroll */}
            <div className="sidebar-scroll px-3 py-1.5 max-h-[200px] overflow-y-auto">
              <h3 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70 mb-1">models</h3>
              <div className="space-y-0.5">
                {isLoadingModels && (
                  <div className="px-2 py-1 font-mono-tech text-[10px] text-muted-foreground/60">
                    syncing models...
                  </div>
                )}
                {!isLoadingModels && filteredModels.length === 0 && (
                  <div className="px-2 py-1.5 font-mono-tech text-[10px] text-muted-foreground/60">No models found.</div>
                )}
                {filteredModels.map((model) => (
                  <div
                    key={model.id}
                    className={cn(
                      "flex items-center justify-between px-2 py-1 rounded border transition-all cursor-pointer",
                      selectedModel === model.id
                        ? "border-accent-blue/40 bg-accent-blue/10"
                        : "border-border/40 bg-card-3/50 hover:border-border hover:bg-card-3/60"
                    )}
                    onClick={() => {
                      setInternalSelectedModel(model.id);
                      onSelectModel?.(model.id);
                      setSearchQuery("");
                      setIsOpen(false);
                    }}
                  >
                    <span className={cn(
                      "font-mono-tech text-[10px] truncate flex-1",
                      selectedModel === model.id ? "text-foreground" : "text-foreground/70"
                    )}>
                      {model.name}
                    </span>
                    {selectedModel === model.id && (
                      <Check size={10} className="text-accent-blue shrink-0" />
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Reasoning-effort section. Only shown for provider+model
                combinations that have meaningful reasoning control. The
                actual translation to provider-specific fields happens on
                the backend (see reasoning-translator.ts). */}
            {isReasoningCapableModel(resolvedProvider, selectedModel) && (
              <div className="border-t border-border/30 px-3 py-1.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <Brain size={9} className="text-muted-foreground/70" />
                  <h3 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                    reasoning effort
                  </h3>
                </div>
                <div className="grid grid-cols-5 gap-1">
                  {REASONING_EFFORT_OPTIONS.map((option) => {
                    const isActive = option.value === selectedReasoningEffort;
                    return (
                      <button
                        key={option.value}
                        type="button"
                        onClick={() => {
                          onSelectReasoningEffort?.(option.value);
                          // Keep the dropdown open so the user can
                          // re-pick if they change their mind; only
                          // model selection closes it.
                        }}
                        title={option.description}
                        className={cn(
                          "rounded border px-1.5 py-1 font-mono-tech text-[9px] font-medium transition-all",
                          isActive
                            ? "border-accent-purple/40 bg-accent-purple/10 text-foreground"
                            : "border-border/40 bg-card-3/50 text-foreground/60 hover:border-border hover:bg-card-3/60"
                        )}
                      >
                        {option.label}
                      </button>
                    );
                  })}
                </div>
                <p className="mt-1.5 font-mono-tech text-[9px] text-muted-foreground/60 leading-relaxed">
                  {REASONING_EFFORT_OPTIONS.find((o) => o.value === selectedReasoningEffort)?.description}
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
