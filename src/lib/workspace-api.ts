// Workspace API client

import { fetchWithAuth } from "./http";

export type Workspace = {
  id: string;
  name: string;
  path: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
  _count?: {
    conversations: number;
  };
};

export type WorkspaceTreeNode = {
  name: string;
  path: string;
  relativePath: string;
  type: "file" | "directory";
  children?: WorkspaceTreeNode[];
};

export type WorkspaceTreeResponse = {
  workspaceId: string;
  name: string;
  path: string;
  tree: WorkspaceTreeNode[];
};

export type PickWorkspaceFolderResponse = {
  path: string | null;
  name: string | null;
  cancelled: boolean;
};

export async function listWorkspaces(): Promise<Workspace[]> {

  const response = await fetchWithAuth(`/workspaces`, {
  });
  if (!response.ok) {
    throw new Error("Failed to fetch workspaces");
  }
  return response.json();
}

export type WorkspaceRegistryItem = Workspace & {
  conversationCount: number;
  runningAgentCount: number;
  pendingApprovalCount: number;
  runningAgents: Array<{
    id: string;
    conversationId: string;
    conversationTitle: string | null;
    status: string;
    provider: string;
    model: string;
    promptPreview: string | null;
    startedAt: Date;
    updatedAt: Date;
  }>;
};

export type WorkspaceRegistry = {
  items: WorkspaceRegistryItem[];
  totals: {
    workspaces: number;
    runningAgents: number;
    pendingApprovals: number;
  };
  staleRunThresholdMs: number;
};

export async function getActiveWorkspace(): Promise<Workspace | null> {
  // `/workspaces/active` is now a UI hint, not a singleton. The server
  // returns `{ workspace: null }` when the user has never marked one
  // active, instead of 404-ing. We treat every 2xx as "ok" and just
  // read the `workspace` field.
  const response = await fetchWithAuth(`/workspaces/active`, {
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as { workspace: Workspace | null };
  return payload.workspace;
}

export async function getWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  const response = await fetchWithAuth(`/agent/runs/registry`);
  if (!response.ok) {
    throw new Error("Failed to fetch workspace registry");
  }
  return response.json();
}

export async function pickWorkspaceFolder(): Promise<PickWorkspaceFolderResponse> {
  const response = await fetchWithAuth(`/workspaces/pick-folder`, {
    method: "POST",
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to browse folders" }));
    throw new Error(error.message || "Failed to browse folders");
  }

  return response.json();
}

export async function createWorkspace(data: {
  name: string;
  path: string;
}): Promise<Workspace> {

  const response = await fetchWithAuth(`/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Failed to create workspace");
  }

  return response.json();
}

export async function updateWorkspace(
  id: string,
  data: {
    name?: string;
    path?: string;
    isActive?: boolean;
  }
): Promise<Workspace> {
  const response = await fetchWithAuth(`/workspaces/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(data)
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Failed to update workspace");
  }

  return response.json();
}

export async function deleteWorkspace(id: string): Promise<void> {
  const response = await fetchWithAuth(`/workspaces/${id}`, {
    method: "DELETE",
  });

  if (!response.ok) {
    const error = await response.json();
    throw new Error(error.message || "Failed to delete workspace");
  }
}

export async function setActiveWorkspace(id: string): Promise<Workspace> {
  return updateWorkspace(id, { isActive: true });
}

export async function getWorkspaceTree(id: string): Promise<WorkspaceTreeResponse> {
  const response = await fetchWithAuth(`/workspaces/${id}/tree`, {
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to fetch workspace tree" }));
    throw new Error(error.message || "Failed to fetch workspace tree");
  }
  return response.json();
}

export type WorkspaceFileContent = {
  content: string;
  path: string;
  size: number;
  lines: number;
};

export async function getWorkspaceFileContent(
  workspaceId: string,
  filePath: string
): Promise<WorkspaceFileContent> {
  const params = new URLSearchParams({ path: filePath });
  const response = await fetchWithAuth(
    `/workspaces/${workspaceId}/file?${params.toString()}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to read file" }));
    throw new Error(error.message || "Failed to read file");
  }
  return response.json();
}

/**
 * Fetch a workspace file as an authenticated blob and wrap it in an
 * object URL. The /raw endpoint sits behind JWT auth, which plain
 * `<a href>` / `<img src>` cannot carry — every download and image
 * preview must go through this (audit M1.6). Callers own the returned
 * URL and must `URL.revokeObjectURL` it when done.
 */
export async function fetchWorkspaceRawObjectUrl(
  workspaceId: string,
  filePath: string
): Promise<string> {
  const params = new URLSearchParams({ path: filePath });
  const response = await fetchWithAuth(
    `/workspaces/${workspaceId}/raw?${params.toString()}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to fetch file" }));
    throw new Error(error.message || "Failed to fetch file");
  }
  const blob = await response.blob();
  return URL.createObjectURL(blob);
}

export type WorkspaceFileStat = {
  path: string;
  size: number;
  mtime: number;
  isDirectory: boolean;
  childCount?: number;
};

export async function getWorkspaceFileStat(
  workspaceId: string,
  filePath: string
): Promise<WorkspaceFileStat> {
  const params = new URLSearchParams({ path: filePath });
  const response = await fetchWithAuth(
    `/workspaces/${workspaceId}/stat?${params.toString()}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to stat path" }));
    throw new Error(error.message || "Failed to stat path");
  }
  return response.json();
}

// Tier 4: Go-to-file and Find-in-files.

export type FileMatch = {
  path: string;
  name: string;
  matchedField: "basename" | "path" | "fuzzy";
};

export async function matchWorkspaceFiles(
  workspaceId: string,
  query: string,
  limit?: number
): Promise<FileMatch[]> {
  const params = new URLSearchParams({ q: query });
  if (limit) params.set("limit", String(limit));
  const response = await fetchWithAuth(
    `/workspaces/${workspaceId}/files/match?${params.toString()}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to search files" }));
    throw new Error(error.message || "Failed to search files");
  }
  const data = (await response.json()) as { matches: FileMatch[] };
  return data.matches;
}

export type ContentMatch = {
  path: string;
  line: number;
  column: number;
  preview: string;
};

export type SearchResult = {
  query: string;
  count: number;
  matches: ContentMatch[];
};

export async function searchWorkspaceContents(
  workspaceId: string,
  query: string,
  limit?: number
): Promise<SearchResult> {
  const params = new URLSearchParams({ q: query });
  if (limit) params.set("limit", String(limit));
  const response = await fetchWithAuth(
    `/workspaces/${workspaceId}/search?${params.toString()}`
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to search contents" }));
    throw new Error(error.message || "Failed to search contents");
  }
  return response.json();
}

