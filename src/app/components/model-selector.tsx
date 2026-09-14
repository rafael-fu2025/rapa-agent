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
import { getSettings, getProviders, getReasoningProfile, type ReasoningEffort, type ReasoningProfile } from "../../lib/api";
import { getProviderIcon } from "../../lib/provider-icons";
import { Hint } from "./ui/tooltip";

/**
 * Per-model effort options come from the backend's reasoning-profile
 * endpoint (single source of truth: server reasoning-capabilities.ts).
 * This map only supplies the display labels.
 */
const EFFORT_META: Record<string, { label: string; description: string }> = {
  off:    { label: "Default", description: "Provider default" },
  low:    { label: "Low",     description: "Light thinking, fastest + cheapest" },
  medium: { label: "Medium",  description: "Balanced reasoning" },
  high:   { label: "High",    description: "Deep thinking, better for complex tasks" },
  xhigh:  { label: "XHigh",   description: "Extra-deep reasoning tier" },
  max:    { label: "Max",     description: "Maximum effort for this model" },
  ultra:  { label: "Ultra",   description: "The highest tier this model supports" },
  on:     { label: "On",      description: "Thinking enabled" }
};

/** Client copy of the snap ladder: ultra→max→xhigh→high→medium→low→off. */
const EFFORT_ORDER: ReasoningEffort[] = ["off", "low", "medium", "high", "xhigh", "max", "ultra"];
function snapEffortToProfile(current: ReasoningEffort, levels: ReasoningEffort[]): ReasoningEffort {
  const normalized = current === "on" ? "high" : current;
  let index = EFFORT_ORDER.indexOf(normalized);
  if (index === -1) index = 0;
  while (index >= 0) {
    if (levels.includes(EFFORT_ORDER[index])) return EFFORT_ORDER[index];
    index -= 1;
  }
  return "off";
}

/** Module-level profile cache so re-opens don't refetch. */
const profileCache = new Map<string, ReasoningProfile>();

/** Test seam: the cache is keyed by provider+model and outlives renders. */
export function __clearReasoningProfileCacheForTests(): void {
  profileCache.clear();
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

  // ── Per-model reasoning profile ────────────────────────────────────────
  // Fetched whenever the provider/model changes; drives which effort
  // options render. When the current effort isn't supported by the new
  // model, snap it down to the nearest supported level.
  const [reasoningProfile, setReasoningProfile] = useState<ReasoningProfile | null>(null);

  useEffect(() => {
    if (!resolvedProvider || !selectedModel) {
      setReasoningProfile(null);
      return;
    }
    const cacheKey = `${resolvedProvider}::${selectedModel}`;
    const cached = profileCache.get(cacheKey);
    if (cached) {
      setReasoningProfile(cached);
      return;
    }
    let cancelled = false;
    getReasoningProfile(resolvedProvider, selectedModel)
      .then((profile) => {
        profileCache.set(cacheKey, profile);
        if (!cancelled) setReasoningProfile(profile);
      })
      .catch(() => {
        // Backend unreachable — hide the section rather than guess.
        if (!cancelled) setReasoningProfile(null);
      });
    return () => {
      cancelled = true;
    };
  }, [resolvedProvider, selectedModel]);

  // Snap: model switched under an unsupported effort → nearest supported.
  useEffect(() => {
    if (!reasoningProfile || reasoningProfile.style === "none") return;
    if (reasoningProfile.levels.includes(selectedReasoningEffort)) return;
    const snapped = snapEffortToProfile(selectedReasoningEffort, reasoningProfile.levels);
    if (snapped !== selectedReasoningEffort) {
      onSelectReasoningEffort?.(snapped);
    }
  }, [reasoningProfile, selectedReasoningEffort, onSelectReasoningEffort]);

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
    // Only decide the selection is invalid once the provider's SAVED model
    // list has loaded. Before that, `modelsForProvider` shows hardcoded
    // defaults — swapping against those silently replaced a user-selected
    // or conversation-restored model the moment the picker mounted
    // (audit M1.4). An empty/missing saved list keeps the selection.
    if (savedModels.length === 0 || !selectedModel) return;
    const hasSelected = savedModels.some((model) => model.id === selectedModel);
    if (!hasSelected) {
      // Fall back to the first SAVED model, not the first hardcoded one.
      const fallback = savedModels[0]?.id ?? "";
      if (fallback) {
        setInternalSelectedModel(fallback);
        onSelectModel?.(fallback);
      }
    }
  }, [savedModels, onSelectModel, selectedModel]);

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
        {/* Reasoning-effort badge. Shown only when the current model's
            profile supports reasoning AND the user has set something
            other than the default ("off"). Hovering shows the current
            level so the user can see at-a-glance what setting the next
            message will use. */}
        {selectedReasoningEffort !== "off"
          && reasoningProfile !== null
          && reasoningProfile.style !== "none" && (
          <Hint label={`Reasoning: ${selectedReasoningEffort}`}>
            <span
              className="flex items-center gap-0.5 rounded border border-accent-purple/40 bg-accent-purple/10 px-1.5 py-0.5 font-mono-tech text-[8.5px] font-semibold uppercase tracking-[0.12em] text-accent-purple"
            >
              <Brain size={8} />
              {EFFORT_META[selectedReasoningEffort]?.label ?? selectedReasoningEffort}
            </span>
          </Hint>
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
                    <Hint key={provId} label={provLabel}>
                      <div
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
                    </Hint>
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

            {/* Reasoning-effort section — options come from the backend's
                per-model reasoning profile (binary / standard / extended).
                Hidden when the model has no reasoning control. The actual
                translation to provider-native fields happens on the
                backend (see reasoning-translator.ts). */}
            {reasoningProfile && reasoningProfile.style !== "none" && reasoningProfile.levels.length > 0 && (
              <div className="border-t border-border/30 px-3 py-1.5">
                <div className="flex items-center gap-1.5 mb-1">
                  <Brain size={9} className="text-muted-foreground/70" />
                  <h3 className="font-mono-tech text-[9px] font-semibold uppercase tracking-[0.16em] text-muted-foreground/70">
                    reasoning effort
                  </h3>
                  {reasoningProfile.source === "upstream-metadata" && (
                    <span className="ml-auto font-mono-tech text-[8px] uppercase tracking-[0.12em] text-muted-foreground/50">
                      per model
                    </span>
                  )}
                </div>
                <div className={`grid gap-1 ${reasoningProfile.levels.length <= 4 ? "grid-cols-4" : reasoningProfile.levels.length === 5 ? "grid-cols-5" : "grid-cols-6"}`}>
                  {reasoningProfile.levels.map((level) => {
                    const isActive = level === selectedReasoningEffort;
                    const meta = EFFORT_META[level] ?? { label: level, description: level };
                    return (
                      <Hint key={level} label={meta.description}>
                        <button
                          type="button"
                          onClick={() => {
                            onSelectReasoningEffort?.(level);
                            // Keep the dropdown open so the user can
                            // re-pick if they change their mind; only
                            // model selection closes it.
                          }}
                          className={cn(
                            "rounded border px-1.5 py-1 font-mono-tech text-[9px] font-medium transition-all",
                            isActive
                              ? "border-accent-purple/40 bg-accent-purple/10 text-foreground"
                              : "border-border/40 bg-card-3/50 text-foreground/60 hover:border-border hover:bg-card-3/60"
                          )}
                        >
                          {meta.label}
                        </button>
                      </Hint>
                    );
                  })}
                </div>
                <p className="mt-1.5 font-mono-tech text-[9px] text-muted-foreground/60 leading-relaxed">
                  {(EFFORT_META[selectedReasoningEffort] ?? EFFORT_META.off)?.description}
                </p>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
