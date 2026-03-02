import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import type { ToolActivity } from "./types";

// Tool category colors and icons
const toolConfig: Record<
  string,
  { icon: string; color: string; bg: string; border: string }
> = {
  Read: {
    icon: "📄",
    color: "text-cyan-400",
    bg: "bg-cyan-950/30",
    border: "border-cyan-500/50",
  },
  Write: {
    icon: "✏️",
    color: "text-green-400",
    bg: "bg-green-950/30",
    border: "border-green-500/50",
  },
  Edit: {
    icon: "🔧",
    color: "text-green-400",
    bg: "bg-green-950/30",
    border: "border-green-500/50",
  },
  Bash: {
    icon: "💻",
    color: "text-yellow-400",
    bg: "bg-yellow-950/30",
    border: "border-yellow-500/50",
  },
  Glob: {
    icon: "🔍",
    color: "text-purple-400",
    bg: "bg-purple-950/30",
    border: "border-purple-500/50",
  },
  Grep: {
    icon: "🔎",
    color: "text-purple-400",
    bg: "bg-purple-950/30",
    border: "border-purple-500/50",
  },
  Task: {
    icon: "🤖",
    color: "text-blue-400",
    bg: "bg-blue-950/30",
    border: "border-blue-500/50",
  },
  WebFetch: {
    icon: "🌐",
    color: "text-blue-400",
    bg: "bg-blue-950/30",
    border: "border-blue-500/50",
  },
  WebSearch: {
    icon: "🔍",
    color: "text-blue-400",
    bg: "bg-blue-950/30",
    border: "border-blue-500/50",
  },
  TodoWrite: {
    icon: "📝",
    color: "text-orange-400",
    bg: "bg-orange-950/30",
    border: "border-orange-500/50",
  },
  AskUserQuestion: {
    icon: "❓",
    color: "text-pink-400",
    bg: "bg-pink-950/30",
    border: "border-pink-500/50",
  },
};

const defaultToolConfig = {
  icon: "⚙️",
  color: "text-[var(--color-text-secondary)]",
  bg: "bg-[var(--color-bg-secondary)]",
  border: "border-[var(--color-border-default)]",
};

function getToolConfig(tool: string) {
  return toolConfig[tool] || defaultToolConfig;
}

// Format timestamp as relative time or HH:MM:SS
function formatTimestamp(timestamp: number): string {
  const now = Date.now();
  const diff = Math.floor((now - timestamp) / 1000);

  if (diff < 5) return "now";
  if (diff < 60) return `${diff}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;

  // Fall back to absolute time
  const date = new Date(timestamp);
  return date.toLocaleTimeString("en-US", { hour12: false });
}

// Format running duration for active tools
function formatRunningTime(timestamp: number): string {
  const elapsed = Math.floor((Date.now() - timestamp) / 1000);
  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m ${seconds}s`;
}

// Parse activity into paired tool uses and results
function parseActivityPairs(activity: ToolActivity[]) {
  const pairs: Array<{
    tool: string;
    input: Record<string, unknown>;
    result?: { output?: string; error?: string };
    timestamp: number;
  }> = [];

  let pendingToolUse: {
    tool: string;
    input: Record<string, unknown>;
    timestamp: number;
  } | null = null;

  for (const item of activity) {
    if (item.type === "tool_use") {
      if (pendingToolUse) {
        pairs.push(pendingToolUse);
      }
      pendingToolUse = {
        tool: item.tool,
        input: item.input || {},
        timestamp: item.timestamp,
      };
    } else if (item.type === "tool_result" && pendingToolUse) {
      pairs.push({
        ...pendingToolUse,
        result: { output: item.output, error: item.error },
      });
      pendingToolUse = null;
    }
  }

  if (pendingToolUse) {
    pairs.push(pendingToolUse);
  }

  return pairs;
}

// Fullscreen detail modal for tool use
function ToolDetailModal({
  tool,
  input,
  result,
  timestamp,
  onClose,
}: {
  tool: string;
  input: Record<string, unknown>;
  result?: { output?: string; error?: string };
  timestamp: number;
  onClose: () => void;
}) {
  const config = getToolConfig(tool);

  // Close on Escape key
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = "";
    };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex flex-col bg-black/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex-1 flex flex-col m-2 sm:m-4 rounded-xl border border-[var(--color-border-default)] bg-[var(--color-bg-primary)] overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[var(--color-border-default)] bg-[var(--color-bg-tertiary)] shrink-0">
          <span className="text-lg">{config.icon}</span>
          <span className={`font-semibold text-sm ${config.color}`}>
            {tool}
          </span>
          {!!input.file_path && (
            <span className="text-xs text-[var(--color-text-secondary)] font-mono truncate">
              {String(input.file_path)}
            </span>
          )}
          <div className="flex-1" />
          {result?.error ? (
            <span className="text-xs text-red-400 font-medium">Error</span>
          ) : result ? (
            <span className="text-xs text-green-400 font-medium">Done</span>
          ) : (
            <span className="text-xs text-[var(--color-accent)] font-medium">
              Running...
            </span>
          )}
          <span className="text-xs text-[var(--color-text-tertiary)] tabular-nums">
            {formatTimestamp(timestamp)}
          </span>
          <button
            onClick={onClose}
            className="ml-2 text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors text-xl leading-none px-1"
          >
            ×
          </button>
        </div>

        {/* Modal body - scrollable */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 text-sm">
          {/* Edit diff view */}
          {tool === "Edit" && !!input.old_string && (
            <div className="space-y-4">
              <div>
                <div className="text-red-400 mb-2 flex items-center gap-1 font-medium text-xs">
                  <span className="font-bold">−</span> Removed
                </div>
                <pre className="p-3 bg-red-950/40 border-l-2 border-red-500 rounded-lg text-red-200 whitespace-pre-wrap overflow-x-auto">
                  {String(input.old_string)}
                </pre>
              </div>
              <div>
                <div className="text-green-400 mb-2 flex items-center gap-1 font-medium text-xs">
                  <span className="font-bold">+</span> Added
                </div>
                <pre className="p-3 bg-green-950/40 border-l-2 border-green-500 rounded-lg text-green-200 whitespace-pre-wrap overflow-x-auto">
                  {String(input.new_string || "")}
                </pre>
              </div>
            </div>
          )}

          {/* Write content */}
          {tool === "Write" && Boolean(input.content) && (
            <div>
              <div className="text-green-400 mb-2 font-medium text-xs">
                Content
              </div>
              <pre className="p-3 bg-green-950/40 border-l-2 border-green-500 rounded-lg text-green-200 whitespace-pre-wrap overflow-x-auto">
                {String(input.content)}
              </pre>
            </div>
          )}

          {/* Bash command */}
          {tool === "Bash" && Boolean(input.command) && (
            <div>
              <div className="text-yellow-400 mb-2 font-medium text-xs">
                Command
              </div>
              <pre className="p-3 bg-[#111] rounded-lg text-yellow-200 font-mono whitespace-pre-wrap overflow-x-auto">
                <span className="text-yellow-500">$</span>{" "}
                {String(input.command)}
              </pre>
            </div>
          )}

          {/* Read - just show file path */}
          {tool === "Read" && Boolean(input.file_path) && !input.content && (
            <div>
              <div className="text-cyan-400 mb-2 font-medium text-xs">File</div>
              <pre className="p-3 bg-[#111] rounded-lg text-cyan-200 font-mono">
                {String(input.file_path)}
              </pre>
            </div>
          )}

          {/* Generic input for other tools */}
          {!["Read", "Write", "Edit", "Bash"].includes(tool) &&
            Object.keys(input).length > 0 && (
              <div>
                <div className="text-[var(--color-text-secondary)] mb-2 font-medium text-xs">
                  Input
                </div>
                <pre className="p-3 bg-[var(--color-bg-secondary)] rounded-lg text-[var(--color-text-secondary)] whitespace-pre-wrap overflow-x-auto">
                  {JSON.stringify(input, null, 2)}
                </pre>
              </div>
            )}

          {/* Result output */}
          {result?.output && (
            <div>
              <div className="text-[var(--color-text-secondary)] mb-2 font-medium text-xs">
                Output
              </div>
              <pre className="p-3 bg-[var(--color-bg-secondary)] rounded-lg text-[var(--color-text-secondary)] whitespace-pre-wrap overflow-x-auto">
                {result.output}
              </pre>
            </div>
          )}

          {/* Error */}
          {result?.error && (
            <div>
              <div className="text-red-400 mb-2 font-medium text-xs">Error</div>
              <div className="text-red-400 bg-red-950/30 p-3 rounded-lg whitespace-pre-wrap">
                {result.error}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// Compact tool card for the stack
function StackToolCard({
  tool,
  input,
  result,
  timestamp,
  isLatest,
  onOpenDetail,
}: {
  tool: string;
  input: Record<string, unknown>;
  result?: { output?: string; error?: string };
  timestamp: number;
  isLatest?: boolean;
  onOpenDetail: () => void;
}) {
  const config = getToolConfig(tool);

  // Get a summary based on tool type
  const getSummary = () => {
    if (["Read", "Write", "Edit"].includes(tool) && input.file_path) {
      return String(input.file_path).split("/").slice(-2).join("/");
    }
    if (tool === "Bash" && input.command) {
      const cmd = String(input.command);
      return cmd.length > 40 ? cmd.substring(0, 40) + "..." : cmd;
    }
    if (["Glob", "Grep"].includes(tool) && input.pattern) {
      return String(input.pattern).substring(0, 30);
    }
    if (tool === "WebSearch" && input.query) {
      return `"${String(input.query).substring(0, 30)}"`;
    }
    if (tool === "Task" && input.prompt) {
      return String(input.prompt).substring(0, 40) + "...";
    }
    return null;
  };

  const summary = getSummary();

  return (
    <div
      className={`rounded-lg border ${config.border} ${config.bg} overflow-hidden ${isLatest ? "ring-1 ring-[var(--color-accent)]/50" : ""}`}
    >
      <button
        onClick={onOpenDetail}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-white/5 transition-colors"
      >
        <span className="text-base">{config.icon}</span>
        <span className={`font-medium text-xs ${config.color}`}>{tool}</span>
        {summary && (
          <span className="text-xs text-[var(--color-text-secondary)] truncate flex-1 font-mono">
            {summary}
          </span>
        )}
        {!summary && <div className="flex-1" />}

        {/* Status indicator + timing */}
        {result?.error ? (
          <span className="text-xs text-red-400">err</span>
        ) : result ? (
          <span className="text-xs text-green-400">ok</span>
        ) : isLatest ? (
          <>
            <span className="w-1.5 h-1.5 bg-[var(--color-accent)] rounded-full animate-pulse" />
            <span className={`text-xs tabular-nums ${Math.floor((Date.now() - timestamp) / 1000) >= 60 ? "text-yellow-400" : "text-[var(--color-accent)]"}`}>
              {formatRunningTime(timestamp)}
            </span>
          </>
        ) : null}

        {/* Timestamp (for completed tools) */}
        {(result || !isLatest) && (
          <span className="text-xs text-[var(--color-text-tertiary)] tabular-nums">
            {formatTimestamp(timestamp)}
          </span>
        )}

        {/* Detail arrow */}
        <span className="text-xs text-[var(--color-text-tertiary)]">▶</span>
      </button>
    </div>
  );
}

interface ToolStackProps {
  activity: ToolActivity[];
  isStreaming: boolean;
}

export default function ToolStack({ activity, isStreaming }: ToolStackProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const toolPairs = parseActivityPairs(activity).filter(
    (pair) => pair.tool !== "AskUserQuestion",
  );
  const [modalIndex, setModalIndex] = useState<number | null>(null);
  const [, setTick] = useState(0);

  const closeModal = useCallback(() => setModalIndex(null), []);

  // Tick every second while streaming so active tool elapsed time updates
  useEffect(() => {
    if (!isStreaming) return;
    const id = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(id);
  }, [isStreaming]);

  // Auto-scroll to bottom when new tools arrive
  useEffect(() => {
    if (scrollRef.current && toolPairs.length > 0) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [toolPairs.length]);

  // Don't render if no tools
  if (toolPairs.length === 0) {
    return null;
  }

  const modalPair = modalIndex !== null ? toolPairs[modalIndex] : null;

  return (
    <div className="border-t border-[var(--color-border-default)] bg-[var(--color-bg-primary)]/80">
      {/* Header */}
      <div className="px-3 py-1.5 flex items-center gap-2 border-b border-[var(--color-border-subtle)]">
        <span className="text-xs text-[var(--color-text-tertiary)] font-medium">
          Tools
        </span>
        <span className="text-xs text-[var(--color-text-muted)] tabular-nums">
          ({toolPairs.filter((p) => p.result).length}/{toolPairs.length})
        </span>
        {isStreaming && (
          <span className="w-1.5 h-1.5 bg-[var(--color-accent)] rounded-full animate-pulse" />
        )}
      </div>

      {/* Scrollable tool list */}
      <div
        ref={scrollRef}
        className="max-h-[30vh] overflow-y-auto px-3 py-2 space-y-1.5"
      >
        {toolPairs.map((pair, i) => (
          <StackToolCard
            key={i}
            tool={pair.tool}
            input={pair.input}
            result={pair.result}
            timestamp={pair.timestamp}
            isLatest={isStreaming && i === toolPairs.length - 1 && !pair.result}
            onOpenDetail={() => setModalIndex(i)}
          />
        ))}
      </div>

      {/* Detail modal */}
      {modalPair && (
        <ToolDetailModal
          tool={modalPair.tool}
          input={modalPair.input}
          result={modalPair.result}
          timestamp={modalPair.timestamp}
          onClose={closeModal}
        />
      )}
    </div>
  );
}
