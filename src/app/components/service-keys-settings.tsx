import { useEffect, useState } from "react";
import { Eye, EyeOff, Save, Plus, Trash2, Edit2, X, Check, Loader2, Globe, KeyRound, RotateCcw, Copy } from "lucide-react";
import { toast } from "sonner";
import {
  getServiceKeys,
  addServiceKey,
  updateServiceKey,
  deleteServiceKey,
  setActiveServiceKey,
  toggleServiceAutoSwitch,
  decryptServiceKey,
  type ServiceApiKeyRef,
} from "../../lib/api";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "./ui/accordion";
import { AlertDialog, AlertDialogTrigger, AlertDialogContent, AlertDialogHeader, AlertDialogTitle, AlertDialogDescription, AlertDialogFooter, AlertDialogCancel, AlertDialogAction } from "./ui/alert-dialog";
import { Switch as ToggleSwitch } from "./ui/switch";

const SERVICE_META: Record<string, { label: string; logo?: string }> = {
  serper: {
    label: "Serper",
    // Serper is the default web search backend (used by the web_search tool
    // when SERPER_API_KEY is set; falls back to DuckDuckGo otherwise).
    logo: "/src/assets/serper.jpg"
  },
};

type ServiceKeysSettingsProps = {
  service?: string;
};

export const ServiceKeysSettings = ({ service = "serper" }: ServiceKeysSettingsProps) => {
  const meta = SERVICE_META[service] ?? { label: service };

  const [keys, setKeys] = useState<ServiceApiKeyRef[]>([]);
  const [activeKeyId, setActiveKeyIdState] = useState<string | null>(null);
  const [autoSwitch, setAutoSwitchState] = useState(false);
  const [loading, setLoading] = useState(true);
  const [enabled, setEnabled] = useState(true);

  // New key form
  const [newKeyName, setNewKeyName] = useState("");
  const [newKeyValue, setNewKeyValue] = useState("");
  const [showNewKey, setShowNewKey] = useState(false);
  const [saving, setSaving] = useState(false);

  // Edit state
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [editingValue, setEditingValue] = useState("");

  // View state
  const [viewingId, setViewingId] = useState<string | null>(null);
  const [viewingValue, setViewingValue] = useState("");
  const [loadingKeyId, setLoadingKeyId] = useState<string | null>(null);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);

  // Accordion state
  const [accordionOpen, setAccordionOpen] = useState(false);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      try {
        const data = await getServiceKeys(service);
        setKeys(data.keys);
        setAutoSwitchState(data.autoSwitch);
        const active = data.keys.find((k) => k.isActive);
        setActiveKeyIdState(active?.id ?? null);
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to load keys");
      } finally {
        setLoading(false);
      }
    };
    void load();
  }, [service]);

  const handleAdd = async () => {
    const name = newKeyName.trim() || `Key ${keys.length + 1}`;
    const apiKey = newKeyValue.trim();
    if (!apiKey) {
      toast.error("API key cannot be empty");
      return;
    }

    setSaving(true);
    try {
      const created = await addServiceKey({ service, name, apiKey });
      setKeys((prev) => [...prev, created]);
      if (keys.length === 0) setActiveKeyIdState(created.id);
      setNewKeyName("");
      setNewKeyValue("");
      toast.success("Key added successfully");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to add key");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await deleteServiceKey(id);
      setKeys((prev) => {
        const next = prev.filter((k) => k.id !== id);
        if (activeKeyId === id) setActiveKeyIdState(next[0]?.id ?? null);
        return next;
      });
      setDeletingKeyId(null);
      toast.success("Key deleted");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to delete key");
    }
  };

  const handleSetActive = async (keyId: string) => {
    try {
      await setActiveServiceKey(service, keyId);
      setKeys((prev) => prev.map((k) => ({ ...k, isActive: k.id === keyId })));
      setActiveKeyIdState(keyId);
      toast.success("Active key updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to set active key");
    }
  };

  const handleToggleAutoSwitch = async (enabled: boolean) => {
    try {
      await toggleServiceAutoSwitch(service, enabled);
      setAutoSwitchState(enabled);
      setKeys((prev) => prev.map((k) => ({ ...k, autoSwitch: enabled })));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update auto-switch");
    }
  };

  const handleViewKey = async (keyId: string) => {
    if (viewingId === keyId) {
      setViewingId(null);
      setViewingValue("");
      return;
    }
    setLoadingKeyId(keyId);
    try {
      const result = await decryptServiceKey(keyId);
      setViewingId(keyId);
      setViewingValue(result.apiKey);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load key");
    } finally {
      setLoadingKeyId(null);
    }
  };

  const handleStartEdit = async (keyId: string) => {
    setLoadingKeyId(keyId);
    try {
      const result = await decryptServiceKey(keyId);
      setEditingId(keyId);
      setEditingName(result.name);
      setEditingValue(result.apiKey);
      setViewingId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load key");
    } finally {
      setLoadingKeyId(null);
    }
  };

  const handleSaveEdit = async () => {
    if (!editingId) return;
    try {
      const updated = await updateServiceKey(editingId, {
        name: editingName.trim() || undefined,
        apiKey: editingValue.trim() || undefined,
      });
      setKeys((prev) =>
        prev.map((k) => (k.id === editingId ? { ...k, name: updated.name } : k))
      );
      setEditingId(null);
      toast.success("Key updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update key");
    }
  };

  const inputCls = "w-full panel-card rounded border-border/60 px-3 py-2 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring";

  const renderKeyCard = (item: ServiceApiKeyRef) => {
    const isActive = activeKeyId === item.id;
    const isEditing = editingId === item.id;
    const isViewing = viewingId === item.id;
    const isLoading = loadingKeyId === item.id;

    if (isEditing) {
      return (
        <div key={item.id} className="panel-card rounded p-3 space-y-2">
          <input
            type="text"
            value={editingName}
            onChange={(e) => setEditingName(e.target.value)}
            placeholder="Key name"
            autoComplete="off"
            data-1p-ignore={true}
            spellCheck={false}
            className={inputCls}
          />
          <div className="relative">
            <input
              type="password"
              value={editingValue}
              onChange={(e) => setEditingValue(e.target.value)}
              placeholder="API key value"
              autoComplete="new-password"
              data-1p-ignore={true}
              autoCorrect="off"
              autoCapitalize="none"
              spellCheck={false}
              className={`${inputCls} font-mono-tech`}
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
              onClick={() => setEditingId(null)}
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
                  value={viewingValue}
                  readOnly
                  className="w-full panel-card rounded border-border/60 py-1 px-2 font-mono-tech text-[10px] text-foreground pr-9"
                />
                <div className="absolute right-1 top-1/2 -translate-y-1/2 flex gap-1">
                  <button
                    onClick={() => {
                      void navigator.clipboard.writeText(viewingValue);
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
              onClick={() => void handleSetActive(item.id)}
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
                    onClick={() => void handleDelete(item.id)}
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

  const activeKey = keys.find((item) => activeKeyId === item.id);
  const inactiveKeys = keys.filter((item) => activeKeyId !== item.id);

  return (
    <div className="sidebar-scroll flex-1 overflow-y-auto bg-app p-5 text-primary">
      <div
        className="sticky top-[-20px] z-10 w-full h-12 pointer-events-none"
        style={{ backgroundImage: "linear-gradient(to bottom, var(--fade-tint-strong), transparent)" }}
      />
      <div className="mx-auto max-w-3xl space-y-6">
        <header className="space-y-2">
          <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground overflow-hidden">
            {meta.logo ? (
              <img src={meta.logo} alt={meta.label} className="h-5 w-5 object-contain" />
            ) : (
              <Globe size={16} />
            )}
          </div>
          <h1 className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Web Search</h1>
          <p className="max-w-[65ch] font-mono-tech text-[10px] text-muted-foreground">
            Configure the provider used for web search so the agent can fetch live information when it needs network data.
          </p>
        </header>

        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-orange/15 text-accent-orange">
              <KeyRound size={14} />
            </div>
            <div>
              <h2 className="panel-title">{meta.label} API Keys</h2>
              <p className="panel-desc mt-0.5">
                Saved keys stay hidden. Pick the active key manually or let the app rotate on failures.
              </p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between gap-3 panel-card rounded px-4 py-3.5">
              <div>
                <div className="font-mono-tech text-[10px] font-semibold text-foreground">Web search provider</div>
                <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">
                  Enable or pause this integration without removing your saved keys.
                </div>
              </div>
              <ToggleSwitch
                checked={enabled}
                onCheckedChange={setEnabled}
              />
            </div>

            <div className="panel-card rounded p-4 space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="font-mono-tech text-[10px] font-semibold text-foreground">Add or update a key</div>
                  <div className="mt-0.5 font-mono-tech text-[9px] text-muted-foreground">
                    Save a key to enable web search requests for the agent.
                  </div>
                </div>
                <button
                  onClick={() => {
                    void handleAdd();
                  }}
                  disabled={saving || loading || !newKeyValue.trim()}
                  className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-orange/80 disabled:opacity-50 transition-colors"
                >
                  {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
                  {saving ? "Saving" : "Save"}
                </button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_auto] gap-2">
                <input
                  type="text"
                  value={newKeyName}
                  onChange={(e) => setNewKeyName(e.target.value)}
                  placeholder="Key name (optional)"
                  autoComplete="off"
                  data-1p-ignore={true}
                  spellCheck={false}
                  className={inputCls}
                />

                <div className="relative">
                  <input
                    type={showNewKey ? "text" : "password"}
                    value={newKeyValue}
                    onChange={(e) => setNewKeyValue(e.target.value)}
                    placeholder="Paste your Serper API key"
                    autoComplete="new-password"
                    data-1p-ignore={true}
                    autoCorrect="off"
                    autoCapitalize="none"
                    spellCheck={false}
                    className={`${inputCls} w-full pr-10 font-mono-tech`}
                  />
                  <button
                    onClick={() => setShowNewKey((prev) => !prev)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showNewKey ? <EyeOff size={13} strokeWidth={2.5} /> : <Eye size={13} strokeWidth={2.5} />}
                  </button>
                </div>

                <button
                  onClick={() => {
                    if (newKeyValue) {
                      void navigator.clipboard.writeText(newKeyValue);
                    }
                  }}
                  className="px-3 py-2 rounded panel-badge cursor-pointer hover:bg-accent/30 transition-colors"
                >
                  Copy
                </button>
              </div>

              <div className="font-mono-tech text-[9px] text-muted-foreground inline-flex items-center gap-1.5">
                <Plus size={11} /> Add key values above, then click Save.
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
                <ToggleSwitch
                  checked={autoSwitch}
                  onCheckedChange={(v) => void handleToggleAutoSwitch(v)}
                />
              </div>
            </div>

            <div className="space-y-2">
              {loading && <div className="font-mono-tech text-[10px] text-muted-foreground">Loading keys...</div>}
              {!loading && keys.length === 0 && (
                <div className="panel-card rounded border-dashed px-4 py-8 text-center font-mono-tech text-[10px] text-muted-foreground">
                  No saved API keys yet.
                </div>
              )}
              {!loading && (
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
              )}
            </div>
          </div>
        </section>

        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
              <RotateCcw size={14} />
            </div>
            <div>
              <h2 className="panel-title">How It Works</h2>
              <p className="panel-desc mt-0.5">
                The agent uses this integration when it needs fresh network data instead of relying only on local context.
              </p>
            </div>
          </div>
          <div className="panel-card rounded px-4 py-4 panel-desc">
            Add at least one active key, keep automatic fallback on if you use multiple keys, and disable the provider temporarily if you want the agent to avoid web search entirely.
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
