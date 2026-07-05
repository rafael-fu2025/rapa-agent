import { useState } from "react";
import { Save, Loader2, Plug, BookOpen, Server } from "lucide-react";
import { toast } from "sonner";
import { createCustomProvider } from "../../lib/api";

type AddCustomProviderProps = {
  onSuccess: () => void;
};

export const AddCustomProvider = ({ onSuccess }: AddCustomProviderProps) => {
  const [provider, setProvider] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [modelsInput, setModelsInput] = useState("");
  const [saving, setSaving] = useState(false);

  const handleSave = async () => {
    const providerSlug = provider.trim().toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const name = displayName.trim();
    const url = baseUrl.trim();
    const models = modelsInput
      .split("\n")
      .map((m) => m.trim())
      .filter((m) => m.length > 0);

    if (!providerSlug || !name || !url || models.length === 0) {
      toast.error("Please fill in all fields");
      return;
    }

    setSaving(true);
    try {
      await createCustomProvider({
        provider: providerSlug,
        displayName: name,
        baseUrl: url,
        models
      });
      toast.success(`Provider "${name}" added successfully`);
      setProvider("");
      setDisplayName("");
      setBaseUrl("");
      setModelsInput("");
      onSuccess();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add provider");
    } finally {
      setSaving(false);
    }
  };

  const inputClassName = "w-full panel-card rounded border-border/60 px-3 py-2 font-mono-tech text-[10px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:border-ring transition-colors";

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
            <div className="inline-flex h-9 w-9 items-center justify-center rounded bg-accent/50 border border-border/40 text-accent-foreground">
              <Plug size={16} />
            </div>
            <h1 className="font-mono-tech text-[11px] font-semibold uppercase tracking-[0.16em] text-foreground">Add Custom Provider</h1>
            <p className="max-w-[65ch] font-mono-tech text-[10px] text-muted-foreground">
              Connect any OpenAI-compatible API endpoint. Pick a unique provider ID, give it a friendly name, then list the models you want to expose.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              onClick={() => {
                void handleSave();
              }}
              disabled={saving}
              className="inline-flex items-center gap-1.5 rounded bg-accent-orange px-3 py-1.5 font-mono-tech text-[10px] font-semibold uppercase tracking-[0.12em] text-white hover:bg-accent-orange/80 disabled:opacity-50 transition-colors"
            >
              {saving ? <Loader2 size={11} className="animate-spin" /> : <Save size={11} />}
              {saving ? "Saving" : "Save Provider"}
            </button>
          </div>
        </header>

        {/* Section: Provider Information */}
        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-blue/15 text-accent-blue">
              <Server size={14} />
            </div>
            <div>
              <h2 className="panel-title">Provider Information</h2>
              <p className="panel-desc mt-0.5">
                Configure your custom OpenAI-compatible API endpoint.
              </p>
            </div>
          </div>
          <div className="panel-card rounded p-4 space-y-4">
            <div className="space-y-1.5">
              <label className="block panel-label text-muted-foreground">
                Provider ID
              </label>
              <input
                type="text"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="e.g., openrouter, together-ai"
                className={inputClassName}
              />
              <p className="panel-desc">
                Lowercase letters, numbers, and hyphens only. Used internally to identify the provider.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block panel-label text-muted-foreground">
                Display Name
              </label>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="e.g., OpenRouter, Together AI"
                className={inputClassName}
              />
              <p className="panel-desc">
                The friendly name shown in the UI.
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block panel-label text-muted-foreground">
                Base URL
              </label>
              <input
                type="url"
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder="https://api.example.com/v1"
                className={inputClassName}
              />
              <p className="panel-desc">
                The OpenAI-compatible API endpoint (must include protocol).
              </p>
            </div>

            <div className="space-y-1.5">
              <label className="block panel-label text-muted-foreground">
                Models (one per line)
              </label>
              <textarea
                value={modelsInput}
                onChange={(e) => setModelsInput(e.target.value)}
                placeholder={"openai/gpt-4\nanthropic/claude-3-opus\nmeta-llama/llama-3-70b"}
                rows={8}
                className={`${inputClassName} font-mono-tech`}
              />
              <p className="panel-desc">
                One model ID per line. Use the exact model IDs from your provider's documentation.
              </p>
            </div>
          </div>
        </section>

        {/* Section: Popular Providers */}
        <section className="analytics-panel rounded-lg p-5">
          <div className="flex items-start gap-3 pb-4">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded bg-accent-green/15 text-accent-green">
              <BookOpen size={14} />
            </div>
            <div>
              <h2 className="panel-title">Popular Providers</h2>
              <p className="panel-desc mt-0.5">
                Reference base URLs for well-known OpenAI-compatible providers. Copy one to get started quickly.
              </p>
            </div>
          </div>
          <div className="panel-card rounded p-3 space-y-1.5">
            {[
              { name: "OpenRouter", slug: "openrouter", url: "https://openrouter.ai/api/v1", models: "anthropic/claude-sonnet-5\nopenai/gpt-5.5\ngoogle/gemini-3.1-pro-preview\nminimax/minimax-m3\nminimax/minimax-m2.7" },
              { name: "Together AI", slug: "together-ai", url: "https://api.together.xyz/v1", models: "meta-llama/Llama-3.3-70B-Instruct-Turbo\nQwen/Qwen2.5-72B-Instruct-Turbo" },
              { name: "Groq", slug: "groq-cloud", url: "https://api.groq.com/openai/v1", models: "llama-3.3-70b-versatile\nllama-3.1-8b-instant" },
              { name: "Perplexity", slug: "perplexity", url: "https://api.perplexity.ai", models: "sonar\nsonar-pro" }
            ].map((item) => (
              <button
                key={item.name}
                type="button"
                onClick={() => {
                  setProvider(item.slug);
                  setDisplayName(item.name);
                  setBaseUrl(item.url);
                  setModelsInput(item.models);
                  toast.success(`Filled from ${item.name} preset. Add your API key after saving.`);
                }}
                className="w-full flex items-center justify-between gap-3 rounded bg-card-3/50 border border-border/40 px-3 py-2 hover:border-accent-orange/40 hover:bg-card-3 transition-colors text-left"
              >
                <span className="font-mono-tech text-[10px] font-semibold text-foreground">{item.name}</span>
                <code className="font-mono-tech text-[9px] text-accent-purple">{item.url}</code>
              </button>
            ))}
            <p className="panel-desc pt-1">
              Click a preset to pre-fill the form. You'll still need to add an API key after saving.
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
