// Workspace API client

const viteEnv = (import.meta as ImportMeta & { env?: { VITE_API_URL?: string } }).env;
// Default to `127.0.0.1` (IPv4 loopback) rather than `localhost` to
// avoid the IPv6/IPv4 resolution flakiness on Windows — see the
// longer comment in src/lib/api.ts. Override via VITE_API_URL.
const API_BASE = (viteEnv?.VITE_API_URL ?? "http://127.0.0.1:8787") + "/api";

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem("auth_token");
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Retry wrapper for 429 (rate limit) with exponential backoff. */
async function fetchWithRetry(url: string, init?: RequestInit, maxRetries = 3): Promise<Response> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch (err) {
      // Network-level failure (DNS, connection refused, etc.).
      // Surface a clear message instead of the raw TypeError.
      const message = err instanceof Error ? err.message : "Unknown network error";
      throw new Error(
        `Couldn't reach ${url}: ${message}. ` +
          "Is the backend running? Try `cd server && npm run dev` in a terminal."
      );
    }
    if (response.status !== 429 || attempt === maxRetries) return response;
    const retryAfter = response.headers.get("retry-after");
    const delayMs = retryAfter
      ? Math.min(parseInt(retryAfter, 10) * 1000, 30_000)
      : Math.min(1000 * Math.pow(2, attempt), 10_000);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return fetch(url, init);
}

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

  const response = await fetch(`${API_BASE}/workspaces`, {
    headers: authHeaders()
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
  const response = await fetch(`${API_BASE}/workspaces/active`, {
    headers: authHeaders()
  });
  if (!response.ok) {
    return null;
  }
  const payload = (await response.json()) as { workspace: Workspace | null };
  return payload.workspace;
}

export async function getWorkspaceRegistry(): Promise<WorkspaceRegistry> {
  const response = await fetchWithRetry(`${API_BASE}/agent/runs/registry`, {
    headers: authHeaders()
  });
  if (!response.ok) {
    throw new Error("Failed to fetch workspace registry");
  }
  return response.json();
}

export async function pickWorkspaceFolder(): Promise<PickWorkspaceFolderResponse> {
  const response = await fetch(`${API_BASE}/workspaces/pick-folder`, {
    method: "POST",
    headers: authHeaders()
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

  const response = await fetch(`${API_BASE}/workspaces`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
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
  const response = await fetch(`${API_BASE}/workspaces/${id}`, {
    method: "PATCH",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders()
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
  const response = await fetch(`${API_BASE}/workspaces/${id}`, {
    method: "DELETE",
    headers: authHeaders()
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
  const response = await fetch(`${API_BASE}/workspaces/${id}/tree`, {
    headers: authHeaders()
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
  const response = await fetch(
    `${API_BASE}/workspaces/${workspaceId}/file?${params.toString()}`,
    { headers: authHeaders() }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to read file" }));
    throw new Error(error.message || "Failed to read file");
  }
  return response.json();
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
  const response = await fetch(
    `${API_BASE}/workspaces/${workspaceId}/stat?${params.toString()}`,
    { headers: authHeaders() }
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
  const response = await fetchWithRetry(
    `${API_BASE}/workspaces/${workspaceId}/files/match?${params.toString()}`,
    { headers: authHeaders() }
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
  const response = await fetchWithRetry(
    `${API_BASE}/workspaces/${workspaceId}/search?${params.toString()}`,
    { headers: authHeaders() }
  );
  if (!response.ok) {
    const error = await response.json().catch(() => ({ message: "Failed to search contents" }));
    throw new Error(error.message || "Failed to search contents");
  }
  return response.json();
}

