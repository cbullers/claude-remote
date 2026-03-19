import { useState, useEffect, useCallback } from "react";
import { apiFetch } from "../lib/api";
import type { Project } from "./ProjectTabs";

interface GitFile {
  status: string;
  path: string;
}

interface GitStatusData {
  branch: string;
  isDirty: boolean;
  changedFiles: number;
  files: GitFile[];
  ahead: number;
  behind: number;
  isWorktree: boolean;
  parentRepoId: string | null;
  branches: string[];
}

interface PrData {
  url: string;
  number: number;
  title: string;
  state: string;
}

// Git status code to color/label
function fileStatusColor(status: string): string {
  if (status.includes("M")) return "text-yellow-300";
  if (status.includes("A")) return "text-green-300";
  if (status.includes("D")) return "text-red-300";
  if (status.includes("R")) return "text-blue-300";
  if (status === "??") return "text-[var(--color-text-tertiary)]";
  return "text-[var(--color-text-secondary)]";
}

function fileStatusLabel(status: string): string {
  if (status === "??") return "new";
  if (status.includes("M")) return "mod";
  if (status.includes("A")) return "add";
  if (status.includes("D")) return "del";
  if (status.includes("R")) return "ren";
  return status;
}

interface GitStatusProps {
  projectId: string | null;
  serverId?: string;
  serverUrl?: string;
  onWorktreeCreated?: (project: Project) => void;
  onWorktreeDeleted?: (projectId: string) => void;
}

export default function GitStatus({
  projectId,
  serverId,
  serverUrl,
  onWorktreeCreated,
  onWorktreeDeleted,
}: GitStatusProps) {
  const [status, setStatus] = useState<GitStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);

  // Worktree creation state
  const [showWorktreeCreate, setShowWorktreeCreate] = useState(false);
  const [newBranch, setNewBranch] = useState("");
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [pr, setPr] = useState<PrData | null>(null);

  const fetchPr = useCallback(async () => {
    if (!projectId) {
      setPr(null);
      return;
    }
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/pr`,
        { serverId, serverUrl },
      );
      if (!res.ok) {
        setPr(null);
        return;
      }
      setPr(await res.json());
    } catch {
      setPr(null);
    }
  }, [projectId, serverId, serverUrl]);

  const fetchStatus = useCallback(async () => {
    if (!projectId) {
      console.log("[GitStatus] No projectId, skipping fetch");
      setStatus(null);
      return;
    }

    console.log("[GitStatus] Fetching git status for:", projectId);
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/git`,
        { serverId, serverUrl },
      );
      if (!res.ok) {
        const data = await res.json();
        console.error("[GitStatus] API error:", data);
        throw new Error(data.error || "Failed to fetch git status");
      }
      const data = await res.json();
      console.log("[GitStatus] Got status:", data);
      setStatus(data);
      setError(null);
    } catch (err) {
      console.error("[GitStatus] Fetch failed:", err);
      setError(err instanceof Error ? err.message : "Unknown error");
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  // Fetch on mount and when projectId changes
  useEffect(() => {
    fetchStatus();
    fetchPr();
  }, [fetchStatus, fetchPr]);

  // Refresh periodically (every 30s)
  useEffect(() => {
    if (!projectId) return;
    const interval = setInterval(() => {
      fetchStatus();
      fetchPr();
    }, 30000);
    return () => clearInterval(interval);
  }, [projectId, fetchStatus, fetchPr]);

  // Reset worktree create state when dropdown closes
  useEffect(() => {
    if (!expanded) {
      setShowWorktreeCreate(false);
      setNewBranch("");
      setCreateError(null);
    }
  }, [expanded]);

  const handleCreateWorktree = async () => {
    if (!projectId || !newBranch.trim()) return;

    setCreating(true);
    setCreateError(null);
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ branch: newBranch.trim() }),
          serverId,
          serverUrl,
        },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to create worktree");
      }
      const data = await res.json();
      setNewBranch("");
      setShowWorktreeCreate(false);
      setExpanded(false);
      onWorktreeCreated?.(data.project);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setCreating(false);
    }
  };

  const handleDeleteWorktree = async () => {
    if (!projectId) return;

    setDeleting(true);
    try {
      const res = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/worktrees`,
        {
          method: "DELETE",
          serverId,
          serverUrl,
        },
      );
      if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || "Failed to delete worktree");
      }
      setExpanded(false);
      onWorktreeDeleted?.(projectId);
    } catch (err) {
      setCreateError(
        err instanceof Error ? err.message : "Failed to delete worktree",
      );
    } finally {
      setDeleting(false);
    }
  };

  if (!projectId || error) {
    return null;
  }

  if (loading && !status) {
    return (
      <div className="flex items-center gap-1.5 px-2 py-1 bg-[var(--color-bg-secondary)] rounded-lg">
        <div className="w-3 h-3 border border-[var(--color-text-tertiary)] border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!status) {
    return null;
  }

  return (
    <div className="relative flex items-center gap-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className={`
          flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium transition-colors
          ${
            status.isDirty
              ? "bg-yellow-900/50 text-yellow-300 hover:bg-yellow-900/70"
              : "bg-[var(--color-bg-secondary)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"
          }
        `}
        title={`${status.branch}${status.isDirty ? " (uncommitted changes)" : ""}`}
      >
        {/* Git branch icon */}
        <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
          <path
            fillRule="evenodd"
            d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"
          />
        </svg>

        <span className="truncate max-w-[100px]">{status.branch}</span>

        {/* Dirty indicator */}
        {status.isDirty && (
          <span className="w-1.5 h-1.5 bg-yellow-400 rounded-full" />
        )}

        {/* Ahead/behind indicators */}
        {status.ahead > 0 && (
          <span
            className="text-green-400"
            title={`${status.ahead} commits ahead`}
          >
            ↑{status.ahead}
          </span>
        )}
        {status.behind > 0 && (
          <span
            className="text-red-400"
            title={`${status.behind} commits behind`}
          >
            ↓{status.behind}
          </span>
        )}
      </button>
      {pr && (
        <a
          href={pr.url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center gap-1 px-2 py-1 rounded-lg text-xs font-medium bg-[var(--color-bg-secondary)] text-[var(--color-accent)] hover:bg-[var(--color-bg-hover)] transition-colors"
          title={`PR #${pr.number}: ${pr.title}`}
        >
          <svg className="w-3.5 h-3.5" viewBox="0 0 16 16" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"
            />
          </svg>
          #{pr.number}
        </a>
      )}

      {/* Expanded details dropdown */}
      {expanded && (
        <>
          {/* Backdrop to close */}
          <div
            className="fixed inset-0 z-40"
            onClick={() => setExpanded(false)}
          />

          <div className="absolute top-full left-0 mt-1 z-50 w-64 max-w-[calc(100vw-2rem)] bg-[var(--color-bg-secondary)] border border-[var(--color-border-default)] rounded-lg shadow-xl overflow-hidden">
            <div className="p-3 space-y-2">
              {/* Branch */}
              <div className="flex items-center gap-2">
                <svg
                  className="w-4 h-4 text-[var(--color-text-tertiary)]"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"
                  />
                </svg>
                <span className="text-sm text-[var(--color-text-primary)] font-medium">
                  {status.branch}
                </span>
                {status.isWorktree && (
                  <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-bg-hover)] text-[var(--color-text-tertiary)]">
                    worktree
                  </span>
                )}
              </div>

              {/* Status summary */}
              {status.isDirty ? (
                <div className="flex items-center gap-2">
                  <div className="w-4 h-4 flex items-center justify-center">
                    <span className="w-2 h-2 bg-yellow-400 rounded-full" />
                  </div>
                  <span className="text-sm text-yellow-300">
                    {status.changedFiles} file
                    {status.changedFiles !== 1 ? "s" : ""} changed
                  </span>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <svg
                    className="w-4 h-4 text-green-400"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
                      clipRule="evenodd"
                    />
                  </svg>
                  <span className="text-sm text-green-300">
                    Clean working tree
                  </span>
                </div>
              )}

              {/* Ahead/behind */}
              {(status.ahead > 0 || status.behind > 0) && (
                <div className="flex items-center gap-3 text-sm">
                  {status.ahead > 0 && (
                    <span className="text-green-400">
                      ↑ {status.ahead} ahead
                    </span>
                  )}
                  {status.behind > 0 && (
                    <span className="text-red-400">
                      ↓ {status.behind} behind
                    </span>
                  )}
                </div>
              )}

              {/* PR link */}
              {pr && (
                <div className="flex items-center gap-2">
                  <svg
                    className="w-4 h-4 text-[var(--color-text-tertiary)]"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M7.177 3.073L9.573.677A.25.25 0 0110 .854v4.792a.25.25 0 01-.427.177L7.177 3.427a.25.25 0 010-.354zM3.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122v5.256a2.251 2.251 0 11-1.5 0V5.372A2.25 2.25 0 011.5 3.25zM11 2.5h-1V4h1a1 1 0 011 1v5.628a2.251 2.251 0 101.5 0V5A2.5 2.5 0 0011 2.5zm1 10.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0zM3.75 12a.75.75 0 100 1.5.75.75 0 000-1.5z"
                    />
                  </svg>
                  <a
                    href={pr.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="inline-flex items-center gap-1 text-sm text-[var(--color-accent)] hover:text-[#d97a5a] underline decoration-[var(--color-accent-muted)] hover:decoration-[#d97a5a] underline-offset-2"
                  >
                    PR #{pr.number}
                    <svg
                      className="w-3 h-3 shrink-0"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                    >
                      <path
                        fillRule="evenodd"
                        d="M4.25 5.5a.75.75 0 00-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 00.75-.75v-4a.75.75 0 011.5 0v4A2.25 2.25 0 0112.75 17h-8.5A2.25 2.25 0 012 14.75v-8.5A2.25 2.25 0 014.25 4h5a.75.75 0 010 1.5h-5zm7.25-1.25a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-1.5 0V6.31l-5.72 5.72a.75.75 0 11-1.06-1.06l5.72-5.72h-2.69a.75.75 0 01-.75-.75z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </a>
                  {pr.state !== "OPEN" && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-900/50 text-purple-300">
                      {pr.state.toLowerCase()}
                    </span>
                  )}
                </div>
              )}
            </div>

            {/* Changed files list */}
            {status.files && status.files.length > 0 && (
              <div className="border-t border-[var(--color-border-default)] max-h-48 overflow-y-auto">
                {status.files.map((file, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-mono hover:bg-[var(--color-bg-hover)]"
                  >
                    <span
                      className={`shrink-0 w-7 text-right ${fileStatusColor(file.status)}`}
                    >
                      {fileStatusLabel(file.status)}
                    </span>
                    <span
                      className="text-[var(--color-text-secondary)] truncate"
                      title={file.path}
                    >
                      {file.path}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Refresh button */}
            <div className="border-t border-[var(--color-border-default)] p-2">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  fetchStatus();
                  fetchPr();
                }}
                className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] rounded transition-colors"
              >
                <svg
                  className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`}
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                    clipRule="evenodd"
                  />
                </svg>
                Refresh
              </button>
            </div>

            {/* Worktree section */}
            <div className="border-t border-[var(--color-border-default)] p-2">
              {!showWorktreeCreate ? (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowWorktreeCreate(true);
                  }}
                  className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] rounded transition-colors"
                >
                  <svg
                    className="w-3.5 h-3.5"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M8 2a.75.75 0 01.75.75v4.5h4.5a.75.75 0 010 1.5h-4.5v4.5a.75.75 0 01-1.5 0v-4.5h-4.5a.75.75 0 010-1.5h4.5v-4.5A.75.75 0 018 2z"
                    />
                  </svg>
                  New worktree
                </button>
              ) : (
                <div className="space-y-2" onClick={(e) => e.stopPropagation()}>
                  {createError && (
                    <p className="text-xs text-red-400 px-1 select-text">
                      {createError}
                    </p>
                  )}
                  <input
                    type="text"
                    value={newBranch}
                    onChange={(e) => setNewBranch(e.target.value)}
                    placeholder="Branch name..."
                    className="w-full px-2 py-1.5 text-[16px] bg-[var(--color-bg-primary)] border border-[var(--color-border-default)] rounded text-[var(--color-text-primary)] placeholder-[var(--color-text-tertiary)] focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)]"
                    autoFocus
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleCreateWorktree();
                      if (e.key === "Escape") {
                        setShowWorktreeCreate(false);
                        setNewBranch("");
                        setCreateError(null);
                      }
                    }}
                  />

                  {/* Branch suggestions */}
                  {status.branches && status.branches.length > 0 && (
                    <div className="max-h-24 overflow-y-auto">
                      {status.branches
                        .filter(
                          (b) =>
                            b.toLowerCase().includes(newBranch.toLowerCase()) &&
                            b !== status.branch,
                        )
                        .slice(0, 5)
                        .map((b) => (
                          <button
                            key={b}
                            onClick={() => setNewBranch(b)}
                            className="w-full text-left px-2 py-1 text-xs text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)] rounded truncate"
                          >
                            {b}
                          </button>
                        ))}
                    </div>
                  )}

                  <div className="flex gap-1">
                    <button
                      onClick={handleCreateWorktree}
                      disabled={!newBranch.trim() || creating}
                      className="flex-1 px-2 py-1.5 text-xs font-medium bg-[var(--color-accent)] text-white rounded hover:bg-[var(--color-accent-hover)] transition-colors disabled:opacity-40"
                    >
                      {creating ? "Creating..." : "Create"}
                    </button>
                    <button
                      onClick={() => {
                        setShowWorktreeCreate(false);
                        setNewBranch("");
                        setCreateError(null);
                      }}
                      className="px-2 py-1.5 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] rounded transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Delete worktree (only for worktree projects) */}
            {status.isWorktree && (
              <div className="border-t border-[var(--color-border-default)] p-2">
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleDeleteWorktree();
                  }}
                  disabled={deleting}
                  className="w-full flex items-center justify-center gap-2 px-3 py-1.5 text-xs text-red-400 hover:text-red-300 hover:bg-red-900/30 rounded transition-colors disabled:opacity-40"
                >
                  {deleting ? "Deleting..." : "Delete worktree"}
                </button>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
