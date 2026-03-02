import { useState, useRef, useEffect } from "react";

export interface WorktreeInfo {
  isWorktree: true;
  parentRepoId: string;
  branch: string;
  mainWorktreePath: string;
}

export interface Project {
  id: string;
  path: string;
  name: string;
  lastAccessed?: string;
  worktree?: WorktreeInfo;
}

interface ProjectTabsProps {
  projects: Project[];
  activeProjectId: string | null;
  streamingProjectIds: Set<string>;
  onSelectProject: (projectId: string) => void;
  onCloseProject: (projectId: string) => void;
  onAddProject: () => void;
}

export default function ProjectTabs({
  projects,
  activeProjectId,
  streamingProjectIds,
  onSelectProject,
  onCloseProject,
  onAddProject,
}: ProjectTabsProps) {
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const activeProject = projects.find((p) => p.id === activeProjectId);
  const activeIsStreaming = activeProjectId
    ? streamingProjectIds.has(activeProjectId)
    : false;
  const otherStreaming = projects.some(
    (p) => p.id !== activeProjectId && streamingProjectIds.has(p.id),
  );

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (
        dropdownRef.current &&
        !dropdownRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  const displayName = activeProject
    ? activeProject.worktree
      ? activeProject.worktree.branch
      : activeProject.name
    : "Select a project";

  return (
    <div ref={dropdownRef} className="relative">
      {/* Trigger button */}
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 min-w-0 max-w-[60vw]"
      >
        {/* Streaming indicator */}
        {activeIsStreaming && (
          <span className="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-pulse shrink-0" />
        )}
        {/* Other projects streaming indicator */}
        {!activeIsStreaming && otherStreaming && (
          <span className="w-2 h-2 bg-[var(--color-text-tertiary)] rounded-full animate-pulse shrink-0" />
        )}

        <span className="text-lg font-semibold truncate">{displayName}</span>

        {/* Chevron */}
        <svg
          className={`w-4 h-4 shrink-0 text-[var(--color-text-tertiary)] transition-transform ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>

        {/* Project count badge */}
        {projects.length > 1 && (
          <span className="text-xs text-[var(--color-text-tertiary)] tabular-nums">
            {projects.length}
          </span>
        )}
      </button>

      {/* Dropdown */}
      {open && (
        <div className="absolute top-full left-0 mt-1 w-72 max-h-[60vh] overflow-y-auto z-50 rounded-lg border border-[var(--color-border-default)] bg-[var(--color-bg-secondary)] shadow-lg">
          {/* Open projects */}
          {projects.map((project) => {
            const isActive = project.id === activeProjectId;
            const isStreaming = streamingProjectIds.has(project.id);
            const name = project.worktree
              ? project.worktree.branch
              : project.name;

            return (
              <div
                key={project.id}
                className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors ${
                  isActive
                    ? "bg-[var(--color-accent)]/10 border-l-2 border-l-[var(--color-accent)]"
                    : "hover:bg-[var(--color-bg-hover)] border-l-2 border-l-transparent"
                }`}
                onClick={() => {
                  onSelectProject(project.id);
                  setOpen(false);
                }}
              >
                {/* Streaming indicator */}
                {isStreaming && (
                  <span className="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-pulse shrink-0" />
                )}

                {/* Worktree icon */}
                {project.worktree && (
                  <svg
                    className="w-3.5 h-3.5 shrink-0 text-[var(--color-text-tertiary)]"
                    viewBox="0 0 16 16"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M11.75 2.5a.75.75 0 100 1.5.75.75 0 000-1.5zm-2.25.75a2.25 2.25 0 113 2.122V6A2.5 2.5 0 0110 8.5H6a1 1 0 00-1 1v1.128a2.251 2.251 0 11-1.5 0V5.372a2.25 2.25 0 111.5 0v1.836A2.492 2.492 0 016 7h4a1 1 0 001-1v-.628A2.25 2.25 0 019.5 3.25zM4.25 12a.75.75 0 100 1.5.75.75 0 000-1.5zM3.5 3.25a.75.75 0 111.5 0 .75.75 0 01-1.5 0z"
                    />
                  </svg>
                )}

                {/* Name */}
                <span
                  className={`text-sm truncate flex-1 ${isActive ? "font-medium text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}
                >
                  {name}
                </span>

                {/* Close button */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseProject(project.id);
                  }}
                  className="shrink-0 p-1 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-border-emphasis)] transition-colors"
                  title="Close project"
                  aria-label={`Close ${name}`}
                >
                  <svg
                    className="h-3.5 w-3.5"
                    viewBox="0 0 20 20"
                    fill="currentColor"
                  >
                    <path
                      fillRule="evenodd"
                      d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                      clipRule="evenodd"
                    />
                  </svg>
                </button>
              </div>
            );
          })}

          {/* Divider + Open project */}
          <div className="border-t border-[var(--color-border-default)]">
            <button
              onClick={() => {
                onAddProject();
                setOpen(false);
              }}
              className="w-full flex items-center gap-2 px-3 py-2.5 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] transition-colors"
            >
              <svg
                className="h-4 w-4 shrink-0"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M10 3a1 1 0 011 1v5h5a1 1 0 110 2h-5v5a1 1 0 11-2 0v-5H4a1 1 0 110-2h5V4a1 1 0 011-1z"
                  clipRule="evenodd"
                />
              </svg>
              Open project...
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
