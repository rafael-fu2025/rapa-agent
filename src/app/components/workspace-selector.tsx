// Workspace selector component

import { useState, useEffect, useRef, type ChangeEvent } from "react";
import { Folder, FolderOpen, Plus, Check, Trash2 } from "lucide-react";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { toast } from "sonner";
import { cn } from "../../lib/utils";
import {
  listWorkspaces,
  createWorkspace,
  pickWorkspaceFolder,
  setActiveWorkspace,
  deleteWorkspace,
  type Workspace
} from "../../lib/workspace-api";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from "./ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./ui/alert-dialog";

type WorkspaceSelectorProps = {
  variant?: "default" | "icon";
  className?: string;
};

export function WorkspaceSelector({ variant = "default", className }: WorkspaceSelectorProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [isOpen, setIsOpen] = useState(false);
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [newWorkspace, setNewWorkspace] = useState({ name: "", path: "" });
  const [loading, setLoading] = useState(false);
  const [isBrowsing, setIsBrowsing] = useState(false);
  const [workspaceToDelete, setWorkspaceToDelete] = useState<{ id: string; name: string } | null>(null);
  const directoryInputRef = useRef<HTMLInputElement | null>(null);



  const activeWorkspace = workspaces.find(w => w.isActive);
  const isIconTrigger = variant === "icon";


  useEffect(() => {
    loadWorkspaces();
  }, []);

  async function loadWorkspaces() {
    try {
      const data = await listWorkspaces();
      setWorkspaces(data);
    } catch (error) {
      console.error("Failed to load workspaces:", error);
    }
  }

  function emitWorkspaceChanged() {
    window.dispatchEvent(new CustomEvent("workspace:changed"));
  }


  async function handleCreate() {
    if (!newWorkspace.name.trim() || !newWorkspace.path.trim()) {
      toast.error("Please fill in all fields");
      return;
    }

    setLoading(true);
    try {
      await createWorkspace(newWorkspace);
      toast.success("Workspace created");
      setNewWorkspace({ name: "", path: "" });
      setIsDialogOpen(false);
      await loadWorkspaces();
      emitWorkspaceChanged();
    } catch (error) {

      toast.error(error instanceof Error ? error.message : "Failed to create workspace");
    } finally {
      setLoading(false);
    }
  }

  async function handleSetActive(id: string) {
    try {
      await setActiveWorkspace(id);
      toast.success("Workspace activated");
      await loadWorkspaces();
      emitWorkspaceChanged();
      setIsOpen(false);
    } catch (error) {

      toast.error(error instanceof Error ? error.message : "Failed to activate workspace");
    }
  }

  async function confirmDelete() {
    if (!workspaceToDelete) return;
    try {
      await deleteWorkspace(workspaceToDelete.id);
      toast.success("Workspace deleted");
      await loadWorkspaces();
      emitWorkspaceChanged();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete workspace");
    } finally {
      setWorkspaceToDelete(null);
    }
  }

  function getWorkspaceNameFromPath(path: string) {
    const trimmedPath = path.replace(/[\\/]+$/, "");
    const segments = trimmedPath.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] || trimmedPath;
  }

  function inferWorkspacePath(file: File & { path?: string; webkitRelativePath?: string }) {
    const absoluteFilePath = typeof file.path === "string" ? file.path : "";
    const relativeFilePath = file.webkitRelativePath || file.name;

    if (!absoluteFilePath) {
      return null;
    }

    const normalizedAbsolute = absoluteFilePath.replace(/\\/g, "/");
    const normalizedRelativeSegments = relativeFilePath
      .replace(/\\/g, "/")
      .split("/")
      .filter(Boolean);

    const fallbackPath = normalizedAbsolute.slice(0, normalizedAbsolute.lastIndexOf("/"));
    if (normalizedRelativeSegments.length <= 1) {
      return fallbackPath;
    }

    const absoluteSegments = normalizedAbsolute.split("/");
    const segmentsToTrim = normalizedRelativeSegments.length - 1;

    if (absoluteSegments.length <= segmentsToTrim) {
      return fallbackPath;
    }

    return absoluteSegments.slice(0, absoluteSegments.length - segmentsToTrim).join("/");
  }

  async function handleBrowseDirectory() {
    setIsBrowsing(true);

    try {
      const selectedFolder = await pickWorkspaceFolder();

      if (selectedFolder.cancelled || !selectedFolder.path) {
        return;
      }

      const path = selectedFolder.path;
      const name = selectedFolder.name;
      setNewWorkspace((current) => ({
        name: current.name || name || getWorkspaceNameFromPath(path),
        path: path
      }));
    } catch (error) {
      console.warn("Native folder picker failed, falling back to browser directory input", error);
      directoryInputRef.current?.click();
      toast.info("Native folder picker unavailable. Trying browser folder browsing instead.");
    } finally {
      setIsBrowsing(false);
    }
  }


  function handleDirectoryChange(event: ChangeEvent<HTMLInputElement>) {
    const [firstFile] = Array.from(event.target.files ?? []) as Array<File & { path?: string; webkitRelativePath?: string }>;

    if (!firstFile) {
      return;
    }

    const inferredPath = inferWorkspacePath(firstFile);
    const inferredName = firstFile.webkitRelativePath?.split("/")[0]
      || (inferredPath ? getWorkspaceNameFromPath(inferredPath) : "")
      || firstFile.name;


    setNewWorkspace((current) => ({
      name: current.name || inferredName,
      path: inferredPath ?? current.path
    }));

    if (!inferredPath) {
      toast.info("Couldn't read the absolute folder path here. Please paste it manually after browsing.");
    }

    event.target.value = "";
  }

  return (

    <>
      <DropdownMenu open={isOpen} onOpenChange={setIsOpen}>
        <DropdownMenuTrigger asChild>
          {isIconTrigger ? (
            <button
              type="button"
              className={cn(
                "inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-card-4 hover:text-primary",
                activeWorkspace && "text-primary",
                className
              )}
              title={activeWorkspace ? `Open workspace (${activeWorkspace.name})` : "Open workspace"}
            >
              {activeWorkspace ? <FolderOpen className="h-4 w-4" /> : <Folder className="h-4 w-4" />}
            </button>
          ) : (
            <Button
              variant="outline"
              className={cn("gap-2 border-border bg-card text-foreground hover:bg-card-2", className)}
            >
              {activeWorkspace ? (
                <>
                  <FolderOpen className="w-4 h-4" />
                  <span className="max-w-[200px] truncate">{activeWorkspace.name}</span>
                </>
              ) : (
                <>
                  <Folder className="w-4 h-4" />
                  <span>Open Workspace</span>
                </>
              )}
            </Button>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent
          side={isIconTrigger ? "right" : "bottom"}
          align="start"
          sideOffset={8}
          collisionPadding={12}
          className="w-[320px] overflow-hidden rounded-xl border border-border bg-card p-0 text-primary shadow-none"
        >
          <div className="border-b border-card-hover px-4 py-3">
            <div className="text-[16px] font-semibold text-primary">Workspaces</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">Switch projects or add a workspace.</p>
          </div>

          <div className="max-h-[260px] overflow-y-auto px-2 py-2 [scrollbar-width:thin] [scrollbar-color:var(--card-hover)_transparent] [&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-track]:bg-transparent [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-card-hover">
            {workspaces.length === 0 ? (
              <div className="flex min-h-[140px] flex-col items-center justify-center rounded-lg border border-dashed border-card-hover bg-card px-4 text-center">
                <Folder className="h-7 w-7 text-muted-foreground" />
                <div className="mt-3 text-[14px] font-medium text-foreground">No workspaces yet</div>
                <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">Create a workspace to connect chats to the right project.</p>
              </div>
            ) : (
              <div className="space-y-1.5">
                {workspaces.map((workspace) => (
                  <div
                    key={workspace.id}
                    className={cn(
                      "group flex items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors",
                      workspace.isActive
                        ? "border-card-strong bg-card-2"
                        : "border-transparent bg-transparent hover:border-border hover:bg-card"
                    )}
                  >
                    <button
                      type="button"
                      onClick={() => {
                        if (!workspace.isActive) {
                          void handleSetActive(workspace.id);
                        }
                      }}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    >
                      <div
                        className={cn(
                          "mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border",
                          workspace.isActive
                            ? "border-card-strong bg-card text-primary"
                            : "border-border bg-card text-muted-foreground"
                        )}
                      >
                        <Folder className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span className="truncate text-[13px] font-medium text-primary">{workspace.name}</span>
                          {workspace.isActive ? (
                            <span className="rounded-full bg-card-2 border border-card-strong px-1.5 py-0.5 text-[10px] font-semibold text-primary">Active</span>
                          ) : null}
                        </div>
                        <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{workspace.path}</p>
                      </div>
                    </button>
                    <div className="flex shrink-0 items-center gap-0.5">
                      {workspace.isActive ? <Check className="h-3.5 w-3.5 text-primary" /> : null}
                      <button
                        type="button"
                        onClick={() => {
                          setWorkspaceToDelete({ id: workspace.id, name: workspace.name });
                        }}
                        className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-card-hover hover:text-primary"
                        title={`Delete ${workspace.name}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="border-t border-card-hover p-1.5">
            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setIsDialogOpen(true);
              }}
              className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-card"
            >
              <div className="flex h-7 w-7 items-center justify-center rounded-md border border-card-hover bg-card text-muted-foreground">
                <Plus className="h-3.5 w-3.5" />
              </div>
              <div>
                <div className="text-[12px] font-medium text-primary">Add Workspace</div>
                <div className="text-[10px] text-muted-foreground">Register a project folder</div>
              </div>
            </button>
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <input
        ref={directoryInputRef}
        type="file"
        className="hidden"
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={handleDirectoryChange}
      />

      <Dialog open={isDialogOpen} onOpenChange={setIsDialogOpen}>
        <DialogContent className="max-w-[720px] border-border bg-card text-foreground">
          <DialogHeader>
            <DialogTitle className="text-[18px] font-semibold text-foreground">Add Workspace</DialogTitle>
            <DialogDescription className="text-[13px] text-muted">
              Enter a friendly name and the absolute folder path for the project.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-5">
            <div className="space-y-2">
              <Label htmlFor="name" className="text-[13px] font-medium text-foreground">Workspace Name</Label>
              <Input
                id="name"
                placeholder="My Project"
                value={newWorkspace.name}
                onChange={(e) => setNewWorkspace({ ...newWorkspace, name: e.target.value })}
                className="h-11 border-card-hover bg-card text-primary placeholder:text-muted-foreground"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="path" className="text-[13px] font-medium text-foreground">Folder Path</Label>
              <Input
                id="path"
                placeholder="C:/path/to/project"
                value={newWorkspace.path}
                onChange={(e) => setNewWorkspace({ ...newWorkspace, path: e.target.value })}
                className="h-11 border-card-hover bg-card text-primary placeholder:text-muted-foreground"
              />
              <Button
                variant="outline"
                type="button"
                onClick={() => {
                  void handleBrowseDirectory();
                }}
                disabled={isBrowsing}
                className="border-card-hover bg-card text-[13px] text-muted-foreground hover:bg-card-hover hover:text-primary"
              >
                <FolderOpen className="h-4 w-4" />
                <span>{isBrowsing ? "Browsing..." : "Browse Folder"}</span>
              </Button>

              <p className="text-[12px] text-muted-foreground">Use the absolute path to the project folder you want to open.</p>
            </div>
          </div>

          <DialogFooter className="pt-1">
            <Button
              variant="ghost"
              onClick={() => setIsDialogOpen(false)}
              disabled={loading}
              className="px-4 py-2 h-auto text-muted-foreground hover:text-primary"
            >
              Cancel
            </Button>
            {/* Primary action — B/W/grey. No orange tint. */}
            <Button
              onClick={() => {
                void handleCreate();
              }}
              disabled={loading}
              className="rounded-full bg-primary text-app hover:opacity-90 px-5 py-2 h-auto"
            >
              {loading ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={workspaceToDelete !== null} onOpenChange={(open) => !open && setWorkspaceToDelete(null)}>
        <AlertDialogContent className="border-border bg-card text-foreground sm:max-w-[425px]">
          <AlertDialogHeader>
            <AlertDialogTitle>Delete workspace "{workspaceToDelete?.name}"?</AlertDialogTitle>
            <AlertDialogDescription className="text-muted-foreground">
              This will remove the workspace from your list, but won't delete any of your files.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel className="border-card-hover bg-transparent text-foreground hover:bg-card-hover hover:text-foreground">Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirmDelete()} className="bg-destructive text-destructive-foreground hover:opacity-90">
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
