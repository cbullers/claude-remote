import { useState, useEffect, useMemo, memo } from "react";
import ToolStack from "./ToolStack";
import type { ToolActivity } from "./types";
export type { ToolActivity };

interface StreamingResponseProps {
  thinking?: string;
  activity?: ToolActivity[];
  content?: string;
  isStreaming?: boolean;
  task?: string;
  statusMessage?: string;
  lastEventTime?: number;
  startedAt?: string;
  completedAt?: string;
}

// Format elapsed time
function formatElapsedTime(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const elapsed = Math.floor((end - start) / 1000);

  if (elapsed < 60) return `${elapsed}s`;
  const minutes = Math.floor(elapsed / 60);
  const seconds = elapsed % 60;
  return `${minutes}m ${seconds}s`;
}

// Render inline formatting (bold, italic, code, links)
function renderInline(text: string): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  while (remaining.length > 0) {
    // Bold: **text** or __text__
    const boldMatch = remaining.match(/^(\*\*|__)(.+?)\1/);
    if (boldMatch) {
      parts.push(
        <strong
          key={key++}
          className="font-semibold text-[var(--color-text-primary)]"
        >
          {boldMatch[2]}
        </strong>,
      );
      remaining = remaining.slice(boldMatch[0].length);
      continue;
    }

    // Italic: *text* or _text_
    const italicMatch = remaining.match(/^(\*|_)([^*_]+)\1/);
    if (italicMatch) {
      parts.push(
        <em key={key++} className="italic text-[var(--color-text-secondary)]">
          {italicMatch[2]}
        </em>,
      );
      remaining = remaining.slice(italicMatch[0].length);
      continue;
    }

    // Inline code: `code`
    const codeMatch = remaining.match(/^`([^`]+)`/);
    if (codeMatch) {
      parts.push(
        <code
          key={key++}
          className="px-1.5 py-0.5 bg-[var(--color-bg-primary)] rounded text-sm font-mono text-[#d4a574]"
        >
          {codeMatch[1]}
        </code>,
      );
      remaining = remaining.slice(codeMatch[0].length);
      continue;
    }

    // Link: [text](url)
    const linkMatch = remaining.match(/^\[([^\]]+)\]\(([^)]+)\)/);
    if (linkMatch) {
      parts.push(
        <a
          key={key++}
          href={linkMatch[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:text-[#d97a5a] underline decoration-[var(--color-accent-muted)] hover:decoration-[#d97a5a] underline-offset-2"
        >
          {linkMatch[1]}
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
        </a>,
      );
      remaining = remaining.slice(linkMatch[0].length);
      continue;
    }

    // Bare URL: https://... or http://...
    const urlMatch = remaining.match(/^(https?:\/\/[^\s<>)"']+)/);
    if (urlMatch) {
      const url = urlMatch[1];
      // Clean trailing punctuation that's likely not part of URL
      const cleanUrl = url.replace(/[.,;:!?)]+$/, "");
      const trailingPunct = url.slice(cleanUrl.length);
      // Show shortened display text for long URLs
      const displayUrl =
        cleanUrl.length > 40 ? cleanUrl.slice(0, 35) + "..." : cleanUrl;
      parts.push(
        <a
          key={key++}
          href={cleanUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[var(--color-accent)] hover:text-[#d97a5a] underline decoration-[var(--color-accent-muted)] hover:decoration-[#d97a5a] underline-offset-2 break-all"
        >
          {displayUrl}
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
        </a>,
      );
      if (trailingPunct) parts.push(trailingPunct);
      remaining = remaining.slice(url.length);
      continue;
    }

    // Regular text until next special char or URL
    const nextSpecial = remaining.search(/[*_`[]|https?:\/\//);
    if (nextSpecial === -1) {
      parts.push(remaining);
      break;
    } else if (nextSpecial === 0) {
      // Special char that didn't match a pattern - treat as literal
      parts.push(remaining[0]);
      remaining = remaining.slice(1);
    } else {
      parts.push(remaining.slice(0, nextSpecial));
      remaining = remaining.slice(nextSpecial);
    }
  }

  return parts;
}

// Parse and render markdown-like content
function TextBlock({
  text,
  isStreaming,
}: {
  text: string;
  isStreaming?: boolean;
}) {
  const lines = text.split("\n");
  const elements: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block: ```lang ... ```
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // skip closing ```
      elements.push(
        <div key={key++} className="my-2">
          {lang && (
            <div className="text-xs text-[var(--color-text-tertiary)] mb-1">
              {lang}
            </div>
          )}
          <pre className="p-3 bg-[var(--color-bg-primary)] rounded-lg overflow-x-auto text-sm font-mono text-[var(--color-text-secondary)] border border-[var(--color-border-default)]">
            {codeLines.join("\n")}
          </pre>
        </div>,
      );
      continue;
    }

    // Header: # ## ### etc
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const headerText = headerMatch[2];
      const sizes = [
        "text-xl font-bold",
        "text-lg font-bold",
        "text-base font-semibold",
        "text-sm font-semibold",
      ];
      elements.push(
        <div
          key={key++}
          className={`${sizes[level - 1]} text-[var(--color-text-primary)] mt-3 mb-2`}
        >
          {renderInline(headerText)}
        </div>,
      );
      i++;
      continue;
    }

    // Bullet list: - or * or •
    if (/^[-*•]\s/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^[-*•]\s/.test(lines[i])) {
        listItems.push(lines[i].replace(/^[-*•]\s+/, ""));
        i++;
      }
      elements.push(
        <ul
          key={key++}
          className="list-disc list-inside space-y-1 my-2 text-sm text-[var(--color-text-primary)]"
        >
          {listItems.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }

    // Numbered list: 1. 2. etc
    if (/^\d+\.\s/.test(line)) {
      const listItems: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
        listItems.push(lines[i].replace(/^\d+\.\s+/, ""));
        i++;
      }
      elements.push(
        <ol
          key={key++}
          className="list-decimal list-inside space-y-1 my-2 text-sm text-[var(--color-text-primary)]"
        >
          {listItems.map((item, j) => (
            <li key={j}>{renderInline(item)}</li>
          ))}
        </ol>,
      );
      continue;
    }

    // Empty line = paragraph break
    if (line.trim() === "") {
      i++;
      continue;
    }

    // Regular paragraph - collect consecutive non-empty lines
    const paraLines: string[] = [];
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !lines[i].startsWith("```") &&
      !lines[i].match(/^#{1,4}\s/) &&
      !/^[-*•]\s/.test(lines[i]) &&
      !/^\d+\.\s/.test(lines[i])
    ) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      elements.push(
        <p
          key={key++}
          className="text-sm text-[var(--color-text-primary)] leading-relaxed my-2 break-anywhere"
        >
          {renderInline(paraLines.join(" "))}
        </p>,
      );
    }
  }

  // Add streaming cursor to the last element
  if (isStreaming && elements.length > 0) {
    const cursor = (
      <span
        key="cursor"
        className="inline-block w-2 h-4 bg-[var(--color-accent)] ml-0.5 animate-pulse"
      />
    );
    const last = elements[elements.length - 1];
    // Wrap last element with cursor
    elements[elements.length - 1] = (
      <span key={`last-${key}`} className="contents">
        {last}
        {cursor}
      </span>
    );
  }

  if (elements.length === 0) return null;

  return <div className="space-y-1">{elements}</div>;
}

// Thinking indicator
function ThinkingBlock({
  thinking,
  isStreaming,
}: {
  thinking: string;
  isStreaming?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);

  if (!thinking) return null;

  return (
    <div className="border-l-2 border-[var(--color-border-default)] pl-3 py-1">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 text-xs text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)] transition-colors"
      >
        <span
          className={`transform transition-transform ${expanded ? "rotate-90" : ""}`}
        >
          ▶
        </span>
        <span className="italic">Thinking</span>
        {isStreaming && (
          <span className="w-1.5 h-1.5 bg-[var(--color-text-tertiary)] rounded-full animate-pulse" />
        )}
      </button>
      {expanded && (
        <div className="mt-2 text-xs text-[var(--color-text-tertiary)] italic whitespace-pre-wrap max-h-32 overflow-y-auto">
          {thinking}
        </div>
      )}
    </div>
  );
}

// Live-ticking timer hook
function useTick(enabled: boolean, intervalMs = 1000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [enabled, intervalMs]);
}

// Main streaming response component (text only - tools shown in ToolStack)
export default memo(function StreamingResponse({
  thinking,
  activity = [],
  content,
  isStreaming = false,
  task,
  statusMessage,
  lastEventTime,
  startedAt,
  completedAt,
}: StreamingResponseProps) {
  // Tick every second while streaming so elapsed time + idle warning stay live
  useTick(isStreaming);

  // Calculate elapsed time
  const elapsedTime = startedAt
    ? formatElapsedTime(startedAt, isStreaming ? undefined : completedAt)
    : "";

  // Determine current phase — statusMessage takes priority (e.g. compacting)
  const phase = useMemo(() => {
    if (!isStreaming) return "done";
    if (statusMessage) return "status";
    if (content) return "responding";
    if (activity.length > 0) return "working";
    if (thinking) return "thinking";
    return "starting";
  }, [isStreaming, content, activity.length, thinking, statusMessage]);

  // Format status messages for display
  const statusLabel = useMemo(() => {
    if (!statusMessage) return "";
    const labels: Record<string, string> = {
      compacting: "Compacting context...",
    };
    return labels[statusMessage] || `${statusMessage}...`;
  }, [statusMessage]);

  // Calculate idle time
  const idleSeconds =
    isStreaming && lastEventTime
      ? Math.floor((Date.now() - lastEventTime) / 1000)
      : 0;

  const phaseLabels: Record<string, { label: string; color: string }> = {
    starting: {
      label: "Starting...",
      color: "text-[var(--color-text-secondary)]",
    },
    status: {
      label: statusLabel,
      color: "text-yellow-400",
    },
    thinking: {
      label: "Thinking...",
      color: "text-[var(--color-text-secondary)]",
    },
    working: { label: "Working...", color: "text-[var(--color-accent)]" },
    responding: { label: "Responding...", color: "text-green-400" },
    done: { label: "Done", color: "text-[var(--color-text-tertiary)]" },
  };

  const currentPhase = phaseLabels[phase];

  return (
    <div className="bg-[var(--color-bg-secondary)] rounded-xl border border-[var(--color-border-default)] overflow-hidden min-w-0">
      {/* Header — minimal for historical, shows task name */}
      <div className="px-4 py-2.5 bg-[var(--color-bg-tertiary)] border-b border-[var(--color-border-default)] flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          {isStreaming ? (
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-pulse" />
              <span className={`text-sm font-medium ${currentPhase.color}`}>
                {currentPhase.label}
              </span>
            </div>
          ) : (
            <span className="text-sm text-[var(--color-text-tertiary)]">
              Response
            </span>
          )}
          {task && (
            <span
              className="text-xs text-[var(--color-text-tertiary)] truncate"
              title={task}
            >
              {task.length > 50 ? task.substring(0, 50) + "..." : task}
            </span>
          )}
        </div>
        {elapsedTime && !isStreaming && (
          <span className="text-xs text-[var(--color-text-tertiary)] tabular-nums shrink-0">
            {elapsedTime}
          </span>
        )}
      </div>

      {/* Content area */}
      <div className="p-4 space-y-4 overflow-hidden break-anywhere">
        {/* Thinking (collapsed by default) */}
        {thinking && (
          <ThinkingBlock
            thinking={thinking}
            isStreaming={isStreaming && phase === "thinking"}
          />
        )}

        {/* Response text */}
        {content && (
          <div>
            <TextBlock
              text={content}
              isStreaming={isStreaming && phase === "responding"}
            />
          </div>
        )}

        {/* Loading state when nothing to show yet */}
        {isStreaming && !thinking && !content && (
          <div className="flex items-center justify-center py-4">
            <div className="flex space-x-1">
              <div className="w-2 h-2 bg-[var(--color-text-tertiary)] rounded-full animate-bounce" />
              <div className="w-2 h-2 bg-[var(--color-text-tertiary)] rounded-full animate-bounce [animation-delay:0.1s]" />
              <div className="w-2 h-2 bg-[var(--color-text-tertiary)] rounded-full animate-bounce [animation-delay:0.2s]" />
            </div>
          </div>
        )}
      </div>

      {/* Tool activity (shown for both streaming and historical messages) */}
      {activity && activity.length > 0 && (
        <ToolStack activity={activity} isStreaming={isStreaming} />
      )}

    </div>
  );
});

// Pinned status bar — rendered outside the scroll container in Chat.tsx
export function StreamingStatusBar({
  statusMessage,
  lastEventTime,
  startedAt,
  thinking,
  content,
  activityCount,
}: {
  statusMessage: string;
  lastEventTime: number;
  startedAt: number | null;
  thinking: string;
  content: string;
  activityCount: number;
}) {
  useTick(true);

  const elapsedTime = startedAt
    ? formatElapsedTime(new Date(startedAt).toISOString())
    : "";

  const phase = (() => {
    if (statusMessage) return "status";
    if (content) return "responding";
    if (activityCount > 0) return "working";
    if (thinking) return "thinking";
    return "starting";
  })();

  const statusLabel = (() => {
    if (!statusMessage) return "";
    const labels: Record<string, string> = {
      compacting: "Compacting context...",
    };
    return labels[statusMessage] || `${statusMessage}...`;
  })();

  const phaseLabels: Record<string, { label: string; color: string }> = {
    starting: {
      label: "Starting...",
      color: "text-[var(--color-text-secondary)]",
    },
    status: { label: statusLabel, color: "text-yellow-400" },
    thinking: {
      label: "Thinking...",
      color: "text-[var(--color-text-secondary)]",
    },
    working: { label: "Working...", color: "text-[var(--color-accent)]" },
    responding: { label: "Responding...", color: "text-green-400" },
  };

  const currentPhase = phaseLabels[phase];

  const idleSeconds = lastEventTime
    ? Math.floor((Date.now() - lastEventTime) / 1000)
    : 0;

  return (
    <div className="px-3 py-1.5 bg-[var(--color-bg-tertiary)] border-b border-[var(--color-border-default)] flex items-center justify-between gap-2">
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-2 h-2 bg-[var(--color-accent)] rounded-full animate-pulse shrink-0" />
        <span
          className={`text-xs font-medium ${currentPhase.color} truncate`}
        >
          {currentPhase.label}
        </span>
        {idleSeconds >= 30 && (
          <span className="text-xs text-yellow-400 shrink-0">
            No activity {idleSeconds}s
          </span>
        )}
      </div>
      <span className="text-xs text-[var(--color-text-tertiary)] tabular-nums shrink-0">
        {elapsedTime}
      </span>
    </div>
  );
}
