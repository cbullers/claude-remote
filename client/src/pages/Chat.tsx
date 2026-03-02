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
  currentThinking: string;
  currentResponse: string;
  currentActivity: ToolActivity[];
  currentTask: string;
  taskStartTime: number | null;
  pendingQuestion: PendingQuestionData | null;
  statusMessage: string;
  lastEventTime: number;
}

interface OverflowMenuProps {
  onBrowseFiles: () => void;
  onViewChanges: () => void;
  onReset: () => void;
  onClearHistory: () => void;
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

  // Refs for streaming (per-project)
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

  // Current active project state
  const activeState =
    (activeProjectId ? projectStates.get(activeProjectId) : null) ||
    createEmptyProjectState();
  const messages = activeState.messages;
  const isStreaming = activeState.isStreaming;
  const currentThinking = activeState.currentThinking;
  const currentResponse = activeState.currentResponse;
  const currentActivity = activeState.currentActivity;
  const currentTask = activeState.currentTask;
  const taskStartTime = activeState.taskStartTime;
  const statusMessage = activeState.statusMessage;
  const lastEventTime = activeState.lastEventTime;

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
    messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
  }, []);

  // Fetch conversation history for a specific project
  const fetchProjectConversation = useCallback(
    async (projectId: string, retries = 3) => {
      console.log(`Fetching conversation history for project: ${projectId}`);
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await serverFetch(
            `/api/projects/${encodeURIComponent(projectId)}/conversation`,
          );
          if (!res.ok)
            throw new Error(`Failed to fetch history: ${res.status}`);
          const data = await res.json();
          console.log(
            `Loaded conversation for ${projectId}:`,
            data.messages?.length,
            "messages",
          );
          if (data.messages && data.messages.length > 0) {
            const loadedMessages = data.messages.map(
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
            updateProjectState(projectId, (state) => ({
              ...state,
              messages: loadedMessages,
            }));
            requestAnimationFrame(() => {
              requestAnimationFrame(() => {
                messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
              });
            });
          }
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
    },
    [serverFetch, updateProjectState],
  );

  const clearHistory = async () => {
    if (!activeProjectId) return;
    try {
      const res = await serverFetch(
        `/api/projects/${encodeURIComponent(activeProjectId)}/conversation`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(`Failed to clear history: ${res.status}`);
      updateProjectState(activeProjectId, (state) => ({
        ...state,
        messages: [],
      }));
    } catch (err) {
      setError(`Failed to clear history: ${err}`);
    }
  };

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

  useEffect(() => {
    const cachedPin = cachedPinRef.current;
    if (cachedPin) {
      console.log("Found cached PIN, auto-connecting...");

      // Restore tabs from localStorage
      const savedProjects = localStorage.getItem(projectsKey);
      const savedActiveId = localStorage.getItem(activeProjectKey);
      if (savedProjects) {
        try {
          const projects: Project[] = JSON.parse(savedProjects);
          if (projects.length > 0) {
            setOpenProjects(projects);
            const newStates = new Map<string, ProjectState>();
            projects.forEach((p) => {
              newStates.set(p.id, createEmptyProjectState());
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
          activeProjectIds?: string[];
          activity?: ToolActivity[];
          toolUse?: {
            tool: string;
            id?: string;
            input: Record<string, unknown>;
          };
          toolResult?: { tool: string; output?: string; error?: string };
        };
        try {
          msg = JSON.parse(decrypted);
        } catch (err) {
          console.error("[ws] Failed to parse decrypted message:", err);
          return;
        }

        const projectId = msg.projectId;

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
          if (activeIds.length > 0) {
            console.log("Active streaming projects on reconnect:", activeIds);
            setStreamingProjectIds(
              new Set(activeIds.filter((id) => id !== "__global__")),
            );
            activeIds.forEach((projectId) => {
              if (projectId !== "__global__") {
                updateProjectState(projectId, (state) => ({
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

            if (savedProjects) {
              try {
                const projects: Project[] = JSON.parse(savedProjects);
                if (projects.length > 0) {
                  setOpenProjects(projects);
                  const newStates = new Map<string, ProjectState>();
                  projects.forEach((p) => {
                    const isStreaming = activeIds.includes(p.id);
                    newStates.set(p.id, {
                      ...createEmptyProjectState(),
                      isStreaming,
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
                    fetchProjectConversation(p.id);
                  });
                  return;
                }
              } catch (err) {
                console.error("Failed to restore saved projects:", err);
              }
            }
            setShowProjectPicker(true);
          } else {
            const savedProjects = localStorage.getItem(projectsKey);
            if (savedProjects) {
              try {
                const projects: Project[] = JSON.parse(savedProjects);
                projects.forEach((p) => fetchProjectConversation(p.id));
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
        } else if (msg.type === "streaming_restore" && projectId) {
          console.log(`Restoring streaming state for ${projectId}:`, {
            thinking: msg.thinking?.length || 0,
            text: msg.text?.length || 0,
            activity: msg.activity?.length || 0,
          });

          if (msg.thinking) thinkingRefs.current.set(projectId, msg.thinking);
          if (msg.text) responseRefs.current.set(projectId, msg.text);
          if (msg.activity && msg.activity.length > 0)
            activityRefs.current.set(projectId, msg.activity);

          updateProjectState(projectId, (state) => ({
            ...state,
            isStreaming: true,
            currentThinking: msg.thinking || "",
            currentResponse: msg.text || "",
            currentActivity: msg.activity || [],
          }));
        } else if (msg.type === "status" && projectId) {
          updateProjectState(projectId, (state) => ({
            ...state,
            statusMessage: msg.text || "",
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "thinking" && projectId) {
          const currentThinking = thinkingRefs.current.get(projectId) || "";
          thinkingRefs.current.set(
            projectId,
            currentThinking + (msg.text || ""),
          );
          updateProjectState(projectId, (state) => ({
            ...state,
            currentThinking: thinkingRefs.current.get(projectId) || "",
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "text" && projectId) {
          const currentResponse = responseRefs.current.get(projectId) || "";
          const delimiter = currentResponse ? "\n" : "";
          responseRefs.current.set(
            projectId,
            currentResponse + delimiter + (msg.text || ""),
          );
          updateProjectState(projectId, (state) => ({
            ...state,
            currentResponse: responseRefs.current.get(projectId) || "",
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "tool_use" && msg.toolUse && projectId) {
          const activity: ToolActivity = {
            type: "tool_use",
            tool: msg.toolUse.tool,
            id: msg.toolUse.id,
            input: msg.toolUse.input,
            timestamp: Date.now(),
          };
          const currentActivity = activityRefs.current.get(projectId) || [];
          activityRefs.current.set(projectId, [...currentActivity, activity]);

          if (
            msg.toolUse.tool === "AskUserQuestion" &&
            msg.toolUse.input?.questions
          ) {
            updateProjectState(projectId, (state) => ({
              ...state,
              currentActivity: activityRefs.current.get(projectId) || [],
              lastEventTime: Date.now(),
              pendingQuestion: {
                toolUseId: msg.toolUse!.id || "",
                questions: msg.toolUse!.input
                  .questions as PendingQuestionData["questions"],
              },
            }));
          } else {
            updateProjectState(projectId, (state) => ({
              ...state,
              currentActivity: activityRefs.current.get(projectId) || [],
              lastEventTime: Date.now(),
            }));
          }
        } else if (msg.type === "tool_result" && msg.toolResult && projectId) {
          const activity: ToolActivity = {
            type: "tool_result",
            tool: msg.toolResult.tool,
            output: msg.toolResult.output,
            error: msg.toolResult.error,
            timestamp: Date.now(),
          };
          const currentActivity = activityRefs.current.get(projectId) || [];
          activityRefs.current.set(projectId, [...currentActivity, activity]);
          updateProjectState(projectId, (state) => ({
            ...state,
            currentActivity: activityRefs.current.get(projectId) || [],
            lastEventTime: Date.now(),
          }));
        } else if (msg.type === "done" && projectId) {
          const thinking = thinkingRefs.current.get(projectId) || "";
          const response = responseRefs.current.get(projectId) || "";
          const activity = activityRefs.current.get(projectId) || [];

          setStreamingProjectIds((prev) => {
            const next = new Set(prev);
            next.delete(projectId);
            return next;
          });

          updateProjectState(projectId, (state) => {
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

          thinkingRefs.current.delete(projectId);
          responseRefs.current.delete(projectId);
          activityRefs.current.delete(projectId);
        } else if (msg.type === "error") {
          console.error("Server error:", msg.error);
          setError(msg.error || "Unknown server error");
          if (projectId) {
            setStreamingProjectIds((prev) => {
              const next = new Set(prev);
              next.delete(projectId);
              return next;
            });
            updateProjectState(projectId, (state) => ({
              ...state,
              isStreaming: false,
            }));
          }
        } else if (msg.type === "sync_user_message" && msg.projectId) {
          console.log(
            `[sync] User message from another device for ${msg.projectId}`,
          );
          updateProjectState(msg.projectId, (state) => ({
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
          thinkingRefs.current.set(msg.projectId, "");
          responseRefs.current.set(msg.projectId, "");
          activityRefs.current.set(msg.projectId, []);
        } else if (msg.type === "sync_cancel" && msg.projectId) {
          console.log(`[sync] Cancel from another device for ${msg.projectId}`);
          setStreamingProjectIds((prev) => {
            const next = new Set(prev);
            next.delete(msg.projectId!);
            return next;
          });
          updateProjectState(msg.projectId, (state) => ({
            ...state,
            isStreaming: false,
          }));
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

      const taskStartTime = Date.now();
      updateProjectState(activeProjectId, (state) => ({
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

      thinkingRefs.current.set(activeProjectId, "");
      responseRefs.current.set(activeProjectId, "");
      activityRefs.current.set(activeProjectId, []);

      try {
        const encrypted = await encrypt(
          JSON.stringify({ type: "message", text, projectId: activeProjectId }),
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
        updateProjectState(activeProjectId, (state) => ({
          ...state,
          isStreaming: false,
        }));
      }
    },
    [activeProjectId, isStreaming, updateProjectState],
  );

  const handleCancel = useCallback(async () => {
    if (!activeProjectId) return;

    setStreamingProjectIds((prev) => {
      const next = new Set(prev);
      next.delete(activeProjectId);
      return next;
    });
    updateProjectState(activeProjectId, (state) => ({
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
          JSON.stringify({ type: "cancel", projectId: activeProjectId }),
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
  }, [activeProjectId, updateProjectState, serverFetch]);

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

      updateProjectState(activeProjectId, (state) => ({
        ...state,
        pendingQuestion: null,
        isStreaming: true,
        currentThinking: "",
        currentResponse: "",
        currentActivity: [],
      }));

      setStreamingProjectIds((prev) => new Set(prev).add(activeProjectId));
      thinkingRefs.current.set(activeProjectId, "");
      responseRefs.current.set(activeProjectId, "");
      activityRefs.current.set(activeProjectId, []);

      try {
        const encrypted = await encrypt(
          JSON.stringify({
            type: "tool_answer",
            answers,
            projectId: activeProjectId,
          }),
          sharedKeyRef.current,
        );
        wsRef.current.send(JSON.stringify(encrypted));
      } catch (err) {
        setError(`Failed to send answer: ${err}`);
        updateProjectState(activeProjectId, (state) => ({
          ...state,
          isStreaming: false,
        }));
      }
    },
    [activeProjectId, updateProjectState],
  );

  const handleDismissQuestion = useCallback(() => {
    if (!activeProjectId) return;
    updateProjectState(activeProjectId, (state) => ({
      ...state,
      pendingQuestion: null,
    }));
  }, [activeProjectId, updateProjectState]);

  const handleSelectProject = (project: Project) => {
    console.log("Selected project:", project.id);

    if (!openProjects.find((p) => p.id === project.id)) {
      setOpenProjects((prev) => [...prev, project]);
      if (!projectStates.has(project.id)) {
        setProjectStates((prev) => {
          const next = new Map(prev);
          next.set(project.id, createEmptyProjectState());
          return next;
        });
      }
      fetchProjectConversation(project.id);
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

    setProjectStates((prev) => {
      const next = new Map(prev);
      next.delete(projectId);
      return next;
    });
  };

  const handleReset = () => {
    setError("");
    if (activeProjectId) {
      setStreamingProjectIds((prev) => {
        const next = new Set(prev);
        next.delete(activeProjectId);
        return next;
      });
      updateProjectState(activeProjectId, (state) => ({
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
    <main className="h-[100dvh] flex flex-col bg-[var(--color-bg-primary)] text-[var(--color-text-primary)]">
      {/* Header: Project dropdown + git status + overflow menu */}
      <header className="flex items-center justify-between px-4 py-2 border-b border-[var(--color-border-default)] bg-[var(--color-bg-primary)] sticky top-0 z-20">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <ProjectTabs
            projects={openProjects}
            activeProjectId={activeProjectId}
            streamingProjectIds={streamingProjectIds}
            onSelectProject={setActiveProjectId}
            onCloseProject={handleCloseProject}
            onAddProject={() => setShowProjectPicker(true)}
          />
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
