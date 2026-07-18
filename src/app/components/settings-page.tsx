import { useEffect, useRef, useState } from "react";
import {
  Eye,
  EyeOff,
  Save,
  Plus,
  Trash2,
  Edit2,
  X,
  Check,
  Loader2,
  KeyRound,
  Link2,
  Layers,
  HelpCircle,
  Plug,
  RefreshCw,
  Copy
} from "lucide-react";
import { Switch as ToggleSwitch } from "./ui/switch";
import { toast } from "sonner";
import {
  getSettings,
  saveSettings,
  testApiKey,
  getApiKey,
  updateApiKey,
  refreshModels,
  type ProviderApiKeyRef
} from "../../lib/api";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "./ui/alert-dialog";
import { getProviderIcon } from "../../lib/provider-icons";

const PROVIDER_LABEL: Record<string, string> = {
  gemini: "Gemini",
  puter: "Puter",
  ollama: "Ollama",
  nvidia: "NVIDIA",
  groq: "Groq",
  huggingface: "Hugging Face",
  minimax: "Minimax",
  openrouter: "OpenRouter"
};

const DEFAULT_BASE_URL: Record<string, string> = {
  gemini: "https://generativelanguage.googleapis.com/v1beta/openai",
  puter: "https://api.puter.com/puterai/openai/v1/",
  ollama: "https://ollama.com/v1",
  nvidia: "https://integrate.api.nvidia.com/v1",
  groq: "https://api.groq.com/openai/v1",
  huggingface: "https://router.huggingface.co/v1",
  minimax: "https://api.minimax.io/v1",
  openrouter: "https://openrouter.ai/api/v1"
};

// Replaced by `getProviderIcon` from src/lib/provider-icons.ts
// (single source of truth for provider logos).

type SettingsPageProps = {
  provider?: string;
};

export const SettingsPage = ({ provider = "gemini" }: SettingsPageProps) => {
  const isKeyOptionalProvider = provider === "ollama";
  const providerLogo = getProviderIcon(provider);
  const [showNewApiKey, setShowNewApiKey] = useState(false);
  const [newApiKey, setNewApiKey] = useState("");
  const [newApiKeyName, setNewApiKeyName] = useState("");
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL[provider] || "");
  const [enabled, setEnabled] = useState(true);
  // Tracks the last value of `enabled` that was successfully persisted to the
  // server. We need this to know whether the disable toggle is the *only*
  // reason the user might still need to hit Save.
  const [savedEnabled, setSavedEnabled] = useState(true);
  // Same idea for the base URL: lets us know when the user is mid-typing
  // a new value (unsaved) vs. what the server currently has. Used by the
  // Save button visibility logic and the debounce.
  const [savedBaseUrl, setSavedBaseUrl] = useState("");
  const [autoSwitchApiKey, setAutoSwitchApiKey] = useState(false);
  const [modelsData, setModelsData] = useState<string[]>([]);
  const [newModel, setNewModel] = useState("");
  const [apiKeys, setApiKeys] = useState<ProviderApiKeyRef[]>([]);
  const [activeApiKeyId, setActiveApiKeyId] = useState<string | null>(null);
  const [pendingDeleteIds, setPendingDeleteIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingKey, setTestingKey] = useState(false);
  const [message, setMessage] = useState<string>("");
  const [accordionOpen, setAccordionOpen] = useState(false);
  const [refreshingModels, setRefreshingModels] = useState(false);
  
  // Edit/view state
  const [editingKeyId, setEditingKeyId] = useState<string | null>(null);
  const [editingKeyName, setEditingKeyName] = useState("");
  const [editingKeyValue, setEditingKeyValue] = useState("");
  const [viewingKeyId, setViewingKeyId] = useState<string | null>(null);
  const [viewingKeyValue, setViewingKeyValue] = useState("");
  const [loadingKeyId, setLoadingKeyId] = useState<string | null>(null);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
  const [deletingModel, setDeletingModel] = useState<string | null>(null);
  
  // Model editing state
  const [editingModelIndex, setEditingModelIndex] = useState<number | null>(null);
  const [editingModelValue, setEditingModelValue] = useState("");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setMessage("");
      setNewApiKey("");
      setNewApiKeyName("");
      setPendingDeleteIds([]);

      try {
        const settings = await getSettings(provider);
        setEnabled(settings.enabled);
        setSavedEnabled(settings.enabled);
        setBaseUrl(settings.baseUrl || DEFAULT_BASE_URL[provider]);
        setSavedBaseUrl(settings.baseUrl || DEFAULT_BASE_URL[provider]);
        setModelsData(settings.models);
        setApiKeys(settings.apiKeys);
        setActiveApiKeyId(settings.activeApiKeyId);
        setAutoSwitchApiKey(settings.autoSwitchApiKey);
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Failed to load settings");
      } finally {
        setLoading(false);
      }
    };

    void load();
  }, [provider]);

  const handleRemoveKey = (id: string) => {
    setApiKeys((prev) => {
      const next = prev.filter((item) => item.id !== id);
      if (activeApiKeyId === id) {
        setActiveApiKeyId(next[0]?.id ?? null);
      }
      return next;
    });
    setPendingDeleteIds((prev) => (prev.includes(id) ? prev : [...prev, id]));
  };

  // Explicit Add-Key flow: the user types a name + value into the two
  // inputs at the top of the API Keys section, then clicks the new
  // "Add Key" button. This auto-saves and clears the inputs in one step,
  // so the user never has to hunt for a separate Save button afterwards.
  const handleAddApiKey = async () => {
    const value = newApiKey.trim();
    if (!value) {
      toast.error("Paste an API key value first");
      return;
    }
    // Save with the new key + name; the server will return a new key entry
    // with a real id, which the load-from-response step below picks up.
    await persistSettings({ successMessage: "API key added." });
  };

  // === Auto-save machinery ====================================================
  //
  // Most settings in this page should save themselves the moment the user
  // commits a change. The single exception is the `enabled` toggle at the
  // top — flipping that requires a deliberate Save click (because it can
  // take down all chat/agent activity), so we keep an explicit Save button
  // for that case.
  //
  // To support both, we factor the network call into `persistSettings(overrides)`:
  //   - if `overrides.includeEnabled === true`, the `enabled` value is sent
  //     (used only by the explicit Save button).
  //   - otherwise the server's current `enabled` value is preserved by NOT
  //     passing it; we always pass it, but the disable toggle handler never
  //     calls this — it just stages the change locally until Save is clicked.
  //
  // The current implementation always sends the local `enabled` value, but
  // the Save button only appears when something is genuinely pending, and
  // the auto-save callers never touch the enabled flag (the user has to click
  // Save themselves if they want to flip it).
  const baseUrlDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<void> | null>(null);

  const persistSettings = async (overrides?: { successMessage?: string }) => {
    // Coalesce overlapping auto-save calls. If a save is already in-flight,
    // we chain a follow-up so the latest local state is persisted after the
    // current one resolves. This protects against rapid-fire events (e.g.
    // Add+Remove in quick succession) losing data.
    const doSave = async () => {
      setSaving(true);
      setMessage("");
      try {
        const saved = await saveSettings({
          provider,
          enabled,
          baseUrl,
          apiKey: newApiKey.trim() || undefined,
          apiKeyName: newApiKeyName.trim() || undefined,
          selectedApiKeyId: activeApiKeyId,
          autoSwitchApiKey,
          removeApiKeyIds: pendingDeleteIds.length > 0 ? pendingDeleteIds : undefined,
          models: modelsData
        });

        setEnabled(saved.enabled);
        setSavedEnabled(saved.enabled);
        setBaseUrl(saved.baseUrl);
        setSavedBaseUrl(saved.baseUrl);
        setModelsData(saved.models);
        setApiKeys(saved.apiKeys);
        setActiveApiKeyId(saved.activeApiKeyId);
        setAutoSwitchApiKey(saved.autoSwitchApiKey);
        setNewApiKey("");
        setNewApiKeyName("");
        setPendingDeleteIds([]);
        if (overrides?.successMessage) toast.success(overrides.successMessage);
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to save settings");
      } finally {
        setSaving(false);
      }
    };

    if (inFlightRef.current) {
      inFlightRef.current = inFlightRef.current.then(doSave);
      return inFlightRef.current;
    }
    inFlightRef.current = doSave().finally(() => {
      inFlightRef.current = null;
    });
    return inFlightRef.current;
  };

  // Wraps persistSettings with a debounce so high-frequency changes (typing
  // in the base URL field) don't fire one save per keystroke.
  const debouncedAutoSave = (successMessage: string, delayMs = 400) => {
    if (baseUrlDebounceRef.current) clearTimeout(baseUrlDebounceRef.current);
    baseUrlDebounceRef.current = setTimeout(() => {
      void persistSettings({ successMessage });
      baseUrlDebounceRef.current = null;
    }, delayMs);
  };

  // Used by the explicit Save button. Persists everything including a
  // toggled `enabled` flag if the user has flipped it.
  const handleSave = async () => {
    if (baseUrlDebounceRef.current) {
      clearTimeout(baseUrlDebounceRef.current);
      baseUrlDebounceRef.current = null;
    }
    await persistSettings({ successMessage: "Settings saved." });
  };

  const handleAddModel = async () => {
    const model = newModel.trim();
    if (!model) return;
    if (modelsData.includes(model)) {
      toast.error("Model already exists");
      return;
    }
    // Optimistic update for snappy UX, then auto-save in the background.
    // If the save fails, the user sees the error toast and the local
    // change is naturally reverted when they retry.
    setModelsData((prev) => [...prev, model]);
    setNewModel("");
    await persistSettings({ successMessage: `Model "${model}" added.` });
  };

  const handleRemoveModel = async (model: string) => {
    setModelsData((prev) => prev.filter((m) => m !== model));
    await persistSettings({ successMessage: `Model "${model}" removed.` });
  };

  // Reset baseUrlDebounceRef on unmount to avoid stray callbacks.
  useEffect(() => {
    return () => {
      if (baseUrlDebounceRef.current) clearTimeout(baseUrlDebounceRef.current);
    };
  }, []);
  // === End auto-save machinery ================================================

  const handleTestActiveKey = async () => {
    setTestingKey(true);

    try {
      const result = await testApiKey({
        provider,
        apiKeyId: activeApiKeyId ?? undefined
      });
      toast.success(`API key "${result.keyName}" is valid.`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to test API key");
    } finally {
      setTestingKey(false);
    }
  };

  const handleRefreshModels = async (merge: boolean) => {
    setRefreshingModels(true);
    try {
      const result = await refreshModels({
        provider,
        apiKeyId: activeApiKeyId ?? undefined,
        merge
      });
      setModelsData(result.models);
      const parts: string[] = [];
      if (result.added.length > 0) parts.push(`${result.added.length} added`);
      if (result.removed.length > 0) parts.push(`${result.removed.length} removed`);
      if (parts.length === 0) parts.push("no changes");
      toast.success(`Models refreshed (${parts.join(", ")}).`);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to refresh models");
    } finally {
      setRefreshingModels(false);
    }
  };

  const handleViewKey = async (keyId: string) => {
    if (viewingKeyId === keyId) {
      // Close if already viewing
      setViewingKeyId(null);
      setViewingKeyValue("");
      return;
    }

    setLoadingKeyId(keyId);
    try {
      const result = await getApiKey({ provider, apiKeyId: keyId });
      setViewingKeyId(keyId);
      setViewingKeyValue(result.apiKey);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load API key");
    } finally {
      setLoadingKeyId(null);
    }
  };

  const handleStartEdit = async (keyId: string) => {
    setLoadingKeyId(keyId);
    try {
      const result = await getApiKey({ provider, apiKeyId: keyId });
      setEditingKeyId(keyId);
      setEditingKeyName(result.name);
      setEditingKeyValue(result.apiKey);
      setViewingKeyId(null); // Close view mode
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to load API key");
    } finally {
      setLoadingKeyId(null);
    }
  };

  const handleCancelEdit = () => {
    setEditingKeyId(null);
    setEditingKeyName("");
    setEditingKeyValue("");
  };

  const handleSaveEdit = async () => {
    if (!editingKeyId) return;

    try {
      await updateApiKey({
        provider,
        apiKeyId: editingKeyId,
        name: editingKeyName.trim() || undefined,
        apiKey: editingKeyValue.trim() || undefined
      });

      // Update local state
      setApiKeys(prev => prev.map(k => 
        k.id === editingKeyId 
          ? { ...k, name: editingKeyName.trim() || k.name }
          : k
      ));

      toast.success("API key updated successfully");
      setEditingKeyId(null);
      setEditingKeyName("");
      setEditingKeyValue("");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update API key");
    }
  };

  const handleStartEditModel = (index: number, currentValue: string) => {
    setEditingModelIndex(index);
    setEditingModelValue(currentValue);
  };

  const handleSaveEditModel = async () => {
    if (editingModelIndex === null) return;

    const trimmed = editingModelValue.trim();
    if (!trimmed) {
      toast.error("Model name cannot be empty");
      return;
    }

    // Check for duplicates (excluding the current one being edited)
    const isDuplicate = modelsData.some((m, idx) => idx !== editingModelIndex && m === trimmed);
    if (isDuplicate) {
      toast.error("Model already exists");
      return;
    }

    setModelsData(prev => prev.map((m, idx) => idx === editingModelIndex ? trimmed : m));
    setEditingModelIndex(null);
    setEditingModelValue("");
    await persistSettings({ successMessage: `Model updated to "${trimmed}".` });
  };

  const handleCancelEditModel = () => {
    setEditingModelIndex(null);
    setEditingModelValue("");
  };

  // === Save-button visibility =================================================
  // The header Save button only appears when the *only* remaining pending
  // change is something we deliberately keep manual. Right now that's:
  //   - the enabled/disable toggle (its flip should be a deliberate act)
  //   - staged new API key / key name (user typed but hasn't clicked Add Key)
  //   - staged key deletions
  // Every other change (add/remove model, edit model, set active key,
  // autoSwitch toggle, base URL edit) auto-saves immediately and therefore
  // doesn't count as "pending" once it has been committed.
  const hasPendingSave =
    enabled !== savedEnabled ||
    newApiKey.trim() !== "" ||
    newApiKeyName.trim() !== "" ||
    pendingDeleteIds.length > 0;

  return (
    <div className="sidebar-scroll flex-1 overflow-y-auto bg-app p-5 text-primary">
      <div
        className="sticky top-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to bottom, var(--fade-tint-strong), transparent)" }}
      />
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Page Header */}
        <header className="flex items-start justify-between gap-4">
          <div className="space-y-2">
            <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground overflow-hidden">
              {providerLogo ? (
                <img src={providerLogo} alt={provider} className="h-4 w-4 object-contain" />
              ) : (
                <Plug size={16} />
              )}
            </div>
            <h1 className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">
              {PROVIDER_LABEL[provider] || provider.charAt(0).toUpperCase() + provider.slice(1)}
            </h1>
            <p className="max-w-[65ch] font-mono-tech text-[10px] text-muted-foreground">
              Manage connection details, API keys, fallback behavior, and the list of available models for this provider.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <ToggleSwitch
              checked={enabled}
              onCheckedChange={setEnabled}
            />
            {hasPendingSave && (
              <button
                onClick={() => {
                  void handleSave();
                }}
                disabled={saving || loading}
                className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-orange/80 disabled:opacity-50 transition-colors"
              >
                {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                {saving ? "Saving" : "Save"}
              </button>
            )}
          </div>
        </header>

        {message && <div className="text-[12px] text-muted-foreground">{message}</div>}

        {/* Section 1: API Keys */}
        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-orange/15 text-accent-orange">
              <KeyRound size={14} />
            </div>
            <div>
              <h2 className="panel-title">API Keys</h2>
              <p className="panel-desc mt-0.5">
                Saved keys stay hidden. Pick the active key manually or let the app rotate on failures.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-1">
              <p className="panel-desc">
                Saved keys are always hidden. Choose the active key manually or enable automatic fallback.
              </p>
            </div>

            <div className="space-y-2">
              {apiKeys.length === 0 && (
                <div className="panel-desc">
                  {isKeyOptionalProvider ? "No API key saved. Ollama usually works without one." : "No saved API keys yet."}
                </div>
              )}
              {(() => {
                // Split into active and inactive keys
                const activeKey = apiKeys.find((item) => activeApiKeyId === item.id);
                const inactiveKeys = apiKeys.filter((item) => activeApiKeyId !== item.id);
                
                const renderKeyCard = (item: ProviderApiKeyRef) => {
                  const isActive = activeApiKeyId === item.id;
                  const isEditing = editingKeyId === item.id;
                  const isViewing = viewingKeyId === item.id;
                  const isLoading = loadingKeyId === item.id;

                  if (isEditing) {
                    return (
                      <div key={item.id} className="panel-card rounded p-3 space-y-2">
                        <input
                          type="text"
                          value={editingKeyName}
                          onChange={(e) => setEditingKeyName(e.target.value)}
                          placeholder="Key name"
                          autoComplete="off"
                          data-1p-ignore={true}
                          spellCheck={false}
                          className="w-full panel-card rounded border-border/60 py-2 px-3 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
                        />
                        <div className="relative">
                          <input
                            type="password"
                            value={editingKeyValue}
                            onChange={(e) => setEditingKeyValue(e.target.value)}
                            placeholder="API key value"
                            autoComplete="new-password"
                            data-1p-ignore={true}
                            autoCorrect="off"
                            autoCapitalize="none"
                            spellCheck={false}
                            className="w-full panel-card rounded border-border/60 py-2 px-3 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
                          />
                        </div>
                        <div className="flex gap-2">
                          <button
                            onClick={() => void handleSaveEdit()}
                            className="flex-1 px-3 py-1.5 rounded bg-accent-green text-white font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] inline-flex items-center justify-center gap-1.5 hover:bg-accent-green/80 transition-colors"
                          >
                            <Check size={12} />
                            Save
                          </button>
                          <button
                            onClick={handleCancelEdit}
                            className="flex-1 px-3 py-1.5 rounded panel-badge inline-flex items-center justify-center gap-1.5 cursor-pointer hover:bg-accent/30 transition-colors"
                          >
                            <X size={12} />
                            Cancel
                          </button>
                        </div>
                      </div>
                    );
                  }

                  return (
                    <div key={item.id} className="panel-card rounded px-3 py-2">
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1 flex flex-col gap-1">
                          <div className="font-mono-tech text-[10px] font-semibold text-foreground truncate">{item.name}</div>
                        {isViewing ? (
                          <div className="relative">
                            <input
                              type="text"
                              value={viewingKeyValue}
                              readOnly
                              className="w-full panel-card rounded border-border/60 py-1 px-2 font-mono-tech text-[10px] text-foreground pr-9"
                            />
                            <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
                              <button
                                onClick={() => {
                                  void navigator.clipboard.writeText(viewingKeyValue);
                                  toast.success("API key copied to clipboard");
                                }}
                                className="p-1 text-muted-foreground hover:text-foreground transition-colors"
                                title="Copy"
                              >
                                <Copy size={11} />
                              </button>
                            </div>
                          </div>
                        ) : (
                          <div className="font-mono-tech text-[10px] text-muted-foreground">{item.maskedKey}</div>
                        )}
                        </div>
                        <div className="flex items-center gap-1">
                          <button
                            onClick={() => {
                              if (isActive) return; // no-op
                              setActiveApiKeyId(item.id);
                              void persistSettings({ successMessage: `Active key set to "${item.name}".` });
                            }}
                            className={`px-2 py-1 rounded panel-badge ${isActive ? "border-accent-green/30 bg-accent-green/15 text-accent-green" : ""}`}
                            title={isActive ? "Active key" : "Set as active"}
                          >
                            {isActive ? "Active" : "Use"}
                          </button>
                          <button
                            onClick={() => void handleViewKey(item.id)}
                            disabled={isLoading}
                            className="p-1.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                            title={isViewing ? "Hide key" : "View key"}
                          >
                            {isLoading ? "..." : isViewing ? <EyeOff size={13} strokeWidth={2.5} /> : <Eye size={13} strokeWidth={2.5} />}
                          </button>
                          <button
                            onClick={() => void handleStartEdit(item.id)}
                            disabled={isLoading}
                            className="p-1.5 text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50"
                            title="Edit key"
                          >
                            <Edit2 size={13} strokeWidth={2.5} />
                          </button>
                          <AlertDialog open={deletingKeyId === item.id} onOpenChange={(open) => setDeletingKeyId(open ? item.id : null)}>
                            <AlertDialogTrigger asChild>
                              <button
                              className="p-1.5 text-muted-foreground hover:text-accent-red transition-colors"
                                title="Delete key"
                              >
                                <Trash2 size={13} strokeWidth={2.5} />
                              </button>
                            </AlertDialogTrigger>
                            <AlertDialogContent className="bg-card-3 border-card-hover text-primary">
                              <AlertDialogHeader>
                                <AlertDialogTitle className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em]">Delete API Key</AlertDialogTitle>
                                <AlertDialogDescription className="font-mono-tech text-[10px]">
                                  Are you sure you want to delete "{item.name}"? This action cannot be undone.
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel className="bg-transparent border-card-hover font-mono-tech text-[10px] text-primary hover:bg-card-4 hover:text-primary">
                                  Cancel
                                </AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={() => {
                                    handleRemoveKey(item.id);
                                    setDeletingKeyId(null);
                                    void persistSettings({ successMessage: `API key "${item.name}" deleted.` });
                                  }}
                                  disabled={saving}
                                  className="bg-accent-red font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] hover:bg-accent-red/80 disabled:opacity-50"
                                >
                                  Delete
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      </div>
                    </div>
                  );
                };

                return (
                  <>
                    {activeKey && renderKeyCard(activeKey)}
                    {inactiveKeys.length > 0 && (
                      <Accordion
                        type="single"
                        collapsible
                        value={accordionOpen ? "inactive" : ""}
                        onValueChange={(value) => setAccordionOpen(value === "inactive")}
                      >
                        <AccordionItem value="inactive" className="border-none">
                          <AccordionTrigger className="py-2 w-full flex items-center justify-between font-mono-tech text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                            <span>Show {inactiveKeys.length} more key{inactiveKeys.length !== 1 ? "s" : ""}</span>
                          </AccordionTrigger>
                          <AccordionContent className="space-y-2 pt-1">
                            {inactiveKeys.map(renderKeyCard)}
                          </AccordionContent>
                        </AccordionItem>
                      </Accordion>
                    )}
                  </>
                );
              })()}
            </div>

            <div className="panel-card rounded p-4 space-y-3">
              <div>
                <div className="font-mono-tech text-[10px] font-semibold text-foreground">Add a new key</div>
                <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">
                  Enter an optional name and paste the key, then click <strong>Add Key</strong>.
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2">
                <input
                  type="text"
                  value={newApiKeyName}
                  onChange={(e) => setNewApiKeyName(e.target.value)}
                  placeholder="Key name (optional)"
                  autoComplete="off"
                  data-1p-ignore={true}
                  spellCheck={false}
                  className="panel-card rounded border-border/60 py-2 px-3 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
                />

                <div className="relative">
                  <input
                    type={showNewApiKey ? "text" : "password"}
                    value={newApiKey}
                    onChange={(e) => setNewApiKey(e.target.value)}
                    placeholder="Paste a new API key"
                    autoComplete="new-password"
                    data-1p-ignore={true}
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className="w-full panel-card rounded border-border/60 py-2 px-3 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring pr-10"
                  />
                  <button
                    onClick={() => setShowNewApiKey((prev) => !prev)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showNewApiKey ? <EyeOff size={13} strokeWidth={2.5} /> : <Eye size={13} strokeWidth={2.5} />}
                  </button>
                </div>

                <button
                  onClick={() => {
                    if (newApiKey) {
                      void navigator.clipboard.writeText(newApiKey);
                    }
                  }}
                  className="px-3 py-2 rounded panel-badge cursor-pointer hover:bg-accent/30 transition-colors"
                >
                  Copy
                </button>
                <button
                  onClick={() => void handleAddApiKey()}
                  disabled={!newApiKey.trim() || saving}
                  className="px-3 py-2 rounded bg-accent-green text-white font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] inline-flex items-center justify-center gap-1.5 hover:bg-accent-green/80 disabled:opacity-50 transition-colors"
                >
                  <Plus size={12} />
                  Add Key
                </button>
              </div>
              <div className="font-mono-tech text-[9px] text-muted-foreground inline-flex items-center gap-1.5">
                <Plus size={11} /> Paste a key above and click <strong>Add Key</strong> to save it instantly.
              </div>
            </div>

            <div className="panel-card rounded px-4 py-3.5">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <div className="font-mono-tech text-[10px] font-semibold text-foreground">Automatic fallback</div>
                  <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">
                    Rotate to another saved key when auth or rate-limit errors happen.
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <button
                    onClick={() => {
                      void handleTestActiveKey();
                    }}
                    disabled={testingKey || (!isKeyOptionalProvider && apiKeys.length === 0)}
                    className="px-3 py-1.5 rounded panel-badge font-mono-tech text-[10px] disabled:opacity-50 inline-flex items-center gap-1.5 cursor-pointer hover:bg-accent/30 transition-colors"
                  >
                    {testingKey && <Loader2 size={11} className="animate-spin" />}
                    {testingKey ? "Testing" : isKeyOptionalProvider ? "Test connection" : "Test active key"}
                  </button>
                  <ToggleSwitch
                    checked={autoSwitchApiKey}
                    onCheckedChange={(next) => {
                      setAutoSwitchApiKey(next);
                      void persistSettings({
                        successMessage: next
                          ? "Automatic fallback enabled."
                          : "Automatic fallback disabled."
                      });
                    }}
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Section 2: Base URL */}
        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
              <Link2 size={14} />
            </div>
            <div>
              <h2 className="panel-title">Base URL</h2>
              <p className="panel-desc mt-0.5">
                The OpenAI-compatible endpoint used by the backend for this provider.
              </p>
            </div>
          </div>
          <div className="panel-card rounded p-4 space-y-2">
            {provider === "ollama" && (
              <p className="font-mono-tech text-[10px] text-accent-blue">
                Tip: To use Ollama Cloud directly instead of your local app, set this to <code className="rounded border border-card-hover bg-card px-1 py-0.5 text-foreground">https://ollama.com/v1</code>
              </p>
            )}
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => {
                setBaseUrl(e.target.value);
                // Debounce: only save after the user stops typing for 600ms.
                // We compare against the last persisted value so we don't
                // fire useless saves for already-saved URLs.
                if (e.target.value !== savedBaseUrl) {
                  debouncedAutoSave("Base URL updated.", 600);
                }
              }}
              onBlur={() => {
                // Final flush when the user tabs away, so they don't have
                // to wait for the debounce window.
                if (baseUrlDebounceRef.current) {
                  clearTimeout(baseUrlDebounceRef.current);
                  baseUrlDebounceRef.current = null;
                }
                if (baseUrl !== savedBaseUrl) {
                  void persistSettings({ successMessage: "Base URL updated." });
                }
              }}
              placeholder={DEFAULT_BASE_URL[provider] || "https://api.example.com/v1"}
              className="w-full panel-card rounded border-border/60 py-2 px-3 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring transition-colors"
            />
          </div>
        </section>

        {/* Section 3: Available Models */}
        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-purple/15 text-accent-purple">
              <Layers size={14} />
            </div>
            <div className="flex-1">
              <h2 className="panel-title">Available Models</h2>
              <p className="panel-desc mt-0.5">
                Manage the list of models available for this provider. Click <em>Refresh</em> to fetch the live list from <code className="rounded border border-card-hover bg-card px-1 py-0.5 text-foreground">{baseUrl || DEFAULT_BASE_URL[provider] || "the provider"}</code>.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={() => void handleRefreshModels(true)}
                disabled={refreshingModels || loading}
                title="Fetch from provider and merge with current list"
                className="px-3 py-1.5 rounded border border-border/60 bg-card-3/50 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground hover:bg-card-3 disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
              >
                {refreshingModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Merge
              </button>
              <button
                onClick={() => void handleRefreshModels(false)}
                disabled={refreshingModels || loading}
                title="Fetch from provider and replace the current list"
                className="rounded bg-accent-purple px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-purple/80 disabled:opacity-50 inline-flex items-center gap-1.5 transition-colors"
              >
                {refreshingModels ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}
                Refresh
              </button>
            </div>
          </div>
          <div className="panel-card rounded p-4 space-y-3">

            <div className="space-y-2">
              {modelsData.length === 0 && <div className="panel-desc">No models configured yet.</div>}
              <div className="sidebar-scroll max-h-[300px] overflow-y-auto space-y-1">
                {modelsData.map((model, index) => {
                  const isEditing = editingModelIndex === index;

                  if (isEditing) {
                    return (
                      <div key={index} className="flex items-center gap-2 panel-card rounded px-3 py-2">
                        <input
                          type="text"
                          value={editingModelValue}
                          onChange={(e) => setEditingModelValue(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              handleSaveEditModel();
                            } else if (e.key === "Escape") {
                              handleCancelEditModel();
                            }
                          }}
                          className="flex-1 panel-card rounded border-border/60 py-1 px-2 font-mono-tech text-[10px] text-foreground focus:outline-none focus:border-ring"
                          autoFocus
                        />
                        <button
                          onClick={handleSaveEditModel}
                          className="p-1.5 text-accent-green hover:text-foreground transition-colors"
                          title="Save"
                        >
                          <Check size={12} strokeWidth={2.5} />
                        </button>
                        <button
                          onClick={handleCancelEditModel}
                          className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                          title="Cancel"
                        >
                          <X size={12} strokeWidth={2.5} />
                        </button>
                      </div>
                    );
                  }

                  return (
                    <div key={model} className="flex items-center justify-between gap-3 panel-card rounded px-3 py-2">
                      <span className="font-mono-tech text-[10px] text-foreground truncate flex-1">{model}</span>
                      <div className="flex items-center gap-1">
                        <button
                          onClick={() => handleStartEditModel(index, model)}
                          className="p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                          title="Edit model"
                        >
                          <Edit2 size={12} strokeWidth={2.5} />
                        </button>
                        <AlertDialog open={deletingModel === model} onOpenChange={(open) => setDeletingModel(open ? model : null)}>
                          <AlertDialogTrigger asChild>
                            <button
                              className="p-1.5 text-muted-foreground hover:text-accent-red transition-colors"
                              title="Remove model"
                            >
                              <Trash2 size={12} strokeWidth={2.5} />
                            </button>
                          </AlertDialogTrigger>
                          <AlertDialogContent className="bg-card-3 border-card-hover text-primary">
                            <AlertDialogHeader>
                              <AlertDialogTitle className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em]">Remove Model</AlertDialogTitle>
                              <AlertDialogDescription className="font-mono-tech text-[10px]">
                                Are you sure you want to remove "{model}"? This action cannot be undone.
                              </AlertDialogDescription>
                            </AlertDialogHeader>
                            <AlertDialogFooter>
                              <AlertDialogCancel className="bg-transparent border-card-hover font-mono-tech text-[10px] text-primary hover:bg-card-4 hover:text-primary">
                                Cancel
                              </AlertDialogCancel>
                              <AlertDialogAction
                                onClick={() => {
                                  handleRemoveModel(model);
                                  setDeletingModel(null);
                                }}
                                disabled={saving}
                                className="bg-accent-red hover:bg-accent-red/80 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white disabled:opacity-50"
                              >
                                Remove
                              </AlertDialogAction>
                            </AlertDialogFooter>
                          </AlertDialogContent>
                        </AlertDialog>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="flex gap-2">
              <input
                type="text"
                value={newModel}
                onChange={(e) => setNewModel(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    handleAddModel();
                  }
                }}
                placeholder="e.g., gpt-4, claude-3-opus, llama-3-70b"
                className="flex-1 panel-card rounded border-border/60 py-2 px-3 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring"
              />
              <button
                onClick={handleAddModel}
                disabled={!newModel.trim()}
                className="px-4 py-2 rounded border border-border/60 bg-card-3/50 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground hover:text-foreground hover:bg-card-3 disabled:opacity-50 disabled:hover:bg-card-3 disabled:hover:text-muted-foreground inline-flex items-center gap-1.5 transition-colors"
              >
                <Plus size={12} />
                Add
              </button>
            </div>

            <div className="space-y-1.5 pt-0.5">
              <div className="panel-desc font-mono-tech flex items-start gap-1.5">
                <Plus size={11} className="mt-0.5 shrink-0" />
                <span>Add model IDs above. They save instantly — no Save button needed.</span>
              </div>
              <div className="panel-desc font-mono-tech flex items-start gap-1.5">
                <RefreshCw size={11} className="mt-0.5 shrink-0" />
                <span>
                  Use <strong>Refresh</strong> to replace the list with whatever the provider returns,
                  or <strong>Merge</strong> to add provider models to your current list.
                  Existing user-added entries are preserved.
                </span>
              </div>
            </div>
          </div>
        </section>

        {/* Section 4: How It Works */}
        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-green/15 text-accent-green">
              <HelpCircle size={14} />
            </div>
            <div>
              <h2 className="panel-title">How It Works</h2>
              <p className="panel-desc mt-0.5">
                Quick reference for how this provider is wired into chat and agent requests.
              </p>
            </div>
          </div>
          <div className="panel-card rounded px-4 py-4 panel-desc space-y-2">
            <p>
              <strong className="text-foreground">Base URL</strong> — All requests for this provider are sent to this endpoint. Point it at any OpenAI-compatible service.
            </p>
            <p>
              <strong className="text-foreground">API Keys</strong> — Add one or more keys. The active key is used for every request; enable <em>Automatic fallback</em> to rotate to the next key on auth or rate-limit errors.
            </p>
            <p>
              <strong className="text-foreground">Available Models</strong> — The list shown in the model picker. Add or remove entries at any time; changes are saved when you click the top-right Save.
            </p>
          </div>
        </section>
      </div>
      <div
        className="sticky bottom-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to top, var(--fade-tint-strong), transparent)" }}
      />
    </div>
  );
};
