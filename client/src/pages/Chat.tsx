import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import ProjectTabs, { type Project } from "../components/ProjectTabs";
import ProjectPicker from "../components/ProjectPicker";
import StreamingResponse, {
  StreamingStatusBar,
  type ToolActivity,
} from "../components/StreamingResponse";
import ChatInput from "../components/ChatInput";
import GitStatus from "../components/GitStatus";
import FileTree from "../components/FileTree";
import DiffViewer from "../components/DiffViewer";
import AskUserQuestionCard from "../components/AskUserQuestionCard";
import { apiFetch } from "../lib/api";
import {
  importPublicKey,
  deriveSharedSecret,
  encrypt,
  decrypt,
  type EncryptedData,
} from "../lib/crypto-client";
import {
  type ServerConfig,
  getServerPin,
  setServerPin,
  clearServerPin,
} from "../lib/servers";
import {
  registerServiceWorker,
  subscribeToPush,
  isPushSupported,
  getPushPermission,
} from "../lib/push-client";
import { useWakeLock } from "../lib/wake-lock";

interface Props {
  serverConfig: ServerConfig;
  onNavigate: (route: "servers" | "chat") => void;
}

interface OutputChunk {
  text: string;
  timestamp: number;
  afterTool?: string;
}

interface Message {
  role: "user" | "assistant";
  content: string;
  task?: string;
  chunks?: OutputChunk[];
  thinking?: string;
  activity?: ToolActivity[];
  startedAt?: string;
  completedAt?: string;
}

interface ConversationInfo {
  id: string;
  name: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

type View = "pin" | "chat";

interface PendingQuestionData {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
}

interface ProjectState {
  messages: Message[];
  isStreaming: boolean;
  isLoadingHistory: boolean;
  currentThinking: string;
  currentResponse: string;
  currentActivity: ToolActivity[];
  currentTask: string;
  taskStartTime: number | null;
  pendingQuestion: PendingQuestionData | null;
  statusMessage: string;
  lastEventTime: number;
}

interface ConversationSwitcherProps {
  conversations: ConversationInfo[];
  activeConversationId: string;
  streamingConversationIds: Set<string>;
  onSwitch: (id: string) => void;
  onNew: () => void;
  onDelete: (id: string) => void;
  onRename: (id: string, name: string) => void;
  isOpen: boolean;
  onToggle: () => void;
}

function ConversationSwitcher({
  conversations,
  activeConversationId,
  streamingConversationIds,
  onSwitch,
  onNew,
  onDelete,
  onRename,
  isOpen,
  onToggle,
}: ConversationSwitcherProps) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const editInputRef = useRef<HTMLInputElement>(null);
  const activeConv = conversations.find((c) => c.id === activeConversationId);
  const displayName = activeConv?.name || "Default";
  const activeIsStreaming = streamingConversationIds.has(activeConversationId);
  const anyStreaming = streamingConversationIds.size > 0;

  const startRename = (conv: ConversationInfo, e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingId(conv.id);
    setEditName(conv.name);
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const commitRename = () => {
    if (editingId && editName.trim() && editName.trim() !== conversations.find(c => c.id === editingId)?.name) {
      onRename(editingId, editName.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="relative">
      <button
        onClick={onToggle}
        className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded-md transition-colors ${
          activeIsStreaming
            ? "text-[var(--color-text-primary)] bg-[var(--color-accent)]/15 ring-1 ring-[var(--color-accent)]/30"
            : "text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] bg-[var(--color-bg-secondary)]"
        }`}
        title="Switch conversation"
      >
        {anyStreaming ? (
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-green-500" />
          </span>
        ) : (
          <svg
            className="w-3.5 h-3.5"
            viewBox="0 0 20 20"
            fill="currentColor"
          >
            <path
              fillRule="evenodd"
              d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
              clipRule="evenodd"
            />
          </svg>
        )}
        <span className="truncate max-w-[100px]">{displayName}</span>
        <svg
          className={`w-3 h-3 transition-transform ${isOpen ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path
            fillRule="evenodd"
            d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {isOpen && (
        <>
          <div className="fixed inset-0 z-40" onClick={onToggle} />
          <div className="absolute left-0 top-full mt-1 z-50 w-64 max-h-[50vh] overflow-y-auto bg-[var(--color-bg-secondary)] border border-[var(--color-border-default)] rounded-lg shadow-xl">
            {conversations.map((conv) => {
              const isActive = conv.id === activeConversationId;
              const isConvStreaming = streamingConversationIds.has(conv.id);
              return (
                <div
                  key={conv.id}
                  className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer transition-colors ${
                    isConvStreaming && isActive
                      ? "bg-green-500/15 border-l-2 border-l-green-500"
                      : isConvStreaming
                        ? "bg-green-500/8 border-l-2 border-l-green-500/60"
                        : isActive
                          ? "bg-[var(--color-accent)]/10 border-l-2 border-l-[var(--color-accent)]"
                          : "hover:bg-[var(--color-bg-hover)] border-l-2 border-l-transparent"
                  }`}
                  onClick={() => onSwitch(conv.id)}
                >
                  <div className="flex-1 min-w-0">
                    {editingId === conv.id ? (
                      <input
                        ref={editInputRef}
                        type="text"
                        value={editName}
                        onChange={(e) => setEditName(e.target.value)}
                        onBlur={commitRename}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") commitRename();
                          if (e.key === "Escape") setEditingId(null);
                        }}
                        onClick={(e) => e.stopPropagation()}
                        className="w-full text-sm bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] border border-[var(--color-accent)] rounded px-1.5 py-0.5 outline-none"
                      />
                    ) : (
                      <>
                        <div className="flex items-center gap-1.5">
                          {isConvStreaming && (
                            <span className="relative flex h-1.5 w-1.5 shrink-0">
                              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-green-400 opacity-75" />
                              <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-green-500" />
                            </span>
                          )}
                          <span
                            className={`text-sm truncate ${isActive ? "font-medium text-[var(--color-text-primary)]" : "text-[var(--color-text-secondary)]"}`}
                          >
                            {conv.name}
                          </span>
                        </div>
                        <div className={`text-xs ${isConvStreaming ? "text-green-400/80" : "text-[var(--color-text-tertiary)]"}`}>
                          {isConvStreaming ? "Responding..." : `${conv.messageCount} messages`}
                        </div>
                      </>
                    )}
                  </div>
                  {editingId !== conv.id && (
                    <div className="flex items-center gap-0.5 shrink-0">
                      <button
                        onClick={(e) => startRename(conv, e)}
                        className="p-1 rounded text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
                        title="Rename conversation"
                      >
                        <svg className="h-3 w-3" viewBox="0 0 20 20" fill="currentColor">
                          <path d="M13.586 3.586a2 2 0 112.828 2.828l-.793.793-2.828-2.828.793-.793zM11.379 5.793L3 14.172V17h2.828l8.38-8.379-2.83-2.828z" />
                        </svg>
                      </button>
                      {conv.id !== "default" && !isConvStreaming && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            onDelete(conv.id);
                          }}
                          className="p-1 rounded text-[var(--color-text-tertiary)] hover:text-red-400 transition-colors"
                          title="Delete conversation"
                        >
                          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
                            <path
                              fillRule="evenodd"
                              d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
                              clipRule="evenodd"
                            />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}

            <div className="border-t border-[var(--color-border-default)]">
              <button
                onClick={onNew}
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
                New Chat
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

interface OverflowMenuProps {
  onBrowseFiles: () => void;
  onViewChanges: () => void;
  onReset: () => void;
  onClearHistory: () => void;
  onNewChat: () => void;
  onSwitchServer: () => void;
  hasProject: boolean;
  canClear: boolean;
  serverName: string;
}

function OverflowMenu({
  onBrowseFiles,
  onViewChanges,
  onReset,
  onClearHistory,
  onNewChat,
  onSwitchServer,
  hasProject,
  canClear,
  serverName,
}: OverflowMenuProps) {
  const [open, setOpen] = useState(false);

  const menuItem = (
    onClick: () => void,
    icon: React.ReactNode,
    label: string,
    disabled = false,
  ) => (
    <button
      onClick={() => {
        onClick();
        setOpen(false);
      }}
      disabled={disabled}
      className="w-full flex items-center gap-3 px-4 py-3 text-sm text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)] active:bg-[var(--color-bg-hover)] transition-colors disabled:opacity-40 disabled:pointer-events-none"
    >
      <span className="text-[var(--color-text-secondary)]">{icon}</span>
      {label}
    </button>
  );

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="shrink-0 p-2 text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
        title="More actions"
        aria-label="More actions"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          className="h-5 w-5"
          viewBox="0 0 20 20"
          fill="currentColor"
        >
          <path d="M6 10a2 2 0 11-4 0 2 2 0 014 0zM12 10a2 2 0 11-4 0 2 2 0 014 0zM16 12a2 2 0 100-4 2 2 0 000 4z" />
        </svg>
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-full mt-1 z-50 w-52 bg-[var(--color-bg-secondary)] border border-[var(--color-border-default)] rounded-lg shadow-xl overflow-hidden">
            {hasProject &&
              menuItem(
                onBrowseFiles,
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                </svg>,
                "Browse files",
              )}
            {hasProject &&
              menuItem(
                onViewChanges,
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 16 16"
                  fill="currentColor"
                >
                  <path d="M8 4a.5.5 0 01.5.5v3h3a.5.5 0 010 1h-3v3a.5.5 0 01-1 0v-3h-3a.5.5 0 010-1h3v-3A.5.5 0 018 4z" />
                  <path d="M13.5 0H2.5A2.5 2.5 0 000 2.5v11A2.5 2.5 0 002.5 16h11a2.5 2.5 0 002.5-2.5v-11A2.5 2.5 0 0013.5 0zM1 2.5A1.5 1.5 0 012.5 1H8v6.5H1V2.5zM1 8.5h7V15H2.5A1.5 1.5 0 011 13.5V8.5zM9 15V8.5h6v5a1.5 1.5 0 01-1.5 1.5H9zm6-7.5H9V1h4.5A1.5 1.5 0 0115 2.5v5z" />
                </svg>,
                "View changes",
              )}
            {hasProject &&
              menuItem(
                onNewChat,
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10c0 3.866-3.582 7-8 7a8.841 8.841 0 01-4.083-.98L2 17l1.338-3.123C2.493 12.767 2 11.434 2 10c0-3.866 3.582-7 8-7s8 3.134 8 7zM7 9H5v2h2V9zm8 0h-2v2h2V9zM9 9h2v2H9V9z"
                    clipRule="evenodd"
                  />
                </svg>,
                "New chat",
              )}
            {menuItem(
              onReset,
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
                  clipRule="evenodd"
                />
              </svg>,
              "Reset state",
            )}
            {menuItem(
              onClearHistory,
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>,
              "Clear history",
              !canClear,
            )}

            <div className="border-t border-[var(--color-border-default)]" />

            {menuItem(
              onSwitchServer,
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path
                  fillRule="evenodd"
                  d="M2 5a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2V5zm14 1a1 1 0 11-2 0 1 1 0 012 0zM2 13a2 2 0 012-2h12a2 2 0 012 2v2a2 2 0 01-2 2H4a2 2 0 01-2-2v-2zm14 1a1 1 0 11-2 0 1 1 0 012 0z"
                  clipRule="evenodd"
                />
              </svg>,
              serverName,
            )}
          </div>
        </>
      )}
    </div>
  );
}

function createEmptyProjectState(): ProjectState {
  return {
    messages: [],
    isStreaming: false,
    isLoadingHistory: false,
    currentThinking: "",
    currentResponse: "",
    currentActivity: [],
    currentTask: "",
    taskStartTime: null,
    pendingQuestion: null,
    statusMessage: "",
    lastEventTime: 0,
  };
}

export default function Chat({ serverConfig, onNavigate }: Props) {
  // Server-scoped localStorage keys
  const projectsKey = `claude-remote-projects-${serverConfig.id}`;
  const activeProjectKey = `claude-remote-active-project-${serverConfig.id}`;

  const [view, setView] = useState<View>(() => {
    const cached = getServerPin(serverConfig.id);
    return cached ? "chat" : "pin";
  });
  const [pin, setPin] = useState("");
  const [error, setError] = useState("");

  // Multi-project state
  const [openProjects, setOpenProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [projectStates, setProjectStates] = useState<Map<string, ProjectState>>(
    new Map(),
  );
  const [streamingProjectIds, setStreamingProjectIds] = useState<Set<string>>(
    new Set(),
  );
  const [showProjectPicker, setShowProjectPicker] = useState(false);
  const [showFileTree, setShowFileTree] = useState(false);
  const [showDiffViewer, setShowDiffViewer] = useState(false);
  const [showPushBanner, setShowPushBanner] = useState(false);
  const [tokenExpiryDismissed, setTokenExpiryDismissed] = useState(false);
  const tokenExpiresAt = serverConfig.tokenExpiresAt || null;
  const tabsRestoredRef = useRef(false);

  // Multi-conversation state (per project)
  const [activeConversationIds, setActiveConversationIds] = useState<
    Map<string, string>
  >(new Map());
  const [conversationLists, setConversationLists] = useState<
    Map<string, ConversationInfo[]>
  >(new Map());
  const [showConversationList, setShowConversationList] = useState(false);

  // Helper to get composite state key for project+conversation
  const stateKey = useCallback(
    (projectId: string, conversationId?: string) => {
      const convId =
        conversationId || activeConversationIds.get(projectId) || "default";
      return `${projectId}:${convId}`;
    },
    [activeConversationIds],
  );

  // Get the active conversation ID for the active project
  const activeConversationId = activeProjectId
    ? activeConversationIds.get(activeProjectId) || "default"
    : "default";

  // Refs for streaming (per-project:conversation)
  const thinkingRefs = useRef<Map<string, string>>(new Map());
  const responseRefs = useRef<Map<string, string>>(new Map());
  const activityRefs = useRef<Map<string, ToolActivity[]>>(new Map());

  const wsRef = useRef<WebSocket | null>(null);
  const sharedKeyRef = useRef<CryptoKey | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // Reconnection state
  const [isReconnecting, setIsReconnecting] = useState(false);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [showReconnectedBanner, setShowReconnectedBanner] = useState(false);
  const reconnectAttemptRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cachedPinRef = useRef<string | null>(null);
  const intentionalCloseRef = useRef(false);

  // Initialize cached PIN from server-specific storage
  if (cachedPinRef.current === null) {
    const stored = getServerPin(serverConfig.id);
    cachedPinRef.current = stored?.pin || null;
  }

  // Helper to update project state
  const updateProjectState = useCallback(
    (projectId: string, updater: (state: ProjectState) => ProjectState) => {
      setProjectStates((prev) => {
        const current = prev.get(projectId) || createEmptyProjectState();
        const updated = updater(current);
        const next = new Map(prev);
        next.set(projectId, updated);
        return next;
      });
    },
    [],
  );

  // Current active project state (keyed by projectId:conversationId)
  const activeStateKey = activeProjectId
    ? stateKey(activeProjectId, activeConversationId)
    : null;
  const activeState =
    (activeStateKey ? projectStates.get(activeStateKey) : null) ||
    createEmptyProjectState();
  const messages = activeState.messages;
  const isStreaming = activeState.isStreaming;
  const isLoadingHistory = activeState.isLoadingHistory;
  const currentThinking = activeState.currentThinking;
  const currentResponse = activeState.currentResponse;
  const currentActivity = activeState.currentActivity;
  const currentTask = activeState.currentTask;
  const taskStartTime = activeState.taskStartTime;
  const statusMessage = activeState.statusMessage;
  const lastEventTime = activeState.lastEventTime;

  // Keep screen awake while Claude is responding
  useWakeLock(isStreaming);

  const openProjectIds = useMemo(
    () => new Set(openProjects.map((p) => p.id)),
    [openProjects],
  );

  // API helper that injects server context
  const serverFetch = useCallback(
    (path: string, init?: RequestInit) => {
      return apiFetch(path, {
        ...init,
        serverId: serverConfig.id,
        serverUrl: serverConfig.serverUrl,
      });
    },
    [serverConfig],
  );

  const scrollToBottom = useCallback((force = false) => {
    if (!messagesEndRef.current) return;
    const container = messagesEndRef.current.parentElement;
    if (container && !force) {
      const { scrollTop, scrollHeight, clientHeight } = container;
      const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
      if (distanceFromBottom > 150) return;
    }
    messagesEndRef.current.scrollIntoView({
      behavior: force ? "instant" : "smooth",
    });
  }, []);

  // Fetch conversation history for a specific project/conversation
  const fetchProjectConversation = useCallback(
    async (projectId: string, conversationId?: string, retries = 3) => {
      const convId = conversationId || "default";
      const sKey = `${projectId}:${convId}`;
      console.log(
        `Fetching conversation history for project: ${projectId}, conv: ${convId}`,
      );
      updateProjectState(sKey, (state) => ({
        ...state,
        isLoadingHistory: true,
      }));
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const convPath = convId
            ? `/${encodeURIComponent(convId)}`
            : "";
          const res = await serverFetch(
            `/api/projects/${encodeURIComponent(projectId)}/conversation${convPath}`,
          );
          if (!res.ok)
            throw new Error(`Failed to fetch history: ${res.status}`);
          const data = await res.json();
          console.log(
            `Loaded conversation for ${projectId}/${convId}:`,
            data.messages?.length,
            "messages",
          );
          const loadedMessages = (data.messages || []).map(
            (m: {
              role: string;
              content: string;
              task?: string;
              chunks?: OutputChunk[];
              thinking?: string;
              activity?: ToolActivity[];
              startedAt?: string;
              completedAt?: string;
            }) => ({
              role: m.role as "user" | "assistant",
              content: m.content,
              task: m.task,
              chunks: m.chunks,
              thinking: m.thinking,
              activity: m.activity,
              startedAt: m.startedAt,
              completedAt: m.completedAt,
            }),
          );
          updateProjectState(sKey, (state) => ({
            ...state,
            messages: loadedMessages,
            isLoadingHistory: false,
          }));
          if (loadedMessages.length > 0) {
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: "instant" });
              });
            });
          }
          // Fetch conversation list after history load (migration may have just run)
          serverFetch(
            `/api/projects/${encodeURIComponent(projectId)}/conversations`,
          )
            .then((r) => (r.ok ? r.json() : null))
            .then((data) => {
              if (data?.conversations) {
                setConversationLists((prev) => {
                  const next = new Map(prev);
                  next.set(projectId, data.conversations);
                  return next;
                });
              }
            })
            .catch(() => {});
          return;
        } catch (err) {
          console.error(
            `Failed to fetch project conversation (attempt ${attempt}/${retries}):`,
            err,
          );
          if (attempt < retries) {
            await new Promise((resolve) => setTimeout(resolve, 500 * attempt));
          }
        }
      }
      console.error("All retries failed for project conversation");
      updateProjectState(sKey, (state) => ({
        ...state,
        isLoadingHistory: false,
      }));
    },
    [serverFetch, updateProjectState],
  );

  // Fetch conversation list for a project
  const fetchConversationList = useCallback(
    async (projectId: string) => {
      try {
        const res = await serverFetch(
          `/api/projects/${encodeURIComponent(projectId)}/conversations`,
        );
        if (!res.ok) return;
        const data = await res.json();
        setConversationLists((prev) => {
          const next = new Map(prev);
          next.set(projectId, data.conversations || []);
          return next;
        });
      } catch (err) {
        console.error("Failed to fetch conversations:", err);
      }
    },
    [serverFetch],
  );

  const clearHistory = async () => {
    if (!activeProjectId || !activeStateKey) return;
    try {
      const convPath = activeConversationId
        ? `/${encodeURIComponent(activeConversationId)}`
        : "";
      const res = await serverFetch(
        `/api/projects/${encodeURIComponent(activeProjectId)}/conversation${convPath}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`Failed to clear history: ${res.status}`);
      updateProjectState(activeStateKey, (state) => ({
        ...state,
        messages: [],
      }));
    } catch (err) {
      setError(`Failed to clear history: ${err}`);
    }
  };

  // Track the visual viewport so the app container always matches the visible
  // area, even when the mobile keyboard is open. We track both height (viewport
  // shrinks) and offsetTop (browser may scroll the layout viewport).
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;

    const update = () => {
      root.style.setProperty("--app-height", `${vv.height}px`);
      root.style.setProperty("--app-top", `${vv.offsetTop}px`);
    };

    update();
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
    return () => {
      vv.removeEventListener("resize", update);
      vv.removeEventListener("scroll", update);
    };
  }, []);

  // Scroll to bottom when new messages arrive or project changes
  const messagesLength = messages.length;
  useEffect(() => {
    scrollToBottom(true);
  }, [messagesLength, activeProjectId, scrollToBottom]);

  // Scroll during streaming
  const scrollThrottleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (isStreaming && !scrollThrottleRef.current) {
      scrollThrottleRef.current = setTimeout(() => {
        scrollToBottom(false);
        scrollThrottleRef.current = null;
      }, 200);
    }
  }, [
    currentThinking,
    currentResponse,
    currentActivity,
    isStreaming,
    scrollToBottom,
  ]);

  // Persist open tabs to localStorage (server-scoped)
  const initialRenderRef = useRef(true);
  useEffect(() => {
    if (initialRenderRef.current) {
      initialRenderRef.current = false;
      return;
    }
    if (openProjects.length > 0) {
      localStorage.setItem(projectsKey, JSON.stringify(openProjects));
    } else {
      localStorage.removeItem(projectsKey);
    }
  }, [openProjects, projectsKey]);

  // Persist active tab to localStorage (server-scoped)
  const initialActiveRef = useRef(true);
  useEffect(() => {
    if (initialActiveRef.current) {
      initialActiveRef.current = false;
      return;
    }
    if (activeProjectId) {
      localStorage.setItem(activeProjectKey, activeProjectId);
    } else {
      localStorage.removeItem(activeProjectKey);
    }
  }, [activeProjectId, activeProjectKey]);

  // Persist active conversation IDs to localStorage
  const initialConvRef = useRef(true);
  useEffect(() => {
    if (initialConvRef.current) {
      initialConvRef.current = false;
      return;
    }
    const convKey = `claude-remote-convIds-${serverConfig.id}`;
    if (activeConversationIds.size > 0) {
      localStorage.setItem(
        convKey,
        JSON.stringify(Object.fromEntries(activeConversationIds)),
      );
    } else {
      localStorage.removeItem(convKey);
    }
  }, [activeConversationIds, serverConfig.id]);

  useEffect(() => {
    const cachedPin = cachedPinRef.current;
    if (cachedPin) {
      console.log("Found cached PIN, auto-connecting...");

      // Restore tabs from localStorage
      const savedProjects = localStorage.getItem(projectsKey);
      const savedActiveId = localStorage.getItem(activeProjectKey);
      const savedConvIds = localStorage.getItem(
        `claude-remote-convIds-${serverConfig.id}`,
      );
      let restoredConvIds = new Map<string, string>();
      if (savedConvIds) {
        try {
          restoredConvIds = new Map(Object.entries(JSON.parse(savedConvIds)));
        } catch {
          // ignore
        }
      }
      setActiveConversationIds(restoredConvIds);

      if (savedProjects) {
        try {
          const projects: Project[] = JSON.parse(savedProjects);
          if (projects.length > 0) {
            setOpenProjects(projects);
            const newStates = new Map<string, ProjectState>();
            projects.forEach((p) => {
              const convId = restoredConvIds.get(p.id) || "default";
              newStates.set(`${p.id}:${convId}`, createEmptyProjectState());
            });
            setProjectStates(newStates);
            const activeId =
              savedActiveId && projects.find((p) => p.id === savedActiveId)
                ? savedActiveId
                : projects[0].id;
            setActiveProjectId(activeId);
            tabsRestoredRef.current = true;
          }
        } catch (err) {
          console.error("Failed to restore saved projects on init:", err);
        }
      }

      setView("chat");
      setIsReconnecting(true);
      setTimeout(() => connectAndAuth(), 0);
    } else {
      setView("pin");
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const restoreSharedKey = useCallback(async (): Promise<void> => {
    const privateKey = await crypto.subtle.importKey(
      "jwk",
      JSON.parse(serverConfig.privateKey),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
    const serverKey = await importPublicKey(serverConfig.serverPublicKey);
    const sharedKey = await deriveSharedSecret(privateKey, serverKey);
    sharedKeyRef.current = sharedKey;
  }, [serverConfig]);

  // Schedule reconnection with exponential backoff
  const scheduleReconnect = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    const attempt = reconnectAttemptRef.current;
    const delay = Math.min(1000 * Math.pow(2, attempt), 30000);
    console.log(`[reconnect] Scheduling attempt ${attempt + 1} in ${delay}ms`);
    reconnectAttemptRef.current = attempt + 1;
    setReconnectAttempt(attempt + 1);
    setIsReconnecting(true);
    reconnectTimerRef.current = setTimeout(() => {
      connectAndAuth();
    }, delay);
  }, []); // connectAndAuth referenced below via ref

  const scheduleReconnectRef = useRef(scheduleReconnect);
  scheduleReconnectRef.current = scheduleReconnect;

  const connectWebSocket = useCallback((): Promise<WebSocket> => {
    return new Promise((resolve, reject) => {
      // Connect to the specific server's WebSocket
      const wsUrl = new URL("/ws", serverConfig.serverUrl);
      wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(wsUrl.toString());

      ws.onopen = () => {
        wsRef.current = ws;
        resolve(ws);
      };

      ws.onmessage = async (event) => {
        if (!sharedKeyRef.current) {
          console.error("[ws] Received message but sharedKeyRef is null");
          setError("Encryption key missing - please refresh the page");
          return;
        }

        let encrypted: EncryptedData;
        try {
          encrypted = JSON.parse(event.data);
        } catch (err) {
          console.error("[ws] Failed to parse message as JSON:", err);
          return;
        }

        let decrypted: string;
        try {
          decrypted = await decrypt(encrypted, sharedKeyRef.current);
        } catch (err) {
          console.error("[ws] Decryption failed:", err);
          setError(
            "Decryption failed - keys may be mismatched. Try clearing data and re-pairing.",
          );
          return;
        }

        let msg: {
          type: string;
          text?: string;
          thinking?: string;
          error?: string;
          projectId?: string;
          conversationId?: string;
          activeProjectIds?: string[];
          activeConversationMap?: Record<string, string>;
          activity?: ToolActivity[];
          toolUse?: {
            tool: string;
            id?: string;
            input: Record<string, unknown>;
          };
          toolResult?: { tool: string; output?: string; error?: string };
          name?: string;
        };
        try {
          msg = JSON.parse(decrypted);
        } catch (err) {
          console.error("[ws] Failed to parse decrypted message:", err);
          return;
        }

        const projectId = msg.projectId;
        const conversationId = msg.conversationId;
        // Compute the state key for this event
        const eventKey = projectId
          ? `${projectId}:${conversationId || "default"}`
          : null;

        if (msg.type === "auth_ok") {
          // Show reconnected banner if we were reconnecting (not initial connect)
          if (reconnectAttemptRef.current > 0) {
            setShowReconnectedBanner(true);
            setTimeout(() => setShowReconnectedBanner(false), 5000);
          }
          setError("");
          setView("chat");
          setIsReconnecting(false);
          setReconnectAttempt(0);
          reconnectAttemptRef.current = 0;

          // Register service worker and handle push notifications
          registerServiceWorker()
            .then((reg) => {
              console.log(
                "[push] SW registered:",
                !!reg,
                "supported:",
                isPushSupported(),
                "permission:",
                getPushPermission(),
              );
              if (!reg) {
                // No service worker — show banner anyway if in standalone mode (iOS PWA)
                const isStandalone =
                  window.matchMedia("(display-mode: standalone)").matches ||
                  (navigator as unknown as { standalone?: boolean })
                    .standalone === true;
                console.log("[push] No SW, standalone:", isStandalone);
                if (isStandalone) setShowPushBanner(true);
                return;
              }
              const perm = getPushPermission();
              if (perm === "granted") {
                subscribeToPush(
                  serverConfig.id,
                  serverConfig.serverUrl,
                  serverConfig.deviceId,
                );
              } else if (perm !== "denied") {
                // Show banner for 'default' or 'unsupported' — let the user try
                setShowPushBanner(true);
              }
            })
            .catch((err) => {
              console.error("[push] Setup failed:", err);
              setShowPushBanner(true); // Show banner anyway so user can attempt
            });

          const activeIds = msg.activeProjectIds || [];
          const activeConvMap = msg.activeConversationMap || {};
          if (activeIds.length > 0) {
            console.log("Active streaming projects on reconnect:", activeIds);
            setStreamingProjectIds(
              new Set(activeIds.filter((id) => id !== "__global__")),
            );
            activeIds.forEach((pid) => {
              if (pid !== "__global__") {
                const cid = activeConvMap[pid] || "default";
                const sKey = `${pid}:${cid}`;
                updateProjectState(sKey, (state) => ({
                  ...state,
                  isStreaming: true,
                }));
              }
            });
          }

          if (!tabsRestoredRef.current) {
            tabsRestoredRef.current = true;
            const savedProjects = localStorage.getItem(projectsKey);
            const savedActiveId = localStorage.getItem(activeProjectKey);

            // Restore saved conversation IDs
            const savedConvIds = localStorage.getItem(
              `claude-remote-convIds-${serverConfig.id}`,
            );
            let restoredConvIds = new Map<string, string>();
            if (savedConvIds) {
              try {
                restoredConvIds = new Map(
                  Object.entries(JSON.parse(savedConvIds)),
                );
              } catch {
                // ignore
              }
            }
            setActiveConversationIds(restoredConvIds);

            if (savedProjects) {
              try {
                const projects: Project[] = JSON.parse(savedProjects);
                if (projects.length > 0) {
                  setOpenProjects(projects);
                  const newStates = new Map<string, ProjectState>();
                  projects.forEach((p) => {
                    const convId = restoredConvIds.get(p.id) || "default";
                    const sKey = `${p.id}:${convId}`;
                    const pIsStreaming = activeIds.includes(p.id);
                    newStates.set(sKey, {
                      ...createEmptyProjectState(),
                      isStreaming: pIsStreaming,
                    });
                  });
                  setProjectStates(newStates);
                  const activeId =
                    savedActiveId &&
                    projects.find((p) => p.id === savedActiveId)
                      ? savedActiveId
                      : projects[0].id;
                  setActiveProjectId(activeId);
                  projects.forEach((p) => {
                    const convId = restoredConvIds.get(p.id) || "default";
                    // fetchProjectConversation already fetches the conversation list
                    // after history loads (post-migration), so no separate call needed
                    fetchProjectConversation(p.id, convId);
                  });
                  return;
                }
              } catch (err) {
                console.error("Failed to restore saved projects:", err);
              }
            }
            setShowProjectPicker(true);
          } else {
            // Reconnect path: clear stale streaming state before re-fetching
            setStreamingProjectIds(new Set());
            setProjectStates((prev) => {
              const next = new Map(prev);
              for (const [key, state] of next) {
                if (state.isStreaming || state.currentResponse || state.currentThinking) {
                  next.set(key, {
                    ...state,
                    isStreaming: false,
                    currentResponse: "",
                    currentThinking: "",
                    currentActivity: [],
                    currentTask: "",
                    taskStartTime: null,
                    statusMessage: "",
                  });
                }
              }
              return next;
            });
            thinkingRefs.current.clear();
            responseRefs.current.clear();
            activityRefs.current.clear();

            // Re-fetch history for all open projects
            const savedProjects = localStorage.getItem(projectsKey);
            if (savedProjects) {
              try {
                const projects: Project[] = JSON.parse(savedProjects);
                // Read conversation IDs from localStorage (state may be stale in this closure)
                const savedConvIds = localStorage.getItem(
                  `claude-remote-convIds-${serverConfig.id}`,
                );
                let convIds = new Map<string, string>();
                if (savedConvIds) {
                  try {
                    convIds = new Map(
                      Object.entries(JSON.parse(savedConvIds)),
                    );
                  } catch {
                    // ignore
                  }
                }
                projects.forEach((p) => {
                  const convId = convIds.get(p.id) || "default";
                  fetchProjectConversation(p.id, convId);
                });
              } catch {
                // ignore invalid JSON in saved projects
              }
            }
          }
        } else if (msg.type === "auth_error") {
          console.error("Auth failed:", msg.error);

          if (msg.error === "device_expired") {
            cachedPinRef.current = null;
            clearServerPin(serverConfig.id);
            setIsReconnecting(false);
            setReconnectAttempt(0);
            reconnectAttemptRef.current = 0;
            setError(
              "Device authorization has expired. Please re-pair this device.",
            );
            // Redirect to server list after a short delay
            setTimeout(() => onNavigate("servers"), 3000);
          } else if (
            msg.error?.includes("Too many attempts") ||
            msg.error?.includes("rate limit")
          ) {
            // Rate limited — don't clear PIN, just retry after a delay
            console.log("[auth] Rate limited, will retry in 10s...");
            setError("Rate limited — retrying...");
            setTimeout(() => {
              if (cachedPinRef.current) {
                connectAndAuth();
              }
            }, 10_000);
          } else {
            cachedPinRef.current = null;
            clearServerPin(serverConfig.id);
            setIsReconnecting(false);
            setReconnectAttempt(0);
            reconnectAttemptRef.current = 0;
            setError(
              msg.error || "Authentication failed - please re-enter PIN",
            );
            setView("pin");
          }
        } else if (msg.type === "streaming_restore" && eventKey) {
          console.log(`Restoring streaming state for ${eventKey}:`, {
            thinking: msg.thinking?.length || 0,
            text: msg.text?.length || 0,
            activity: msg.activity?.length || 0,
          });

          if (msg.thinking) thinkingRefs.current.set(eventKey, msg.thinking);
          if (msg.text) responseRefs.current.set(eventKey, msg.text);
          if (msg.activity && msg.activity.length > 0)
            activityRefs.current.set(eventKey, msg.activity);

          updateProjectState(eventKey, (state) => ({
            ...state,
            isStreaming: true,
            currentThinking: msg.thinking || "",
            currentResponse: msg.text || "",
            currentActivity: msg.activity || [],
          }));
        } else if (msg.type === "status" && eventKey) {
          updateProjectState(eventKey, (state) => ({
            ...state,
            statusMessage: msg.text || "",
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "thinking" && eventKey) {
          const currentThinking = thinkingRefs.current.get(eventKey) || "";
          thinkingRefs.current.set(
            eventKey,
            currentThinking + (msg.text || ""),
          );
          updateProjectState(eventKey, (state) => ({
            ...state,
            currentThinking: thinkingRefs.current.get(eventKey) || "",
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "text" && eventKey) {
          const currentResponse = responseRefs.current.get(eventKey) || "";
          const delimiter = currentResponse ? "\n" : "";
          responseRefs.current.set(
            eventKey,
            currentResponse + delimiter + (msg.text || ""),
          );
          updateProjectState(eventKey, (state) => ({
            ...state,
            currentResponse: responseRefs.current.get(eventKey) || "",
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "tool_use" && msg.toolUse && eventKey) {
          const activity: ToolActivity = {
            type: "tool_use",
            tool: msg.toolUse.tool,
            id: msg.toolUse.id,
            input: msg.toolUse.input,
            timestamp: Date.now(),
          };
          const currentActivity = activityRefs.current.get(eventKey) || [];
          activityRefs.current.set(eventKey, [...currentActivity, activity]);

          if (
            msg.toolUse.tool === "AskUserQuestion" &&
            msg.toolUse.input?.questions
          ) {
            updateProjectState(eventKey, (state) => ({
              ...state,
              currentActivity: activityRefs.current.get(eventKey) || [],
              lastEventTime: Date.now(),
              pendingQuestion: {
                toolUseId: msg.toolUse!.id || "",
                questions: msg.toolUse!.input
                  .questions as PendingQuestionData["questions"],
              },
            }));
          } else {
            updateProjectState(eventKey, (state) => ({
              ...state,
              currentActivity: activityRefs.current.get(eventKey) || [],
              lastEventTime: Date.now(),
            }));
          }
        } else if (msg.type === "tool_result" && msg.toolResult && eventKey) {
          const activity: ToolActivity = {
            type: "tool_result",
            tool: msg.toolResult.tool,
            output: msg.toolResult.output,
            error: msg.toolResult.error,
            timestamp: Date.now(),
          };
          const currentActivity = activityRefs.current.get(eventKey) || [];
          activityRefs.current.set(eventKey, [...currentActivity, activity]);
          updateProjectState(eventKey, (state) => ({
            ...state,
            currentActivity: activityRefs.current.get(eventKey) || [],
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "done" && eventKey) {
          const thinking = thinkingRefs.current.get(eventKey) || "";
          const response = responseRefs.current.get(eventKey) || "";
          const activity = activityRefs.current.get(eventKey) || [];

          if (projectId) {
            setStreamingProjectIds((prev) => {
              const next = new Set(prev);
              next.delete(projectId);
              return next;
            });
          }

          updateProjectState(eventKey, (state) => {
            const task = state.currentTask;
            const startedAt = state.taskStartTime
              ? new Date(state.taskStartTime).toISOString()
              : undefined;
            const completedAt = new Date().toISOString();

            return {
              ...state,
              isStreaming: false,
              currentThinking: "",
              currentResponse: "",
              currentActivity: [],
              currentTask: "",
              taskStartTime: null,
              statusMessage: "",
              messages:
                thinking || response || activity.length > 0
                  ? [
                      ...state.messages,
                      {
                        role: "assistant" as const,
                        content: response,
                        task: task || undefined,
                        thinking: thinking || undefined,
                        activity: activity.length > 0 ? activity : undefined,
                        startedAt,
                        completedAt,
                      },
                    ]
                  : state.messages,
            };
          });

          thinkingRefs.current.delete(eventKey);
          responseRefs.current.delete(eventKey);
          activityRefs.current.delete(eventKey);
        } else if (msg.type === "error") {
          console.error("Server error:", msg.error);
          setError(msg.error || "Unknown server error");
          if (eventKey && projectId) {
            setStreamingProjectIds((prev) => {
              const next = new Set(prev);
              next.delete(projectId);
              return next;
            });
            updateProjectState(eventKey, (state) => ({
              ...state,
              isStreaming: false,
            }));
          }
        } else if (msg.type === "sync_user_message" && msg.projectId) {
          const syncKey = `${msg.projectId}:${msg.conversationId || "default"}`;
          console.log(
            `[sync] User message from another device for ${syncKey}`,
          );
          updateProjectState(syncKey, (state) => ({
            ...state,
            messages: [
              ...state.messages,
              { role: "user" as const, content: msg.text || "" },
            ],
            isStreaming: true,
            currentThinking: "",
            currentResponse: "",
            currentActivity: [],
            currentTask: msg.text || "",
            taskStartTime: Date.now(),
          }));
          setStreamingProjectIds((prev) => new Set(prev).add(msg.projectId!));
          thinkingRefs.current.set(syncKey, "");
          responseRefs.current.set(syncKey, "");
          activityRefs.current.set(syncKey, []);
        } else if (msg.type === "sync_cancel" && msg.projectId) {
          const syncKey = `${msg.projectId}:${msg.conversationId || "default"}`;
          console.log(`[sync] Cancel from another device for ${syncKey}`);
          setStreamingProjectIds((prev) => {
            const next = new Set(prev);
            next.delete(msg.projectId!);
            return next;
          });
          updateProjectState(syncKey, (state) => ({
            ...state,
            isStreaming: false,
          }));
        } else if (msg.type === "conversation_renamed" && msg.projectId && msg.conversationId && msg.name) {
          // Server auto-named a conversation — update the local list
          setConversationLists((prev) => {
            const next = new Map(prev);
            const list = next.get(msg.projectId!) || [];
            const exists = list.some((c) => c.id === msg.conversationId);
            if (exists) {
              next.set(
                msg.projectId!,
                list.map((c) =>
                  c.id === msg.conversationId ? { ...c, name: msg.name! } : c,
                ),
              );
            } else {
              // Conversation not in list yet (e.g. default) — add it
              next.set(msg.projectId!, [
                ...list,
                {
                  id: msg.conversationId!,
                  name: msg.name!,
                  messageCount: 1,
                  createdAt: new Date().toISOString(),
                  updatedAt: new Date().toISOString(),
                },
              ]);
            }
            return next;
          });
        } else {
          console.log("Unknown message type:", msg.type, msg);
        }
      };

      ws.onclose = (event) => {
        console.log(
          `[ws] Closed: code=${event.code} reason="${event.reason || "none"}"`,
        );
        wsRef.current = null;

        if (intentionalCloseRef.current) {
          intentionalCloseRef.current = false;
          return;
        }

        if (event.code !== 1000) {
          if (cachedPinRef.current) {
            scheduleReconnectRef.current();
          } else {
            setError("Connection lost. Please re-enter PIN.");
            setView("pin");
          }
        }
      };

      ws.onerror = (event) => {
        console.error("[ws] Connection error", event);
        reject(new Error("WebSocket connection failed"));
      };
    });
  }, [
    serverConfig,
    updateProjectState,
    projectsKey,
    activeProjectKey,
    fetchProjectConversation,
  ]);

  // Connect + authenticate
  const connectAndAuth = useCallback(async () => {
    const pinToUse = cachedPinRef.current;
    if (!pinToUse) {
      console.log("[reconnect] No cached PIN, dropping to PIN screen");
      setIsReconnecting(false);
      setReconnectAttempt(0);
      setView("pin");
      return;
    }

    if (!sharedKeyRef.current) {
      try {
        await restoreSharedKey();
      } catch (err) {
        console.error("[reconnect] Failed to restore shared key:", err);
        setIsReconnecting(false);
        setError("Encryption key restore failed - please refresh");
        setView("pin");
        return;
      }
    }

    try {
      await connectWebSocket();
    } catch {
      return;
    }

    if (
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN &&
      sharedKeyRef.current
    ) {
      try {
        const encrypted = await encrypt(
          JSON.stringify({ type: "auth", pin: pinToUse }),
          sharedKeyRef.current,
        );
        wsRef.current.send(JSON.stringify(encrypted));
        console.log("[reconnect] Auth sent");
      } catch (err) {
        console.error("[reconnect] Failed to send auth:", err);
      }
    }
  }, [connectWebSocket, restoreSharedKey]);

  // Clean up reconnect timer on unmount
  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    };
  }, []);

  // Auto-dismiss errors after 8 seconds
  useEffect(() => {
    if (!error) return;
    const timer = setTimeout(() => setError(""), 8000);
    return () => clearTimeout(timer);
  }, [error]);

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!pin || pin.length < 4) {
      setError("PIN must be at least 4 digits");
      return;
    }

    cachedPinRef.current = pin;
    setServerPin(serverConfig.id, pin);

    setError("");
    await connectAndAuth();
  };

  const handleSend = useCallback(
    async (text: string) => {
      if (!activeProjectId) {
        setShowProjectPicker(true);
        return;
      }

      if (isStreaming) return;

      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
        setError("Not connected - waiting for reconnection...");
        return;
      }

      if (!sharedKeyRef.current) {
        setError("Encryption key missing - please refresh the page");
        return;
      }

      setError("");

      const convId = activeConversationIds.get(activeProjectId) || "default";
      const sKey = `${activeProjectId}:${convId}`;

      const taskStartTime = Date.now();
      updateProjectState(sKey, (state) => ({
        ...state,
        messages: [...state.messages, { role: "user" as const, content: text }],
        isStreaming: true,
        currentThinking: "",
        currentResponse: "",
        currentActivity: [],
        currentTask: text,
        taskStartTime,
      }));

      setStreamingProjectIds((prev) => new Set(prev).add(activeProjectId));

      thinkingRefs.current.set(sKey, "");
      responseRefs.current.set(sKey, "");
      activityRefs.current.set(sKey, []);

      try {
        const encrypted = await encrypt(
          JSON.stringify({
            type: "message",
            text,
            projectId: activeProjectId,
            conversationId: convId !== "default" ? convId : undefined,
          }),
          sharedKeyRef.current,
        );
        wsRef.current.send(JSON.stringify(encrypted));
      } catch (err) {
        console.error("[send] Failed:", err);
        setError(`Failed to send message: ${err}`);
        setStreamingProjectIds((prev) => {
          const next = new Set(prev);
          next.delete(activeProjectId);
          return next;
        });
        updateProjectState(sKey, (state) => ({
          ...state,
          isStreaming: false,
        }));
      }
    },
    [activeProjectId, activeConversationIds, isStreaming, updateProjectState],
  );

  const handleCancel = useCallback(async () => {
    if (!activeProjectId) return;

    const convId = activeConversationIds.get(activeProjectId) || "default";
    const sKey = `${activeProjectId}:${convId}`;

    setStreamingProjectIds((prev) => {
      const next = new Set(prev);
      next.delete(activeProjectId);
      return next;
    });
    updateProjectState(sKey, (state) => ({
      ...state,
      isStreaming: false,
    }));

    if (
      wsRef.current &&
      wsRef.current.readyState === WebSocket.OPEN &&
      sharedKeyRef.current
    ) {
      try {
        const encrypted = await encrypt(
          JSON.stringify({
            type: "cancel",
            projectId: activeProjectId,
            conversationId: convId !== "default" ? convId : undefined,
          }),
          sharedKeyRef.current,
        );
        wsRef.current.send(JSON.stringify(encrypted));
      } catch (err) {
        console.error("[cancel] WS cancel failed:", err);
      }
    }

    serverFetch(`/api/projects/${encodeURIComponent(activeProjectId)}/cancel`, {
      method: "POST",
    }).catch((err) => console.error("[cancel] HTTP cancel failed:", err));
  }, [activeProjectId, activeConversationIds, updateProjectState, serverFetch]);

  const handleToolAnswer = useCallback(
    async (answers: Array<{ header: string; answer: string }>) => {
      if (
        !activeProjectId ||
        !wsRef.current ||
        wsRef.current.readyState !== WebSocket.OPEN ||
        !sharedKeyRef.current
      ) {
        setError("Cannot send answer - not connected");
        return;
      }

      const convId = activeConversationIds.get(activeProjectId) || "default";
      const sKey = `${activeProjectId}:${convId}`;

      updateProjectState(sKey, (state) => ({
        ...state,
        pendingQuestion: null,
        isStreaming: true,
        currentThinking: "",
        currentResponse: "",
        currentActivity: [],
      }));

      setStreamingProjectIds((prev) => new Set(prev).add(activeProjectId));
      thinkingRefs.current.set(sKey, "");
      responseRefs.current.set(sKey, "");
      activityRefs.current.set(sKey, []);

      try {
        const encrypted = await encrypt(
          JSON.stringify({
            type: "tool_answer",
            answers,
            projectId: activeProjectId,
            conversationId: convId !== "default" ? convId : undefined,
          }),
          sharedKeyRef.current,
        );
        wsRef.current.send(JSON.stringify(encrypted));
      } catch (err) {
        setError(`Failed to send answer: ${err}`);
        updateProjectState(sKey, (state) => ({
          ...state,
          isStreaming: false,
        }));
      }
    },
    [activeProjectId, activeConversationIds, updateProjectState],
  );

  const handleDismissQuestion = useCallback(() => {
    if (!activeProjectId || !activeStateKey) return;
    updateProjectState(activeStateKey, (state) => ({
      ...state,
      pendingQuestion: null,
    }));
  }, [activeProjectId, activeStateKey, updateProjectState]);

  const handleSelectProject = (project: Project) => {
    console.log("Selected project:", project.id);

    if (!openProjects.find((p) => p.id === project.id)) {
      setOpenProjects((prev) => [...prev, project]);
      const convId = activeConversationIds.get(project.id) || "default";
      const sKey = `${project.id}:${convId}`;
      if (!projectStates.has(sKey)) {
        setProjectStates((prev) => {
          const next = new Map(prev);
          next.set(sKey, createEmptyProjectState());
          return next;
        });
      }
      fetchProjectConversation(project.id, convId);
    }

    setActiveProjectId(project.id);
    setShowProjectPicker(false);
  };

  const handleCloseProject = (projectId: string) => {
    setOpenProjects((prev) => prev.filter((p) => p.id !== projectId));

    if (activeProjectId === projectId) {
      const remaining = openProjects.filter((p) => p.id !== projectId);
      setActiveProjectId(
        remaining.length > 0 ? remaining[remaining.length - 1].id : null,
      );
    }

    // Remove all state keys for this project (any conversation)
    setProjectStates((prev) => {
      const next = new Map(prev);
      for (const key of prev.keys()) {
        if (key.startsWith(`${projectId}:`)) {
          next.delete(key);
        }
      }
      return next;
    });
  };

  const handleReset = () => {
    setError("");
    if (activeProjectId && activeStateKey) {
      setStreamingProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(activeProjectId);
        return next;
      });
      updateProjectState(activeStateKey, (state) => ({
        ...state,
        isStreaming: false,
        currentThinking: "",
        currentResponse: "",
        currentActivity: [],
        currentTask: "",
        taskStartTime: null,
      }));
    }
    console.log("State reset by user");
  };

  // Conversation management handlers
  const handleNewConversation = async () => {
    if (!activeProjectId) return;
    try {
      const res = await serverFetch(
        `/api/projects/${encodeURIComponent(activeProjectId)}/conversations`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error(`Failed to create conversation: ${res.status}`);
      const data = await res.json();
      const newConvId = data.conversation.id;
      console.log("Created new conversation:", newConvId);

      // Update active conversation for this project
      setActiveConversationIds((prev) => {
        const next = new Map(prev);
        next.set(activeProjectId, newConvId);
        return next;
      });

      // Create empty state for new conversation
      const sKey = `${activeProjectId}:${newConvId}`;
      setProjectStates((prev) => {
        const next = new Map(prev);
        next.set(sKey, createEmptyProjectState());
        return next;
      });

      // Refresh conversation list
      fetchConversationList(activeProjectId);
      setShowConversationList(false);
    } catch (err) {
      setError(`Failed to create conversation: ${err}`);
    }
  };

  const handleSwitchConversation = (conversationId: string) => {
    if (!activeProjectId) return;
    const sKey = `${activeProjectId}:${conversationId}`;

    setActiveConversationIds((prev) => {
      const next = new Map(prev);
      next.set(activeProjectId, conversationId);
      return next;
    });

    // Initialize state if not loaded yet
    if (!projectStates.has(sKey)) {
      setProjectStates((prev) => {
        const next = new Map(prev);
        next.set(sKey, createEmptyProjectState());
        return next;
      });
      fetchProjectConversation(activeProjectId, conversationId);
    }

    setShowConversationList(false);
  };

  const handleDeleteConversation = async (conversationId: string) => {
    if (!activeProjectId) return;
    try {
      const res = await serverFetch(
        `/api/projects/${encodeURIComponent(activeProjectId)}/conversations/${encodeURIComponent(conversationId)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`Failed to delete conversation: ${res.status}`);

      // If deleted the active conversation, switch to default
      const currentConvId =
        activeConversationIds.get(activeProjectId) || "default";
      if (currentConvId === conversationId) {
        handleSwitchConversation("default");
      }

      // Remove state
      const sKey = `${activeProjectId}:${conversationId}`;
      setProjectStates((prev) => {
        const next = new Map(prev);
        next.delete(sKey);
        return next;
      });

      fetchConversationList(activeProjectId);
    } catch (err) {
      setError(`Failed to delete conversation: ${err}`);
    }
  };

  const handleRenameConversation = async (conversationId: string, name: string) => {
    if (!activeProjectId) return;
    try {
      const res = await serverFetch(
        `/api/projects/${encodeURIComponent(activeProjectId)}/conversations/${encodeURIComponent(conversationId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name }),
        },
      );
      if (!res.ok) throw new Error(`Failed to rename conversation: ${res.status}`);

      // Update local conversation list
      setConversationLists((prev) => {
        const next = new Map(prev);
        const list = next.get(activeProjectId) || [];
        next.set(
          activeProjectId,
          list.map((c) => (c.id === conversationId ? { ...c, name } : c)),
        );
        return next;
      });
    } catch (err) {
      setError(`Failed to rename conversation: ${err}`);
    }
  };

  // Get current conversation list for active project
  const currentConversations =
    (activeProjectId ? conversationLists.get(activeProjectId) : null) || [];

  // Compute which conversations in the current project are streaming
  const streamingConversationIds = useMemo(() => {
    const ids = new Set<string>();
    if (!activeProjectId) return ids;
    for (const conv of currentConversations) {
      const key = `${activeProjectId}:${conv.id}`;
      const state = projectStates.get(key);
      if (state?.isStreaming) {
        ids.add(conv.id);
      }
    }
    return ids;
  }, [activeProjectId, currentConversations, projectStates]);

  if (view === "pin") {
    return (
      <main className="min-h-screen flex flex-col items-center justify-center bg-[var(--color-bg-primary)] text-[var(--color-text-primary)] p-4">
        <div className="w-full max-w-xs">
          <button
            onClick={() => onNavigate("servers")}
            className="mb-4 text-sm text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
          >
            &larr; Servers
          </button>
          <h1 className="text-2xl font-bold mb-1 text-center">Enter PIN</h1>
          <p className="text-sm text-[var(--color-text-secondary)] mb-4 text-center truncate">
            {serverConfig.name}
          </p>
          {error && (
            <p className="text-red-400 text-sm mb-4 text-center">{error}</p>
          )}
          <form onSubmit={handlePinSubmit}>
            <input
              type="password"
              inputMode="numeric"
              pattern="[0-9]*"
              value={pin}
              onChange={(e) => setPin(e.target.value.replace(/\D/g, ""))}
              placeholder="Enter PIN"
              className="w-full p-4 text-2xl text-center bg-[var(--color-bg-secondary)] rounded-lg mb-4 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]"
              autoFocus
            />
            <button
              type="submit"
              className="w-full p-4 bg-[var(--color-accent)] rounded-lg font-semibold hover:bg-[var(--color-accent-hover)] transition-colors"
            >
              Unlock
            </button>
          </form>
        </div>
      </main>
    );
  }

  return (
    <main
      className="fixed left-0 right-0 flex flex-col overflow-hidden bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]"
      style={{
        height: "var(--app-height, 100vh)",
        top: "var(--app-top, 0px)",
      }}
    >
      {/* Header: Project dropdown + git status + overflow menu */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-primary)] shrink-0 z-20">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <ProjectTabs
            projects={openProjects}
            activeProjectId={activeProjectId}
            streamingProjectIds={streamingProjectIds}
            onSelectProject={setActiveProjectId}
            onCloseProject={handleCloseProject}
            onAddProject={() => setShowProjectPicker(true)}
          />
          {activeProjectId && currentConversations.length > 1 && (
            <ConversationSwitcher
              conversations={currentConversations}
              activeConversationId={activeConversationId}
              streamingConversationIds={streamingConversationIds}
              onSwitch={handleSwitchConversation}
              onNew={handleNewConversation}
              onDelete={handleDeleteConversation}
              onRename={handleRenameConversation}
              isOpen={showConversationList}
              onToggle={() => setShowConversationList(!showConversationList)}
            />
          )}
          <GitStatus
            projectId={activeProjectId}
            serverId={serverConfig.id}
            serverUrl={serverConfig.serverUrl}
            onWorktreeCreated={handleSelectProject}
            onWorktreeDeleted={handleCloseProject}
          />
        </div>
        <OverflowMenu
          onBrowseFiles={() => setShowFileTree(true)}
          onViewChanges={() => setShowDiffViewer(true)}
          onReset={handleReset}
          onClearHistory={clearHistory}
          onNewChat={handleNewConversation}
          onSwitchServer={() => onNavigate("servers")}
          hasProject={!!activeProjectId}
          canClear={!isStreaming && !!activeProjectId}
          serverName={serverConfig.name}
        />
      </header>

      {/* Reconnecting banner */}
      {isReconnecting && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-yellow-900/80 border-b border-yellow-700 text-yellow-200 text-sm">
          <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24" fill="none">
            <circle
              className="opacity-25"
              cx="12"
              cy="12"
              r="10"
              stroke="currentColor"
              strokeWidth="4"
            />
            <path
              className="opacity-75"
              fill="currentColor"
              d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
            />
          </svg>
          <span>
            Reconnecting
            {reconnectAttempt > 1 ? ` (attempt ${reconnectAttempt})` : ""}...
          </span>
          <button
            onClick={() => {
              if (reconnectTimerRef.current)
                clearTimeout(reconnectTimerRef.current);
              setIsReconnecting(false);
              setReconnectAttempt(0);
              reconnectAttemptRef.current = 0;
              cachedPinRef.current = null;
              clearServerPin(serverConfig.id);
              setView("pin");
            }}
            className="ml-2 px-2 py-0.5 text-xs bg-yellow-800 hover:bg-yellow-700 rounded transition-colors"
          >
            Use PIN
          </button>
        </div>
      )}

      {/* Reconnected banner */}
      {showReconnectedBanner && (
        <div className="flex items-center justify-center gap-2 px-4 py-2 bg-green-900/80 border-b border-green-700 text-green-200 text-sm">
          <svg className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
          <span>Server restarted — redeploy successful</span>
          <button
            onClick={() => setShowReconnectedBanner(false)}
            className="ml-2 px-2 py-0.5 text-xs bg-green-800 hover:bg-green-700 rounded transition-colors"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Push notification enable banner */}
      {showPushBanner && (
        <div className="flex items-center justify-between px-4 py-2 bg-[var(--color-accent)]/20 border-b border-[var(--color-accent)]/30 text-sm">
          <span className="text-[var(--color-text-primary)]">
            Enable notifications?
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => {
                subscribeToPush(
                  serverConfig.id,
                  serverConfig.serverUrl,
                  serverConfig.deviceId,
                  true,
                ).then((ok) => {
                  if (ok) console.log("[push] Subscribed via banner");
                });
                setShowPushBanner(false);
              }}
              className="px-3 py-1 text-xs font-medium bg-[var(--color-accent)] text-white rounded transition-colors"
            >
              Enable
            </button>
            <button
              onClick={() => setShowPushBanner(false)}
              className="px-3 py-1 text-xs text-[var(--color-text-secondary)] hover:text-[var(--color-text-primary)] transition-colors"
            >
              Later
            </button>
          </div>
        </div>
      )}

      {/* Device token expiry warning banner */}
      {(() => {
        if (!tokenExpiresAt) return null;
        const daysLeft = Math.ceil(
          (new Date(tokenExpiresAt).getTime() - Date.now()) /
            (1000 * 60 * 60 * 24),
        );
        if (daysLeft > 14) return null;
        const isUrgent = daysLeft <= 7;
        if (!isUrgent && tokenExpiryDismissed) return null;
        return (
          <div
            className={`flex items-center justify-between px-4 py-2 border-b text-sm ${
              isUrgent
                ? "bg-red-900/80 border-red-700 text-red-200"
                : "bg-yellow-900/80 border-yellow-700 text-yellow-200"
            }`}
          >
            <span>
              {daysLeft <= 0
                ? "Device authorization has expired. Re-pair to continue."
                : `Device authorization expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""}. Re-pair to continue access.`}
            </span>
            <div className="flex gap-2">
              <button
                onClick={() => onNavigate("servers")}
                className={`px-3 py-1 text-xs font-medium rounded transition-colors ${
                  isUrgent
                    ? "bg-red-700 hover:bg-red-600 text-white"
                    : "bg-yellow-700 hover:bg-yellow-600 text-white"
                }`}
              >
                Re-pair
              </button>
              {!isUrgent && (
                <button
                  onClick={() => setTokenExpiryDismissed(true)}
                  className="px-3 py-1 text-xs text-yellow-300 hover:text-yellow-100 transition-colors"
                >
                  Later
                </button>
              )}
            </div>
          </div>
        );
      })()}

      {/* Project Picker Modal */}
      <ProjectPicker
        isOpen={showProjectPicker}
        onClose={() => setShowProjectPicker(false)}
        onSelect={handleSelectProject}
        openProjectIds={openProjectIds}
        serverId={serverConfig.id}
        serverUrl={serverConfig.serverUrl}
      />

      {/* File Tree Modal */}
      <FileTree
        projectId={activeProjectId}
        serverId={serverConfig.id}
        serverUrl={serverConfig.serverUrl}
        isOpen={showFileTree}
        onClose={() => setShowFileTree(false)}
      />

      {/* Diff Viewer Modal */}
      <DiffViewer
        projectId={activeProjectId}
        serverId={serverConfig.id}
        serverUrl={serverConfig.serverUrl}
        isOpen={showDiffViewer}
        onClose={() => setShowDiffViewer(false)}
      />

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-3 py-4 space-y-3 sm:px-4 sm:space-y-4">
        {!activeProjectId ? (
          <div className="flex flex-col items-center justify-center h-full text-center">
            <div className="p-6 rounded-2xl bg-[var(--color-bg-secondary)]/50">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-12 w-12 mx-auto mb-4 text-[var(--color-text-tertiary)]"
                viewBox="0 0 20 20"
                fill="currentColor"
              >
                <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
              </svg>
              <p className="text-[var(--color-text-secondary)] mb-4">
                Select a project to start chatting
              </p>
              <button
                onClick={() => setShowProjectPicker(true)}
                className="px-4 py-2 bg-[var(--color-accent)] rounded-lg hover:bg-[var(--color-accent-hover)] transition-colors"
              >
                Open Project
              </button>
            </div>
          </div>
        ) : isLoadingHistory && messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full">
            <div className="flex gap-1.5">
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:-0.3s]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-text-tertiary)] animate-bounce [animation-delay:-0.15s]" />
              <div className="w-2.5 h-2.5 rounded-full bg-[var(--color-text-tertiary)] animate-bounce" />
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {messages.map((msg, i) => (
              <div key={i}>
                {msg.role === "user" ? (
                  <div className="flex justify-end min-w-0">
                    <div className="max-w-[90%] sm:max-w-[85%] min-w-0">
                      <div className="rounded-2xl px-4 py-3 bg-[var(--color-accent)] overflow-hidden">
                        <div className="whitespace-pre-wrap break-anywhere">
                          {msg.content}
                        </div>
                      </div>
                    </div>
                  </div>
                ) : (
                  <StreamingResponse
                    thinking={msg.thinking}
                    activity={msg.activity}
                    content={msg.content}
                    task={msg.task}
                    startedAt={msg.startedAt}
                    completedAt={msg.completedAt}
                  />
                )}
              </div>
            ))}

            {isStreaming && (
              <StreamingResponse
                thinking={currentThinking}
                activity={currentActivity}
                content={currentResponse}
                task={currentTask}
                statusMessage={statusMessage}
                lastEventTime={lastEventTime}
                startedAt={
                  taskStartTime
                    ? new Date(taskStartTime).toISOString()
                    : undefined
                }
                isStreaming
              />
            )}

            {messages.length === 0 && !isStreaming && (
              <div className="flex flex-col items-center justify-center h-full text-center">
                <p className="text-[var(--color-text-tertiary)]">
                  Start a conversation with Claude in this project
                </p>
              </div>
            )}
          </div>
        )}

        <div ref={messagesEndRef} />
      </div>

      {/* Status bar — pinned above input during streaming */}
      {isStreaming && (
        <StreamingStatusBar
          statusMessage={statusMessage}
          lastEventTime={lastEventTime}
          startedAt={taskStartTime}
          thinking={currentThinking}
          content={currentResponse}
          activityCount={currentActivity.length}
        />
      )}

      {/* Input area */}
      <div className="border-t border-[var(--color-border-default)] bg-[var(--color-bg-primary)] px-3 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-4 sm:py-4">
        {error && !isReconnecting && (
          <div className="bg-red-900/80 border border-red-500 rounded-xl p-3 mb-3 flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <p className="text-red-300 text-sm break-words">{error}</p>
            </div>
            <button
              onClick={() => setError("")}
              className="shrink-0 text-red-400 hover:text-red-200 transition-colors"
              aria-label="Dismiss error"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
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
        )}
        {activeState.pendingQuestion && !isStreaming && (
          <AskUserQuestionCard
            questions={activeState.pendingQuestion.questions}
            onAnswer={handleToolAnswer}
            onDismiss={handleDismissQuestion}
          />
        )}
        <ChatInput
          isStreaming={isStreaming}
          onSend={handleSend}
          onCancel={handleCancel}
          serverId={serverConfig.id}
        />
      </div>
    </main>
  );
}
