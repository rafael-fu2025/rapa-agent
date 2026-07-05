import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { Plus, ArrowUp, Image as ImageIcon, Paperclip, X, AlertCircle, LoaderCircle } from "lucide-react";
import type { ChatAttachment, ReasoningEffort } from "../../lib/api";
import { cn } from "../../lib/utils";

import { ModelSelector } from "./model-selector";

type ChatInputProps = {
  onSubmit: (prompt: string, attachments: ChatAttachment[]) => Promise<void> | void;
  onStop?: () => void;
  pending?: boolean;
  selectedProvider?: string;
  selectedModel?: string;
  onSelectProvider?: (provider: string) => void;
  onSelectModel?: (model: string) => void;
  selectedReasoningEffort?: ReasoningEffort;
  onSelectReasoningEffort?: (effort: ReasoningEffort) => void;
};

const MAX_ATTACHMENT_SIZE = 10 * 1024 * 1024;
const MAX_ATTACHMENTS = 12;
const MIN_HEIGHT = 120;
const MAX_HEIGHT = 450;
const DEFAULT_HEIGHT = 140;
const BOTTOM_ELEMENTS_HEIGHT = 55;

type AttachmentKind = "image" | "file";

function isTextLikeFile(file: File) {
  if (file.type.startsWith("text/")) return true;
  const lowerName = file.name.toLowerCase();
  return [".md", ".txt", ".json", ".csv", ".ts", ".tsx", ".js", ".jsx", ".html", ".css", ".xml"].some((ext) =>
    lowerName.endsWith(ext)
  );
}

function fileToDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error(`Failed to read file: ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function getTransferFiles(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return [] as File[];
  const itemFiles = Array.from(dataTransfer.items ?? [])
    .filter((item) => item.kind === "file")
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (itemFiles.length > 0) return itemFiles;
  return Array.from(dataTransfer.files ?? []);
}

function hasTransferFiles(dataTransfer: DataTransfer | null) {
  if (!dataTransfer) return false;
  if (Array.from(dataTransfer.types ?? []).includes("Files")) return true;
  if (Array.from(dataTransfer.items ?? []).some((item) => item.kind === "file")) return true;
  return dataTransfer.files.length > 0;
}

function getClipboardFiles(data: DataTransfer | null) {
  return getTransferFiles(data);
}

export const ChatInput = ({
  onSubmit,
  onStop,
  pending = false,
  selectedProvider,
  selectedModel,
  onSelectProvider,
  onSelectModel,
  selectedReasoningEffort = "off",
  onSelectReasoningEffort,
}: ChatInputProps) => {
  const [value, setValue] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [uploadError, setUploadError] = useState("");
  const [uploadProgress, setUploadProgress] = useState<number | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [containerHeight, setContainerHeight] = useState(DEFAULT_HEIGHT);
  const [isResizing, setIsResizing] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const imageInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const startYRef = useRef(0);
  const startHeightRef = useRef(0);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
      
      rafRef.current = requestAnimationFrame(() => {
        const delta = startYRef.current - e.clientY;
        const newHeight = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, startHeightRef.current + delta));
        setContainerHeight(newHeight);
      });
    };

    const handleMouseUp = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setIsResizing(false);
    };

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove, { passive: true });
      document.addEventListener('mouseup', handleMouseUp);
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, [isResizing]);

  const handleResizeStart = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsResizing(true);
    startYRef.current = e.clientY;
    startHeightRef.current = containerHeight;
  };

  useEffect(() => {
    // Auto-extend container when adding attachments
    if (attachments.length > 0 && containerHeight < 200) {
      setContainerHeight(200);
    }
  }, [attachments.length, containerHeight]);

  useEffect(() => {
    const handleOutside = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, []);

  const addAttachments = async (files: FileList | File[] | null, sourceKind?: AttachmentKind) => {
    if (!files || files.length === 0) return;
    setUploadError("");
    if (attachments.length >= MAX_ATTACHMENTS) {
      setUploadError(`Maximum ${MAX_ATTACHMENTS} attachments allowed.`);
      return;
    }
    const incoming = Array.from(files).slice(0, MAX_ATTACHMENTS - attachments.length);
    const next: ChatAttachment[] = [];
    const oversized: string[] = [];
    setUploadProgress(0);
    for (let index = 0; index < incoming.length; index += 1) {
      const file = incoming[index];
      if (file.size > MAX_ATTACHMENT_SIZE) {
        oversized.push(file.name);
        setUploadProgress(Math.round(((index + 1) / incoming.length) * 100));
        continue;
      }
      const kind = sourceKind ?? (file.type.startsWith("image/") ? "image" : "file");
      const base: ChatAttachment = {
        id: crypto.randomUUID(),
        kind,
        name: file.name,
        mimeType: file.type || "application/octet-stream"
      };
      if (kind === "image") {
        base.dataUrl = await fileToDataUrl(file);
      } else if (isTextLikeFile(file)) {
        base.textContent = await file.text();
      } else {
        base.dataUrl = await fileToDataUrl(file);
      }
      next.push(base);
      setUploadProgress(Math.round(((index + 1) / incoming.length) * 100));
    }
    if (oversized.length > 0) {
      setUploadError(`Skipped files > 10MB: ${oversized.slice(0, 2).join(", ")}${oversized.length > 2 ? "..." : ""}`);
    }
    setAttachments((prev) => [...prev, ...next]);
    setUploadProgress(null);
  };

  const handleSend = async () => {
    const prompt = value.trim();
    if ((!prompt && attachments.length === 0) || pending || uploadProgress !== null) return;
    const promptToSend = prompt || "Please analyze the uploaded files and images.";
    await onSubmit(promptToSend, attachments);
    setValue("");
    setAttachments([]);
    setMenuOpen(false);
    setUploadError("");
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = getClipboardFiles(event.clipboardData);
    if (files.length === 0) return;
    event.preventDefault();
    void addAttachments(files);
  };

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!hasTransferFiles(event.dataTransfer)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDragActive(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    const currentTarget = event.currentTarget;
    if (!currentTarget.contains(event.relatedTarget as Node | null)) {
      setDragActive(false);
    }
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    const files = getTransferFiles(event.dataTransfer);
    if (files.length === 0) return;
    event.preventDefault();
    setDragActive(false);
    void addAttachments(files);
  };

  return (
    <div
      className="w-full"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        ref={containerRef}
        className={cn(
          "sidebar-panel relative flex flex-col rounded-lg",
          "focus-within:border-ring/60 focus-within:ring-1 focus-within:ring-ring/30",
          dragActive && "border-accent-blue/50 ring-1 ring-accent-blue/30",
          isResizing && "cursor-ns-resize select-none"
        )}
        style={{ height: `${containerHeight}px` }}
      >
        <div
          className="h-3 cursor-ns-resize z-10 flex items-center justify-center transition-colors flex-shrink-0 group/resize"
          onMouseDown={handleResizeStart}
          role="separator"
          aria-orientation="horizontal"
          aria-label="Drag to resize input"
          aria-valuenow={containerHeight}
          aria-valuemin={MIN_HEIGHT}
          aria-valuemax={MAX_HEIGHT}
          title="Drag to resize"
        >
          <div className={cn(
            "h-1.5 rounded-full transition-all duration-150 ease-out",
            isResizing
              ? "w-20 bg-accent-orange shadow-[0_0_8px_-2px] shadow-accent-orange/60"
              : "w-14 bg-muted-foreground/40 group-hover/resize:w-16 group-hover/resize:bg-muted-foreground/70"
          )} />
        </div>

        {dragActive && (
          <div className="pointer-events-none absolute inset-1 z-20 flex items-center justify-center rounded-lg border border-dashed border-accent-blue/50 bg-card-3/70 text-[10px] font-mono-tech font-semibold uppercase tracking-[0.12em] text-accent-blue" style={{ backdropFilter: "blur(16px)" }}>
            Drop files or images to attach
          </div>
        )}

        <div className="px-4 pt-2 overflow-y-auto flex-shrink-0">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {attachments.map((attachment) => (
                <div key={attachment.id} className={cn(
                  "inline-flex items-center max-w-full rounded border border-border/40 bg-card-3/50",
                  attachment.kind === 'image' ? "p-0.5" : "px-2.5 py-1"
                )}>
                  {attachment.kind === 'image' && attachment.dataUrl ? (
                    <div className="relative">
                      <img
                        src={attachment.dataUrl}
                        alt={attachment.name}
                        className="w-8 h-8 rounded object-cover"
                      />
                      <button
                        onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}
                        className="absolute -top-1 -right-1 bg-card-3 text-muted-foreground hover:bg-accent-red hover:text-white transition-colors rounded p-0.5 border border-border/40"
                        type="button"
                      >
                        <X size={10} />
                      </button>
                    </div>
                  ) : (
                    <>
                      <span className="font-mono-tech text-[10px] text-foreground truncate max-w-[220px]">{attachment.name}</span>
                      <button
                        onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== attachment.id))}
                        className="text-muted-foreground hover:bg-accent-red hover:text-white transition-colors ml-2 rounded p-0.5"
                        type="button"
                      >
                        <X size={12} />
                      </button>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {uploadProgress !== null && (
            <div className="mb-2 font-mono-tech text-[10px] text-muted-foreground inline-flex items-center gap-2">
              <LoaderCircle size={12} className="animate-spin" />
              <span>Processing uploads... {uploadProgress}%</span>
            </div>
          )}

          {uploadError && (
            <div className="mb-2 font-mono-tech text-[10px] text-accent-red inline-flex items-center gap-2">
              <AlertCircle size={12} />
              <span>{uploadError}</span>
            </div>
          )}
        </div>

        <textarea
          placeholder="Ask me anything, paste files/images, or drop them here..."
          value={value}
          onChange={(event) => setValue(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              void handleSend();
            }
          }}
          spellCheck={false}
          className="sidebar-scroll w-full flex-1 bg-transparent px-4 pb-2 pt-1 resize-none font-mono-tech text-[10px] leading-5 text-foreground placeholder-muted-foreground focus:outline-none overflow-y-auto"
        />

        <div
          className="flex-shrink-0 flex items-center justify-between gap-2.5 px-3.5 pb-1 pt-2 z-20"
          style={{ height: `${BOTTOM_ELEMENTS_HEIGHT}px` }}
        >
          <div className="flex items-center gap-2 flex-wrap">
              <div className="relative" ref={menuRef}>
                <button
                  onClick={() => setMenuOpen((prev) => !prev)}
                  className={cn(
                    "p-1.5 rounded border transition-all duration-200 flex items-center justify-center",
                    menuOpen
                      ? "border-accent-orange/40 bg-accent-orange/15 text-accent-orange"
                      : "border-border/40 bg-card-3/50 text-muted-foreground hover:border-border hover:text-foreground"
                  )}
                  type="button"
                >
                  <Plus size={14} />
                </button>

                {menuOpen && (
                  <div className="absolute left-0 bottom-[48px] w-[240px] rounded border border-border/40 bg-card p-2 z-50">
                    <button
                      onClick={() => imageInputRef.current?.click()}
                      className="w-full flex items-center gap-2.5 rounded px-2.5 py-1.5 text-left font-mono-tech text-[10px] text-foreground hover:bg-card-3/60 transition-colors"
                      type="button"
                    >
                      <ImageIcon size={13} />
                      <span>Add Images</span>
                    </button>
                    <button
                      onClick={() => fileInputRef.current?.click()}
                      className="w-full flex items-center gap-2.5 rounded px-2.5 py-1.5 text-left font-mono-tech text-[10px] text-foreground hover:bg-card-3/60 transition-colors"
                      type="button"
                    >
                      <Paperclip size={13} />
                      <span>Add documents or files</span>
                    </button>
                  </div>
                )}

                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void addAttachments(event.target.files, "image");
                    event.currentTarget.value = "";
                    setMenuOpen(false);
                  }}
                />

                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  className="hidden"
                  onChange={(event) => {
                    void addAttachments(event.target.files, "file");
                    event.currentTarget.value = "";
                    setMenuOpen(false);
                  }}
                />
              </div>
            <ModelSelector
              selectedProvider={selectedProvider}
              selectedModel={selectedModel}
              onSelectProvider={onSelectProvider}
              onSelectModel={onSelectModel}
              selectedReasoningEffort={selectedReasoningEffort}
              onSelectReasoningEffort={onSelectReasoningEffort}
            />
          </div>

          <button
            onClick={() => {
              if (pending) {
                onStop?.();
                return;
              }
              void handleSend();
            }}
            disabled={pending ? false : (!value.trim() && attachments.length === 0) || uploadProgress !== null}
            className={cn(
              "p-1.5 rounded border transition-all duration-200 flex items-center justify-center",
              pending
                ? "border-accent-red/40 bg-accent-red/15 text-accent-red hover:bg-accent-red/25"
                : (value.trim() || attachments.length > 0)
                  ? "border-accent-orange/40 bg-accent-orange text-white hover:bg-accent-orange/80"
                  : "border-border/40 bg-card-3/50 text-muted-foreground"
            )}
            type="button"
            title={pending ? "Stop" : "Send"}
          >
            {pending ? (
              /* Stop indicator */
              <span className="relative flex h-3 w-3 items-center justify-center">
                <span className="absolute inline-flex h-4 w-4 rounded-sm bg-accent-red/35 animate-ping" />
                <span className="relative inline-flex h-2.5 w-2.5 rounded-[2px] bg-accent-red" />
              </span>
            ) : (
              <ArrowUp size={14} />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
