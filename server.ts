import { config } from "dotenv";
config({ path: ".env.local" });

import { createServer, IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { WebSocketServer, WebSocket } from "ws";
import { randomBytes, timingSafeEqual, createHash } from "crypto";
import {
  readFileSync,
  existsSync,
  appendFileSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "fs";
import { execSync } from "child_process";
import { homedir, hostname } from "os";
import qrcode from "qrcode-terminal";
import { join, resolve } from "path";
import {
  generateKeyPair,
  deriveSharedSecret,
  encrypt,
  decrypt,
  EncryptedData,
} from "./src/lib/crypto";
import {
  loadDevices,
  addDevice,
  removeDevice,
  loadServerState,
  saveServerState,
  verifyPin,
  hashPin,
  loadConversation,
  addMessage,
  clearConversation,
  getClaudeSessionId,
  saveClaudeSessionId,
  Device,
  ServerState,
  Message,
  ToolActivity,
  OutputChunk,
  // Project support
  validateProjectId,
  listProjects,
  getProject,
  loadProjectConversation,
  addProjectMessage,
  clearProjectConversation,
  getProjectSessionId,
  saveProjectSessionId,
  // Multi-conversation support
  listProjectConversations,
  createProjectConversation,
  deleteProjectConversation,
  renameProjectConversation,
  getConversationName,
  // Worktree support
  listBranches,
  createWorktree,
  removeWorktree,
} from "./src/lib/store";
import { spawnClaude, ClaudeEvent } from "./src/lib/claude";
import {
  initVapid,
  getVapidPublicKey,
  addSubscription,
  removeSubscription,
  sendPushToAll,
} from "./src/lib/push";

// Track active Claude processes per device per project
// Key format: `${deviceId}:${projectId}` or just `${deviceId}` for legacy
const activeJobs: Map<string, AbortController> = new Map();
// Track connected WebSockets per device
const connectedClients: Map<string, WebSocket> = new Map();
// Track which projects have already sent the "rejoined" context note this server boot
const rejoinNoteSent: Set<string> = new Set();

// Track pending AskUserQuestion prompts waiting for user response
interface PendingQuestion {
  toolUseId: string;
  questions: Array<{
    question: string;
    header?: string;
    options?: Array<{ label: string; description?: string }>;
    multiSelect?: boolean;
  }>;
  projectId?: string;
  sessionId: string;
}
const pendingQuestions: Map<string, PendingQuestion> = new Map();

// Rate limiting for auth attempts per IP
const AUTH_MAX_ATTEMPTS = 5;
const AUTH_WINDOW_MS = 60_000; // 1 minute
const authAttempts: Map<string, { count: number; resetAt: number }> = new Map();

function checkAuthRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    return true;
  }
  return entry.count < AUTH_MAX_ATTEMPTS;
}

function recordAuthFailure(ip: string): void {
  const now = Date.now();
  const entry = authAttempts.get(ip);
  if (!entry || now >= entry.resetAt) {
    authAttempts.set(ip, { count: 1, resetAt: now + AUTH_WINDOW_MS });
  } else {
    entry.count++;
  }
}

// Device token TTL: 6 months
const DEVICE_TOKEN_TTL_MS = 6 * 30 * 24 * 60 * 60 * 1000;

function generateDeviceToken(): { token: string; tokenExpiresAt: string } {
  return {
    token: randomBytes(32).toString("hex"),
    tokenExpiresAt: new Date(Date.now() + DEVICE_TOKEN_TTL_MS).toISOString(),
  };
}

function computeAuthHash(pin: string, deviceToken: string): string {
  return createHash("sha256")
    .update(pin + deviceToken)
    .digest("hex");
}

// Broadcast reload message to all connected clients (for dev hot reload)
function broadcastReload() {
  console.log("[dev] Broadcasting reload to", connectedClients.size, "clients");
  const devices = loadDevices();
  for (const [deviceId, ws] of connectedClients.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      const device = devices.find((d) => d.id === deviceId);
      if (device) {
        const encrypted = encrypt(
          JSON.stringify({ type: "reload" }),
          device.sharedSecret,
        );
        ws.send(JSON.stringify(encrypted));
        console.log(`[dev] Sent reload to device ${deviceId}`);
      }
    }
  }
}

// Broadcast an event to all connected clients except the sender
function broadcastToOthers(excludeDeviceId: string, event: object) {
  for (const [connDeviceId, connWs] of connectedClients.entries()) {
    if (connDeviceId === excludeDeviceId) continue;
    if (connWs.readyState !== WebSocket.OPEN) continue;
    const connDevice = devices.find((d) => d.id === connDeviceId);
    if (connDevice) {
      const encrypted = encrypt(JSON.stringify(event), connDevice.sharedSecret);
      connWs.send(JSON.stringify(encrypted));
    }
  }
}

// Helper to create job key
function jobKey(
  deviceId: string,
  projectId?: string,
  conversationId?: string,
): string {
  if (projectId && conversationId) {
    return `${deviceId}:${projectId}:${conversationId}`;
  }
  return projectId ? `${deviceId}:${projectId}` : deviceId;
}

// Generate a conversation name from the user's first message using AI summarization
async function generateConversationName(userText: string): Promise<string> {
  const cleaned = userText.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Chat";

  // For very short messages, just use them directly
  if (cleaned.length <= 30) return cleaned;

  try {
    const { spawn } = await import("child_process");
    const { tmpdir } = await import("os");
    const prompt = `Summarize this chat message into a short title (max 50 chars, no quotes, no punctuation at end). Just output the title, nothing else.\n\nMessage: ${cleaned.slice(0, 500)}`;
    const result = await new Promise<string>((resolve, reject) => {
      const proc = spawn("/usr/local/bin/claude", ["--print", "--model", "haiku", "-p", prompt], {
        cwd: tmpdir(),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      proc.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      proc.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });
      proc.on("close", (code) => {
        if (code === 0 && stdout.trim()) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`claude exited ${code}, stderr: ${stderr}, stdout: ${stdout}`));
        }
      });
      proc.on("error", reject);
      proc.stdin.end();
      setTimeout(() => { proc.kill(); reject(new Error("timeout")); }, 30000);
    });

    // Strip markdown bold/italic and take only the first line
    const title = result.replace(/\*+/g, "").split("\n")[0].trim();
    if (title && title.length > 0 && title.length <= 60) {
      return title;
    }
  } catch (err) {
    console.error("[auto-name] AI summarization failed, using fallback:", err);
  }

  // Fallback: truncate at word boundary
  if (cleaned.length <= 50) return cleaned;
  const truncated = cleaned.slice(0, 50);
  const lastSpace = truncated.lastIndexOf(" ");
  return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + "...";
}

// Events file path
const configDir = join(homedir(), ".config", "claude-remote");
const eventsFile = join(configDir, "events.jsonl");

function appendEvent(deviceId: string, event: ClaudeEvent) {
  const line = JSON.stringify({ deviceId, event, ts: Date.now() }) + "\n";
  appendFileSync(eventsFile, line);
}

// Persist last flushed timestamp per device to disk
const lastFlushedFile = join(configDir, "last-flushed.json");

function loadLastFlushedTs(): Record<string, number> {
  try {
    if (!existsSync(lastFlushedFile)) return {};
    return JSON.parse(readFileSync(lastFlushedFile, "utf-8"));
  } catch {
    return {};
  }
}

function saveLastFlushedTs(deviceId: string, ts: number) {
  const data = loadLastFlushedTs();
  data[deviceId] = ts;
  writeFileSync(lastFlushedFile, JSON.stringify(data, null, 2));
}

function loadPendingEvents(deviceId: string): ClaudeEvent[] {
  if (!existsSync(eventsFile)) return [];
  const lines = readFileSync(eventsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const events: ClaudeEvent[] = [];
  const lastTs = loadLastFlushedTs()[deviceId] || 0;
  let maxTs = lastTs;
  for (const line of lines) {
    try {
      const { deviceId: did, event, ts } = JSON.parse(line);
      if (did === deviceId && ts > lastTs) {
        events.push(event);
        if (ts > maxTs) maxTs = ts;
      }
    } catch {
      // skip malformed event lines
    }
  }
  if (maxTs > lastTs) saveLastFlushedTs(deviceId, maxTs);
  return events;
}

function _clearPendingEvents(deviceId: string) {
  if (!existsSync(eventsFile)) return;
  const lines = readFileSync(eventsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const remaining = lines.filter((line) => {
    try {
      const { deviceId: did } = JSON.parse(line);
      return did !== deviceId;
    } catch {
      return true;
    }
  });
  writeFileSync(
    eventsFile,
    remaining.join("\n") + (remaining.length ? "\n" : ""),
  );
}

// Partial response persistence (survives crashes)
const partialResponseFile = join(configDir, "partial-responses.json");

interface PartialResponse {
  text: string;
  thinking: string;
  activity: ToolActivity[];
  updatedAt: number;
}

function loadPartialResponses(): Record<string, PartialResponse> {
  try {
    if (!existsSync(partialResponseFile)) return {};
    return JSON.parse(readFileSync(partialResponseFile, "utf-8"));
  } catch {
    return {};
  }
}

// Debounced partial response saving — at most once per second
const pendingPartials: Map<
  string,
  { text: string; thinking: string; activity: ToolActivity[] }
> = new Map();
let partialSaveTimer: ReturnType<typeof setTimeout> | null = null;

function flushPartialResponses() {
  if (pendingPartials.size === 0) return;
  const data = loadPartialResponses();
  for (const [key, partial] of pendingPartials) {
    data[key] = { ...partial, updatedAt: Date.now() };
  }
  pendingPartials.clear();
  writeFileSync(partialResponseFile, JSON.stringify(data, null, 2));
}

function savePartialResponse(
  deviceId: string,
  text: string,
  thinking: string,
  activity: ToolActivity[] = [],
) {
  pendingPartials.set(deviceId, { text, thinking, activity });
  if (!partialSaveTimer) {
    partialSaveTimer = setTimeout(() => {
      partialSaveTimer = null;
      flushPartialResponses();
    }, 1000);
  }
}

function clearPartialResponse(deviceId: string) {
  const data = loadPartialResponses();
  delete data[deviceId];
  writeFileSync(partialResponseFile, JSON.stringify(data, null, 2));
}

function recoverPartialResponses() {
  // On startup, check for partial responses and save them as messages
  // Key format: "deviceId:projectId:conversationId" or "deviceId:projectId" or "deviceId"
  const partials = loadPartialResponses();
  for (const [key, partial] of Object.entries(partials)) {
    if (!partial.text && !partial.thinking && partial.activity.length === 0) continue;

    const parts = key.split(":");
    const now = new Date(partial.updatedAt).toISOString();
    const msg: Message = {
      role: "assistant",
      content: partial.text || "",
      thinking: partial.thinking || undefined,
      activity: partial.activity.length > 0 ? partial.activity : undefined,
      completedAt: now,
      timestamp: now,
    };

    if (parts.length >= 3) {
      // deviceId:projectId:conversationId (conversationId may contain colons)
      const projectId = parts[1];
      const conversationId = parts.slice(2).join(":");
      console.log(
        `[recovery] Saving partial response for project ${projectId}/${conversationId}`,
      );
      try {
        addProjectMessage(projectId, msg, conversationId);
      } catch (err) {
        console.error(`[recovery] Failed to save partial for ${projectId}/${conversationId}:`, err);
      }
    } else if (parts.length === 2) {
      // deviceId:projectId (default conversation)
      const projectId = parts[1];
      console.log(
        `[recovery] Saving partial response for project ${projectId}/default`,
      );
      try {
        addProjectMessage(projectId, msg);
      } catch (err) {
        console.error(`[recovery] Failed to save partial for ${projectId}:`, err);
      }
    } else {
      // Global conversation
      console.log(`[recovery] Saving partial response to global conversation`);
      addMessage(msg);
    }
  }
  // Clear all partials after recovery
  writeFileSync(partialResponseFile, "{}");
}

const port = parseInt(process.env.PORT || "6767", 10);
const clientUrl = process.env.CLIENT_URL || `http://localhost:5173`;
const serverUrl = process.env.SERVER_URL || `http://localhost:${port}`;

const PIN = process.env.CLAUDE_REMOTE_PIN;
if (!PIN) {
  console.error("CLAUDE_REMOTE_PIN environment variable is required");
  process.exit(1);
}

let pinHash: string;
let serverState: ServerState;
let devices: Device[] = [];

function initializeServer() {
  devices = loadDevices();
  const existingState = loadServerState();

  if (existingState) {
    // Always keep pairing token active for multi-device support
    if (!existingState.pairingToken) {
      existingState.pairingToken = randomBytes(16).toString("hex");
    }
    serverState = existingState;
  } else {
    const keyPair = generateKeyPair();
    serverState = {
      privateKey: keyPair.privateKey,
      publicKey: keyPair.publicKey,
      pairingToken: randomBytes(16).toString("hex"),
    };
  }
  saveServerState(serverState);
}

function reloadState() {
  devices = loadDevices();
  const existingState = loadServerState();
  if (existingState) {
    serverState = existingState;
  }
}

// Try all devices to avoid timing side-channel leaking which device index matched
function findDeviceByDecryption(encrypted: EncryptedData): Device | null {
  let matched: Device | null = null;
  for (const device of devices) {
    try {
      decrypt(encrypted, device.sharedSecret);
      matched = device;
    } catch {
      // Try next device
    }
  }
  return matched;
}

function json(res: ServerResponse, data: object, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

// API authentication: validate SHA-256(PIN + deviceToken) with rate limiting
function checkApiAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const clientIp =
    req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  if (!checkAuthRateLimit(clientIp)) {
    json(res, { error: "Too many attempts. Try again later." }, 429);
    return false;
  }

  const auth = req.headers["authorization"];
  if (!auth || !auth.startsWith("Bearer ")) {
    recordAuthFailure(clientIp);
    json(res, { error: "Unauthorized" }, 401);
    return false;
  }
  const providedHash = auth.slice(7);
  const providedBuf = Buffer.from(providedHash, "utf8");

  // Try each device's token, check all to avoid timing side-channel
  let matched = false;
  for (const device of devices) {
    // Skip expired device tokens
    if (new Date(device.tokenExpiresAt) <= new Date()) continue;

    const expectedHash = computeAuthHash(PIN!, device.token);
    const expectedBuf = Buffer.from(expectedHash, "utf8");
    if (
      providedBuf.length === expectedBuf.length &&
      timingSafeEqual(providedBuf, expectedBuf)
    ) {
      matched = true;
    }
  }

  if (!matched) {
    recordAuthFailure(clientIp);
    json(res, { error: "Unauthorized" }, 401);
    return false;
  }
  return true;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse) {
  const { pathname } = parse(req.url || "", true);
  const method = req.method || "GET";

  // Log API requests for debugging
  if (pathname?.startsWith("/api/")) {
    console.log(`[http] ${method} ${pathname}`);
  }

  // CORS: restrict to known origins + configurable extras for multi-server
  const extraOrigins = (process.env.CORS_ORIGINS || "")
    .split(",")
    .filter(Boolean);
  const allowedOrigins = [clientUrl, ...extraOrigins].filter(Boolean);
  const origin = req.headers["origin"];
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // Auth gate: all /api/ routes require PIN auth, except:
  // - /api/status (limited info without auth)
  // - /api/new-pair-token from localhost (if you're on the machine, you're authorized)
  const isLocalhost =
    req.socket.remoteAddress === "127.0.0.1" ||
    req.socket.remoteAddress === "::1" ||
    req.socket.remoteAddress === "::ffff:127.0.0.1";
  const authExempt =
    pathname === "/api/status" ||
    (pathname === "/api/new-pair-token" && isLocalhost);
  if (pathname?.startsWith("/api/") && !authExempt) {
    if (!checkApiAuth(req, res)) return;
  }

  // API: Status - limited info without auth, full info with auth
  if (pathname === "/api/status" && method === "GET") {
    reloadState();
    // Check if caller is authenticated (optional) via device token hash
    const auth = req.headers["authorization"];
    const isAuthed = (() => {
      if (!auth || !auth.startsWith("Bearer ")) return false;
      const providedHash = auth.slice(7);
      const providedBuf = Buffer.from(providedHash, "utf8");
      for (const device of devices) {
        if (new Date(device.tokenExpiresAt) <= new Date()) continue;
        const expectedHash = computeAuthHash(PIN!, device.token);
        const expectedBuf = Buffer.from(expectedHash, "utf8");
        if (
          providedBuf.length === expectedBuf.length &&
          timingSafeEqual(providedBuf, expectedBuf)
        ) {
          return true;
        }
      }
      return false;
    })();

    const serverName = process.env.SERVER_NAME || hostname();

    if (isAuthed) {
      return json(res, {
        paired: devices.length > 0,
        devices: devices.map((d) => ({
          id: d.id,
          createdAt: d.createdAt,
          tokenExpiresAt: d.tokenExpiresAt,
        })),
        deviceCount: devices.length,
        serverName,
        pairingUrl: serverState.pairingToken
          ? `${clientUrl}/pair?server=${encodeURIComponent(serverUrl)}&token=${serverState.pairingToken}`
          : null,
      });
    }

    // Unauthenticated: limited info only
    return json(res, {
      paired: devices.length > 0,
      deviceCount: devices.length,
      serverName,
    });
  }

  // API: Generate new pairing token (invalidates previous one)
  if (pathname === "/api/new-pair-token" && method === "POST") {
    reloadState();
    serverState.pairingToken = randomBytes(16).toString("hex");
    saveServerState(serverState);
    const pairUrl = `${clientUrl}/pair?server=${encodeURIComponent(serverUrl)}&token=${serverState.pairingToken}`;
    console.log(`> New pairing token generated`);
    console.log(`> URL: ${pairUrl}`);
    console.log("");
    qrcode.generate(pairUrl, { small: true });
    return json(res, {
      pairingUrl: pairUrl,
      token: serverState.pairingToken,
    });
  }

  // API: Dev reload - broadcasts reload message to all connected clients
  if (pathname === "/api/dev/reload" && method === "POST") {
    broadcastReload();
    return json(res, { ok: true, clients: connectedClients.size });
  }

  // API: Dev full reload - triggers Flutter hot restart then broadcasts reload
  if (pathname === "/api/dev/full-reload" && method === "POST") {
    try {
      // Send SIGUSR2 to Flutter process for hot restart
      const pidFile = join(process.cwd(), "logs", "flutter.pid");
      if (existsSync(pidFile)) {
        const pid = readFileSync(pidFile, "utf-8").trim();
        process.kill(parseInt(pid), "SIGUSR2");
        console.log("[dev] Sent SIGUSR2 to Flutter process", pid);
      }
      // Wait for Flutter to rebuild, then broadcast reload
      setTimeout(() => {
        broadcastReload();
      }, 2000);
      return json(res, {
        ok: true,
        message: "Flutter restart triggered, reload will broadcast in 2s",
      });
    } catch (e) {
      console.error("[dev] Full reload failed:", e);
      return json(res, { ok: false, error: String(e) }, 500);
    }
  }

  // API: Get conversation history
  if (pathname === "/api/conversation" && method === "GET") {
    const conversation = loadConversation();
    console.log(
      "[api] Returning conversation with",
      conversation.messages.length,
      "messages",
    );
    return json(res, conversation);
  }

  // API: Clear conversation
  if (pathname === "/api/conversation" && method === "DELETE") {
    clearConversation();
    console.log("[api] Conversation cleared");
    return json(res, { success: true });
  }

  // API: List available projects
  if (pathname === "/api/projects" && method === "GET") {
    const projects = listProjects();
    console.log("[api] Returning", projects.length, "projects");
    return json(res, { projects });
  }

  // API: List conversations for a project
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.endsWith("/conversations") &&
    method === "GET"
  ) {
    const projectId = decodeURIComponent(
      pathname.split("/api/projects/")[1].replace("/conversations", ""),
    );
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const conversations = listProjectConversations(projectId);
    console.log(
      `[api] Returning ${conversations.length} conversations for project ${projectId}`,
    );
    return json(res, { conversations });
  }

  // API: Create a new conversation for a project
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.endsWith("/conversations") &&
    method === "POST"
  ) {
    const projectId = decodeURIComponent(
      pathname.split("/api/projects/")[1].replace("/conversations", ""),
    );
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) return json(res, { error: "Project not found" }, 404);

    let name: string | undefined;
    try {
      const body = await readBody(req);
      if (body) {
        const parsed = JSON.parse(body);
        name = parsed.name;
      }
    } catch {
      // No body, use default name
    }

    const conversation = createProjectConversation(projectId, name);
    console.log(
      `[api] Created conversation ${conversation.id} for project ${projectId}`,
    );
    return json(res, { conversation }, 201);
  }

  // API: Delete or rename a specific conversation
  // Pattern: /api/projects/:id/conversations/:convId
  if (
    pathname?.match(
      /^\/api\/projects\/[^/]+\/conversations\/[^/]+$/,
    ) &&
    (method === "DELETE" || method === "PATCH")
  ) {
    const parts = pathname.split("/api/projects/")[1].split("/conversations/");
    const projectId = decodeURIComponent(parts[0]);
    const conversationId = decodeURIComponent(parts[1]);
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);

    if (method === "DELETE") {
      deleteProjectConversation(projectId, conversationId);
      console.log(
        `[api] Deleted conversation ${conversationId} for project ${projectId}`,
      );
      return json(res, { success: true });
    }

    if (method === "PATCH") {
      try {
        const body = await readBody(req);
        const { name } = JSON.parse(body);
        if (!name) return json(res, { error: "Missing name" }, 400);
        renameProjectConversation(projectId, conversationId, name);
        return json(res, { success: true });
      } catch (err) {
        return json(res, { error: String(err) }, 400);
      }
    }
  }

  // API: Get project conversation history (with optional conversationId)
  // Pattern: /api/projects/:id/conversation or /api/projects/:id/conversation/:convId
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.match(/\/conversation(\/|$)/) &&
    !pathname.match(/\/conversations(\/|$)/) &&
    method === "GET"
  ) {
    const afterProjects = pathname.split("/api/projects/")[1];
    const convIdx = afterProjects.indexOf("/conversation");
    const projectId = decodeURIComponent(afterProjects.substring(0, convIdx));
    const conversationId =
      decodeURIComponent(
        afterProjects
          .substring(convIdx + "/conversation".length)
          .replace(/^\//, ""),
      ) || undefined;

    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) {
      return json(res, { error: "Project not found" }, 404);
    }
    const conversation = loadProjectConversation(projectId, conversationId);
    console.log(
      `[api] Returning project ${projectId}/${conversationId || "default"} conversation with`,
      conversation.messages.length,
      "messages",
    );
    return json(res, conversation);
  }

  // API: Clear project conversation (with optional conversationId)
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.match(/\/conversation(\/|$)/) &&
    !pathname.match(/\/conversations(\/|$)/) &&
    method === "DELETE"
  ) {
    const afterProjects = pathname.split("/api/projects/")[1];
    const convIdx = afterProjects.indexOf("/conversation");
    const projectId = decodeURIComponent(afterProjects.substring(0, convIdx));
    const conversationId =
      decodeURIComponent(
        afterProjects
          .substring(convIdx + "/conversation".length)
          .replace(/^\//, ""),
      ) || undefined;

    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) {
      return json(res, { error: "Project not found" }, 404);
    }
    clearProjectConversation(projectId, conversationId);
    console.log(
      `[api] Project ${projectId}/${conversationId || "default"} conversation cleared`,
    );
    return json(res, { success: true });
  }

  // API: Get streaming state for a project (used on reconnect to restore UI state)
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.endsWith("/streaming") &&
    method === "GET"
  ) {
    const projectId = decodeURIComponent(
      pathname.split("/api/projects/")[1].replace("/streaming", ""),
    );
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);

    // Check if there's an active job for any device on this project
    let isStreaming = false;
    let streamingDeviceKey: string | null = null;
    for (const key of activeJobs.keys()) {
      if (key.endsWith(`:${projectId}`)) {
        isStreaming = true;
        streamingDeviceKey = key;
        break;
      }
    }

    // Get partial response if streaming
    let partialResponse: PartialResponse | null = null;
    if (streamingDeviceKey) {
      const partials = loadPartialResponses();
      partialResponse = partials[streamingDeviceKey] || null;
    }

    console.log(
      `[api] Streaming state for ${projectId}: isStreaming=${isStreaming}`,
    );
    return json(res, {
      isStreaming,
      partial: partialResponse
        ? {
            text: partialResponse.text,
            thinking: partialResponse.thinking,
            activity: partialResponse.activity,
          }
        : null,
    });
  }

  // API: Cancel task for a project (HTTP fallback for unreliable WebSocket)
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.endsWith("/cancel") &&
    method === "POST"
  ) {
    const projectId = decodeURIComponent(
      pathname.split("/api/projects/")[1].replace("/cancel", ""),
    );
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    console.log(`[api] HTTP cancel requested for project: ${projectId}`);

    // Find and abort all active jobs for this project (any device)
    let cancelled = 0;
    for (const [key, controller] of activeJobs.entries()) {
      if (key.endsWith(`:${projectId}`)) {
        console.log(`[api] Aborting job: ${key}`);
        controller.abort();
        activeJobs.delete(key);
        cancelled++;
      }
    }

    return json(res, { ok: true, cancelled });
  }

  // API: Get git status for a project
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.endsWith("/git") &&
    method === "GET"
  ) {
    const projectId = decodeURIComponent(
      pathname.split("/api/projects/")[1].replace("/git", ""),
    );
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) {
      return json(res, { error: "Project not found" }, 404);
    }

    try {
      // Get current branch
      const branch = execSync("git rev-parse --abbrev-ref HEAD", {
        cwd: project.path,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();

      // Check if working directory is dirty
      const status = execSync("git status --porcelain", {
        cwd: project.path,
        encoding: "utf-8",
        timeout: 5000,
      }).trim();
      const isDirty = status.length > 0;

      // Parse changed files
      const changedFiles = status ? status.split("\n").length : 0;
      const files = status
        ? status.split("\n").map((line) => {
            // Porcelain format: XY PATH (2 status chars + space + path)
            const match = line.match(/^(..) (.+)$/);
            return match
              ? { status: match[1].trim(), path: match[2] }
              : { status: "?", path: line.trim() };
          })
        : [];

      // Get ahead/behind counts (may fail if no upstream)
      let ahead = 0;
      let behind = 0;
      try {
        const counts = execSync(
          "git rev-list --left-right --count HEAD...@{upstream}",
          {
            cwd: project.path,
            encoding: "utf-8",
            timeout: 5000,
          },
        )
          .trim()
          .split("\t");
        ahead = parseInt(counts[0], 10) || 0;
        behind = parseInt(counts[1], 10) || 0;
      } catch {
        // No upstream configured, ignore
      }

      // Worktree info + branches for worktree creation UI
      const isWorktree = !!project.worktree;
      const parentRepoId = project.worktree?.parentRepoId || null;
      let branches: string[] = [];
      try {
        branches = listBranches(projectId);
      } catch {
        // Not critical
      }

      console.log(
        `[api] Git status for ${projectId}: ${branch} ${isDirty ? "(dirty)" : "(clean)"}`,
      );
      return json(res, {
        branch,
        isDirty,
        changedFiles,
        files,
        ahead,
        behind,
        isWorktree,
        parentRepoId,
        branches,
      });
    } catch (err) {
      // Not a git repo or git not available
      console.log(`[api] Git status failed for ${projectId}:`, err);
      return json(res, { error: "Not a git repository" }, 400);
    }
  }

  // API: Get PR info for a project's current branch
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.endsWith("/pr") &&
    method === "GET"
  ) {
    const projectId = decodeURIComponent(
      pathname.split("/api/projects/")[1].replace("/pr", ""),
    );
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) {
      return json(res, { error: "Project not found" }, 404);
    }

    try {
      const prJson = execSync("gh pr view --json url,number,title,state", {
        cwd: project.path,
        encoding: "utf-8",
        timeout: 10000,
      }).trim();
      const pr = JSON.parse(prJson);
      console.log(
        `[api] PR info for ${projectId}: #${pr.number} (${pr.state})`,
      );
      return json(res, pr);
    } catch {
      console.log(`[api] No PR found for ${projectId}`);
      return json(res, { error: "No PR found" }, 404);
    }
  }

  // API: Worktree management
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.endsWith("/worktrees")
  ) {
    const projectId = decodeURIComponent(
      pathname.split("/api/projects/")[1].replace("/worktrees", ""),
    );
    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) {
      return json(res, { error: "Project not found" }, 404);
    }

    // GET: List worktrees
    if (method === "GET") {
      try {
        // Use listProjects and filter to worktrees of this repo
        const mainRepoId = project.worktree
          ? project.worktree.parentRepoId
          : project.id;
        const allProjects = listProjects();
        const worktrees = allProjects.filter(
          (p) => p.worktree?.parentRepoId === mainRepoId || p.id === mainRepoId,
        );
        console.log(
          `[api] Listed ${worktrees.length} worktrees for ${projectId}`,
        );
        return json(res, { worktrees });
      } catch (err) {
        console.error(`[api] Failed to list worktrees for ${projectId}:`, err);
        return json(res, { error: String(err) }, 500);
      }
    }

    // POST: Create worktree
    if (method === "POST") {
      try {
        const body = await readBody(req);
        const { branch } = JSON.parse(body);
        if (!branch || typeof branch !== "string") {
          return json(res, { error: "Missing or invalid branch name" }, 400);
        }

        // Basic git ref validation
        const hasBadChars = branch.split("").some((ch) => {
          const code = ch.charCodeAt(0);
          return code <= 0x1f || code === 0x7f || "~^:?*[]\\".includes(ch);
        });
        if (hasBadChars || branch.includes("..")) {
          return json(res, { error: "Invalid branch name" }, 400);
        }

        const newProject = createWorktree(projectId, branch);
        console.log(
          `[api] Created worktree ${newProject.id} for branch ${branch}`,
        );
        return json(res, { project: newProject }, 201);
      } catch (err) {
        console.error(`[api] Failed to create worktree for ${projectId}:`, err);
        return json(res, { error: String(err) }, 500);
      }
    }

    // DELETE: Remove worktree
    if (method === "DELETE") {
      if (!project.worktree) {
        return json(res, { error: "Not a worktree" }, 400);
      }

      try {
        removeWorktree(projectId);
        console.log(`[api] Removed worktree ${projectId}`);
        return json(res, { success: true });
      } catch (err) {
        console.error(`[api] Failed to remove worktree ${projectId}:`, err);
        return json(res, { error: String(err) }, 500);
      }
    }
  }

  // API: File tree - browse project files
  // Pattern: /api/projects/:id/tree or /api/projects/:id/tree/subdir/path
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.match(/\/tree(\/|$)/) &&
    method === "GET"
  ) {
    const afterProjects = pathname.split("/api/projects/")[1];
    const treeIdx = afterProjects.indexOf("/tree");
    const projectId = decodeURIComponent(afterProjects.substring(0, treeIdx));
    const subPath = decodeURIComponent(
      afterProjects.substring(treeIdx + "/tree".length).replace(/^\//, ""),
    );

    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) return json(res, { error: "Project not found" }, 404);

    const targetDir = resolve(project.path, subPath || ".");
    if (!targetDir.startsWith(project.path)) {
      return json(res, { error: "Path traversal not allowed" }, 400);
    }

    try {
      const names = readdirSync(targetDir);
      const entries: Array<{
        name: string;
        type: "file" | "dir";
        size?: number;
        modified?: string;
      }> = [];

      for (const name of names) {
        if (name.startsWith(".") || name === "node_modules") continue;
        try {
          const stat = statSync(join(targetDir, name));
          entries.push({
            name,
            type: stat.isDirectory() ? "dir" : "file",
            size: stat.isDirectory() ? undefined : stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch {
          // Skip entries we can't stat
        }
      }

      // Directories first, then alphabetical
      entries.sort((a, b) => {
        if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
        return a.name.localeCompare(b.name);
      });

      return json(res, { entries, path: subPath || "" });
    } catch (err) {
      console.log(`[api] File tree failed for ${projectId}/${subPath}:`, err);
      return json(res, { error: "Directory not found" }, 404);
    }
  }

  // API: File content - read a file
  // Pattern: /api/projects/:id/blob/path/to/file
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.match(/\/blob\//) &&
    method === "GET"
  ) {
    const afterProjects = pathname.split("/api/projects/")[1];
    const blobIdx = afterProjects.indexOf("/blob/");
    const projectId = decodeURIComponent(afterProjects.substring(0, blobIdx));
    const filePath = decodeURIComponent(
      afterProjects.substring(blobIdx + "/blob/".length),
    );

    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    if (!filePath) return json(res, { error: "No file path specified" }, 400);
    const project = getProject(projectId);
    if (!project) return json(res, { error: "Project not found" }, 404);

    const fullPath = resolve(project.path, filePath);
    if (!fullPath.startsWith(project.path)) {
      return json(res, { error: "Path traversal not allowed" }, 400);
    }

    try {
      const stat = statSync(fullPath);
      if (stat.isDirectory())
        return json(res, { error: "Path is a directory" }, 400);

      // Limit file size to 1MB
      if (stat.size > 1024 * 1024) {
        return json(
          res,
          { error: "File too large (>1MB)", size: stat.size },
          400,
        );
      }

      const content = readFileSync(fullPath, "utf-8");
      return json(res, { content, path: filePath, size: stat.size });
    } catch (err) {
      console.log(`[api] File read failed for ${projectId}/${filePath}:`, err);
      return json(res, { error: "File not found" }, 404);
    }
  }

  // API: Diff - list changed files or get diff for a specific file
  // Pattern: /api/projects/:id/diff or /api/projects/:id/diff/path/to/file
  if (
    pathname?.startsWith("/api/projects/") &&
    pathname.match(/\/diff(\/|$)/) &&
    method === "GET"
  ) {
    const afterProjects = pathname.split("/api/projects/")[1];
    const diffIdx = afterProjects.indexOf("/diff");
    const projectId = decodeURIComponent(afterProjects.substring(0, diffIdx));
    const filePath = decodeURIComponent(
      afterProjects.substring(diffIdx + "/diff".length).replace(/^\//, ""),
    );

    if (!validateProjectId(projectId))
      return json(res, { error: "Invalid project ID" }, 400);
    const project = getProject(projectId);
    if (!project) return json(res, { error: "Project not found" }, 404);

    try {
      if (!filePath) {
        // List all changed files
        const status = execSync("git status --porcelain", {
          cwd: project.path,
          encoding: "utf-8",
          timeout: 5000,
        }).trim();

        if (!status) return json(res, { files: [] });

        const files = status.split("\n").map((line) => {
          const match = line.match(/^(..) (.+)$/);
          const st = match ? match[1].trim() : "?";
          const path = match ? match[2] : line.trim();
          return { path, status: st };
        });

        return json(res, { files });
      } else {
        // Get diff for a specific file
        const fullPath = resolve(project.path, filePath);
        if (!fullPath.startsWith(project.path)) {
          return json(res, { error: "Path traversal not allowed" }, 400);
        }

        // Check if it's an untracked file
        const status = execSync(
          `git status --porcelain -- ${JSON.stringify(filePath)}`,
          {
            cwd: project.path,
            encoding: "utf-8",
            timeout: 5000,
          },
        ).trim();

        const isNew = status.startsWith("??");

        if (isNew) {
          // Untracked file — show full contents as new
          const content = readFileSync(fullPath, "utf-8");
          const diffLines = content
            .split("\n")
            .map((l) => `+${l}`)
            .join("\n");
          return json(res, { diff: diffLines, path: filePath, isNew: true });
        }

        // Get unified diff (staged + unstaged vs HEAD)
        let diff = "";
        try {
          diff = execSync(`git diff HEAD -- ${JSON.stringify(filePath)}`, {
            cwd: project.path,
            encoding: "utf-8",
            timeout: 10000,
          });
        } catch {
          // May fail if file is staged but not committed yet (new file added)
          try {
            diff = execSync(
              `git diff --cached -- ${JSON.stringify(filePath)}`,
              {
                cwd: project.path,
                encoding: "utf-8",
                timeout: 10000,
              },
            );
          } catch {
            diff = "";
          }
        }

        return json(res, { diff, path: filePath, isNew: false });
      }
    } catch (err) {
      console.log(`[api] Diff failed for ${projectId}/${filePath}:`, err);
      return json(res, { error: "Failed to get diff" }, 500);
    }
  }

  // API: Push notifications - VAPID public key
  if (pathname === "/api/push/vapid" && method === "GET") {
    const publicKey = getVapidPublicKey();
    if (!publicKey) return json(res, { error: "Push not initialized" }, 500);
    return json(res, { publicKey });
  }

  // API: Push notifications - subscribe
  if (pathname === "/api/push/subscribe" && method === "POST") {
    const body = await readBody(req);
    const { subscription, deviceId } = JSON.parse(body);
    if (!subscription || !deviceId) {
      return json(res, { error: "Missing subscription or deviceId" }, 400);
    }
    addSubscription(deviceId, subscription);
    return json(res, { ok: true });
  }

  // API: Push notifications - unsubscribe
  if (pathname === "/api/push/subscribe" && method === "DELETE") {
    const body = await readBody(req);
    const { deviceId } = JSON.parse(body);
    if (!deviceId) return json(res, { error: "Missing deviceId" }, 400);
    removeSubscription(deviceId);
    return json(res, { ok: true });
  }

  // API: Pair GET - get server public key
  if (pathname?.startsWith("/pair/") && method === "GET") {
    reloadState();
    const token = pathname.split("/pair/")[1];

    if (!serverState || serverState.pairingToken !== token) {
      return json(res, { error: "Invalid token" }, 400);
    }

    return json(res, { serverPublicKey: serverState.publicKey });
  }

  // API: Pair POST - complete pairing (allows multiple devices)
  if (pathname?.startsWith("/pair/") && method === "POST") {
    reloadState();
    const token = pathname.split("/pair/")[1];

    if (!serverState || serverState.pairingToken !== token) {
      return json(res, { error: "Invalid token" }, 400);
    }

    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    const { clientPublicKey } = JSON.parse(body);
    if (!clientPublicKey) {
      return json(res, { error: "Missing clientPublicKey" }, 400);
    }

    const sharedSecret = deriveSharedSecret(
      serverState.privateKey,
      clientPublicKey,
    );
    const { token: deviceToken, tokenExpiresAt } = generateDeviceToken();
    const newDevice: Device = {
      id: randomBytes(8).toString("hex"),
      publicKey: clientPublicKey,
      sharedSecret,
      createdAt: new Date().toISOString(),
      token: deviceToken,
      tokenExpiresAt,
    };

    addDevice(newDevice);
    devices = loadDevices();
    console.log(
      `> New device paired: ${newDevice.id} (total: ${devices.length}, token expires: ${tokenExpiresAt})`,
    );

    // Invalidate token after use (one-time use)
    serverState.pairingToken = null;
    saveServerState(serverState);
    console.log("> Pairing token invalidated (one-time use)");

    return json(res, {
      serverPublicKey: serverState.publicKey,
      deviceId: newDevice.id,
      deviceToken,
      tokenExpiresAt,
    });
  }

  // API: Unpair specific device or all devices
  if (pathname === "/api/unpair" && method === "POST") {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
    }

    let deviceId: string | null = null;
    try {
      const parsed = JSON.parse(body);
      deviceId = parsed.deviceId || null;
    } catch {
      // No body or invalid JSON - unpair all
    }

    if (deviceId) {
      // Remove specific device
      removeDevice(deviceId);
      console.log(`> Device ${deviceId} unpaired`);
    } else {
      // Remove all devices
      const { writeFileSync } = await import("fs");
      const { join } = await import("path");
      const { homedir } = await import("os");
      const configDir = join(homedir(), ".config", "claude-remote");
      writeFileSync(join(configDir, "devices.json"), "[]");
      console.log("> All devices unpaired");
    }

    reloadState();
    return json(res, { success: true, deviceCount: devices.length });
  }

  // Static files (production)
  const distPath = join(process.cwd(), "dist", "client");
  if (existsSync(distPath)) {
    const requestedPath =
      pathname === "/" ? "index.html" : (pathname || "").replace(/^\//, "");
    let filePath = resolve(distPath, requestedPath);

    // Path traversal protection: resolved path must be within distPath
    if (!filePath.startsWith(distPath + "/") && filePath !== distPath) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("Forbidden");
      return;
    }

    // SPA fallback
    if (!existsSync(filePath) || !filePath.includes(".")) {
      filePath = join(distPath, "index.html");
    }

    if (existsSync(filePath)) {
      const ext = filePath.split(".").pop() || "";
      const contentTypes: Record<string, string> = {
        html: "text/html",
        js: "application/javascript",
        css: "text/css",
        json: "application/json",
        png: "image/png",
        svg: "image/svg+xml",
      };

      res.writeHead(200, { "Content-Type": contentTypes[ext] || "text/plain" });
      res.end(readFileSync(filePath));
      return;
    }
  }

  // 404
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("Not Found");
}

async function main() {
  pinHash = await hashPin(PIN!);
  initializeServer();
  recoverPartialResponses();
  initVapid();

  const server = createServer(handleRequest);
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    const { pathname } = parse(req.url || "", true);

    if (pathname === "/ws") {
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    let authenticated = false;
    let currentDevice: Device | null = null;
    const clientIp =
      req.headers["x-forwarded-for"]?.toString().split(",")[0]?.trim() ||
      req.socket.remoteAddress ||
      "unknown";

    const sendEncrypted = (data: object) => {
      if (!currentDevice) return;
      if (ws.readyState !== WebSocket.OPEN) {
        // Write to disk for later
        appendEvent(currentDevice.id, data as ClaudeEvent);
        console.log(
          `[${currentDevice.id}] Event written to disk (ws not open)`,
        );
        return;
      }
      const encrypted = encrypt(
        JSON.stringify(data),
        currentDevice.sharedSecret,
      );
      ws.send(JSON.stringify(encrypted));
    };

    ws.on("message", async (raw: Buffer) => {
      reloadState();
      if (devices.length === 0) {
        ws.close(4001, "No devices paired");
        return;
      }

      let encrypted: EncryptedData;
      try {
        encrypted = JSON.parse(raw.toString());
      } catch (err) {
        console.error("FATAL: Failed to parse WebSocket message as JSON:", err);
        console.error("Raw message:", raw.toString().substring(0, 200));
        ws.close(4002, "Invalid JSON");
        return;
      }

      // Find device by trying decryption with each device's key
      if (!currentDevice) {
        currentDevice = findDeviceByDecryption(encrypted);
        if (currentDevice) {
          console.log(`Device identified: ${currentDevice.id}`);
        }
      }

      if (!currentDevice) {
        console.error(
          "FATAL: No device could decrypt message - client needs to re-pair",
        );
        ws.close(4003, "Decryption failed - re-pair required");
        return;
      }

      let decrypted: string;
      try {
        decrypted = decrypt(encrypted, currentDevice.sharedSecret);
      } catch (err) {
        console.error(
          "FATAL: Decryption failed - crypto keys mismatched. Client needs to re-pair.",
        );
        console.error("Error:", err);
        ws.close(4003, "Decryption failed - re-pair required");
        return;
      }

      let msg: {
        type: string;
        pin?: string;
        text?: string;
        projectId?: string;
        conversationId?: string;
        answers?: Array<{ header: string; answer: string }>;
      };
      try {
        msg = JSON.parse(decrypted);
      } catch (err) {
        console.error("FATAL: Failed to parse decrypted message as JSON:", err);
        ws.close(4004, "Invalid message format");
        return;
      }

      console.log(`[${currentDevice.id}] Received message type:`, msg.type);

      if (msg.type === "auth") {
        if (!checkAuthRateLimit(clientIp)) {
          console.log(`Auth rate limited for IP: ${clientIp}`);
          sendEncrypted({
            type: "auth_error",
            error: "Too many attempts. Try again later.",
          });
          return;
        }
        // Check device token expiry before PIN verification
        if (new Date(currentDevice.tokenExpiresAt) <= new Date()) {
          console.log(
            `Device ${currentDevice.id} token expired (${currentDevice.tokenExpiresAt})`,
          );
          sendEncrypted({
            type: "auth_error",
            error: "device_expired",
          });
          return;
        }

        const valid = await verifyPin(msg.pin || "", pinHash);
        if (valid) {
          authenticated = true;
          console.log("Auth successful");

          // Register this connection
          connectedClients.set(currentDevice.id, ws);

          // Find all active jobs for this device (across all projects/conversations)
          const activeProjectIds: string[] = [];
          const activeConversationMap: Record<string, string> = {};
          for (const key of activeJobs.keys()) {
            if (key.startsWith(`${currentDevice.id}:`)) {
              // Key format: "deviceId:projectId" or "deviceId:projectId:conversationId"
              const rest = key.substring(currentDevice.id.length + 1);
              const colonIdx = rest.indexOf(":");
              if (colonIdx >= 0) {
                const projectId = rest.substring(0, colonIdx);
                const conversationId = rest.substring(colonIdx + 1);
                if (!activeProjectIds.includes(projectId)) {
                  activeProjectIds.push(projectId);
                }
                activeConversationMap[projectId] = conversationId;
              } else {
                activeProjectIds.push(rest);
              }
            } else if (key === currentDevice.id) {
              activeProjectIds.push("__global__");
            }
          }

          sendEncrypted({
            type: "auth_ok",
            activeProjectIds,
            activeConversationMap,
          });

          // Send partial responses for any active streaming sessions
          // This sends the accumulated content BEFORE pending events (which are deltas)
          if (activeProjectIds.length > 0) {
            const partials = loadPartialResponses();
            for (const projectId of activeProjectIds) {
              if (projectId === "__global__") continue;
              const convId = activeConversationMap[projectId];
              const jKey = jobKey(currentDevice.id, projectId, convId);
              const partial = partials[jKey];
              if (partial) {
                sendEncrypted({
                  type: "streaming_restore",
                  projectId,
                  conversationId: convId,
                  thinking: partial.thinking,
                  text: partial.text,
                  activity: partial.activity,
                });
                console.log(
                  `[${currentDevice.id}] Sent streaming restore for ${projectId}/${convId || "default"}`,
                );
              }
            }
          }

          // Flush any pending events from disk (but keep the file as backup)
          // These are delta events that occurred after the partial response was saved
          const pending = loadPendingEvents(currentDevice.id);
          if (pending.length > 0) {
            console.log(
              `[${currentDevice.id}] Flushing ${pending.length} pending events from disk`,
            );
            for (const event of pending) {
              const encrypted = encrypt(
                JSON.stringify(event),
                currentDevice.sharedSecret,
              );
              ws.send(JSON.stringify(encrypted));
            }
            // Don't clear - keep as backup log
          }
        } else {
          console.log("Auth failed - invalid PIN");
          recordAuthFailure(clientIp);
          sendEncrypted({ type: "auth_error", error: "Invalid PIN" });
        }
      } else if (msg.type === "list_projects") {
        // List available projects
        const projects = listProjects();
        sendEncrypted({ type: "projects_list", projects });
      } else if (msg.type === "message") {
        if (!authenticated) {
          console.log("Message rejected - not authenticated");
          sendEncrypted({ type: "error", error: "Not authenticated" });
          return;
        }

        const userText = msg.text || "";
        const projectId = msg.projectId;
        const conversationId = msg.conversationId;
        console.log(
          "Processing message:",
          userText.substring(0, 50),
          projectId ? `[project: ${projectId}]` : "[global]",
          conversationId ? `[conv: ${conversationId}]` : "",
        );

        // Validate projectId format and existence
        let projectPath: string | undefined;
        if (projectId) {
          if (!validateProjectId(projectId)) {
            sendEncrypted({
              type: "error",
              error: `Invalid project ID: ${projectId}`,
              projectId,
            });
            return;
          }
          const project = getProject(projectId);
          if (!project) {
            sendEncrypted({
              type: "error",
              error: `Project not found: ${projectId}`,
              projectId,
            });
            return;
          }
          projectPath = project.path;
        }

        // Save user message (to project or global)
        if (projectId) {
          addProjectMessage(
            projectId,
            {
              role: "user",
              content: userText,
              timestamp: new Date().toISOString(),
            },
            conversationId,
          );
        } else {
          addMessage({
            role: "user",
            content: userText,
            timestamp: new Date().toISOString(),
          });
        }

        // Broadcast user message + streaming start to other devices
        broadcastToOthers(currentDevice.id, {
          type: "sync_user_message",
          projectId,
          conversationId,
          text: userText,
        });

        // Auto-name conversations with placeholder names (fire-and-forget)
        if (projectId) {
          const convId = conversationId || "default";
          const convName = getConversationName(projectId, convId);
          console.log(`[auto-name] Checking ${projectId}/${convId}: name="${convName}"`);
          if (!convName || convName === "New Chat" || convName === "Default") {
            generateConversationName(userText).then((summary) => {
              console.log(`[auto-name] Generated name for ${convId}: "${summary}"`);
              renameProjectConversation(projectId, convId, summary);
              // Notify all clients
              const renameEvent = JSON.stringify({
                type: "conversation_renamed",
                projectId,
                conversationId: convId,
                name: summary,
              });
              for (const [connDeviceId, connWs] of connectedClients.entries()) {
                if (connWs.readyState === WebSocket.OPEN) {
                  const connDevice = devices.find((d) => d.id === connDeviceId);
                  if (connDevice) {
                    connWs.send(JSON.stringify(encrypt(renameEvent, connDevice.sharedSecret)));
                  }
                }
              }
            }).catch((err) => {
              console.error("[auto-name] Failed to auto-name conversation:", err);
            });
          }
        }

        const jKey = jobKey(currentDevice.id, projectId, conversationId);
        const abortController = new AbortController();
        activeJobs.set(jKey, abortController);

        // Track assistant response
        let assistantThinking = "";
        let assistantText = "";
        const assistantActivity: ToolActivity[] = [];
        const assistantChunks: OutputChunk[] = [];
        let lastToolName: string | null = null;
        let currentChunkText = "";
        const taskStartedAt = new Date().toISOString();

        // Helper to detect if text starts a new chunk
        const isNewChunkStart = (text: string): boolean => {
          const trimmed = text.trim();
          // Text after a tool always starts a new chunk
          if (lastToolName !== null) return true;
          // Double newline indicates new section
          if (text.startsWith("\n\n")) return true;
          // Common transition phrases
          if (
            /^(Now|Next|Let me|I'll|First|Finally|Done|After|Moving|Continuing|Great|Perfect|Looking|Based on|The |This |I |Here)/i.test(
              trimmed,
            )
          )
            return true;
          return false;
        };

        // Helper to flush current chunk
        const flushChunk = (afterTool?: string) => {
          if (currentChunkText.trim()) {
            assistantChunks.push({
              text: currentChunkText.trim(),
              timestamp: Date.now(),
              afterTool,
            });
            currentChunkText = "";
          }
        };

        // Get existing session ID for continuity
        const sessionId = projectId
          ? getProjectSessionId(projectId, conversationId)
          : getClaudeSessionId();
        console.log(
          "Using Claude session:",
          sessionId || "new session",
          projectId ? `[project: ${projectId}]` : "",
        );

        // On first resumed message after server boot, prepend context note
        const rejoinKey = projectId || "__global__";
        let messageToSend = userText;
        if (sessionId && !rejoinNoteSent.has(rejoinKey)) {
          rejoinNoteSent.add(rejoinKey);
          messageToSend = `[System: This is the first message from the user since the server rebooted.]\n\n${userText}`;
        }

        const deviceId = currentDevice.id;
        const _deviceSecret = currentDevice.sharedSecret;

        spawnClaude(
          messageToSend,
          async (event: ClaudeEvent) => {
            console.log(
              "[ws] Claude event:",
              event.type,
              event.sessionId ? `sessionId=${event.sessionId}` : "",
              projectId ? `[project: ${projectId}]` : "",
            );

            // Don't forward session_init to client, just save it
            if (event.type === "session_init" && event.sessionId) {
              console.log(
                "[ws] Saving session ID:",
                event.sessionId,
                projectId ? `[project: ${projectId}]` : "",
              );
              if (projectId) {
                saveProjectSessionId(projectId, event.sessionId, conversationId);
              } else {
                saveClaudeSessionId(event.sessionId);
              }
              return;
            }

            // Transform error events: Claude uses 'text', client expects 'error'
            let transformedEvent = event;
            if (event.type === "error" && event.text && !("error" in event)) {
              transformedEvent = { ...event, error: event.text };
            }

            // Include projectId and conversationId in all events sent to client
            const eventWithProject = {
              ...transformedEvent,
              ...(projectId ? { projectId } : {}),
              ...(conversationId ? { conversationId } : {}),
            };

            // Broadcast to ALL connected clients (not just the originating device)
            const eventJson = JSON.stringify(eventWithProject);
            let sentToAny = false;
            for (const [connDeviceId, connWs] of connectedClients.entries()) {
              if (connWs.readyState === WebSocket.OPEN) {
                const connDevice = devices.find((d) => d.id === connDeviceId);
                if (connDevice) {
                  const encrypted = encrypt(eventJson, connDevice.sharedSecret);
                  connWs.send(JSON.stringify(encrypted));
                  sentToAny = true;
                }
              }
            }
            if (!sentToAny) {
              // No clients connected — write to disk for the originating device
              appendEvent(deviceId, eventWithProject);
              console.log(
                `[${deviceId}] Event written to disk (no clients connected)`,
              );
            }

            // Collect response for saving
            if (event.type === "thinking" && event.text) {
              assistantThinking += event.text;
              savePartialResponse(
                jKey,
                assistantText,
                assistantThinking,
                assistantActivity,
              );
            } else if (event.type === "text" && event.text) {
              // Check if this text starts a new chunk
              if (isNewChunkStart(event.text) && currentChunkText.trim()) {
                flushChunk(lastToolName || undefined);
                lastToolName = null;
              }
              currentChunkText += event.text;
              assistantText += (assistantText && !assistantText.endsWith("\n") ? "\n\n" : "") + event.text;
              savePartialResponse(
                jKey,
                assistantText,
                assistantThinking,
                assistantActivity,
              );
            } else if (event.type === "tool_use" && event.toolUse) {
              // Flush any text before tool use
              flushChunk();
              lastToolName = event.toolUse.tool;
              assistantActivity.push({
                type: "tool_use",
                tool: event.toolUse.tool,
                id: event.toolUse.id,
                input: event.toolUse.input,
                timestamp: Date.now(),
              });
              savePartialResponse(
                jKey,
                assistantText,
                assistantThinking,
                assistantActivity,
              );

              // Detect AskUserQuestion — store pending question for later answer
              if (
                event.toolUse.tool === "AskUserQuestion" &&
                event.toolUse.id
              ) {
                const currentSessionId = projectId
                  ? getProjectSessionId(projectId, conversationId)
                  : getClaudeSessionId();
                pendingQuestions.set(jKey, {
                  toolUseId: event.toolUse.id,
                  questions: (event.toolUse.input.questions ||
                    []) as PendingQuestion["questions"],
                  projectId,
                  sessionId: currentSessionId || "",
                });
                console.log(
                  `[${deviceId}] AskUserQuestion detected, stored pending question`,
                );
                // Push notification for AskUserQuestion
                const questionText =
                  (
                    event.toolUse.input.questions as Array<{ question: string }>
                  )?.[0]?.question || "Claude has a question";
                sendPushToAll("Question from Claude", questionText, "/").catch(
                  (err) =>
                    console.error(
                      "[push] Failed to send AskUserQuestion push:",
                      err,
                    ),
                );
              }
            } else if (event.type === "tool_result" && event.toolResult) {
              assistantActivity.push({
                type: "tool_result",
                tool: event.toolResult.tool,
                output: event.toolResult.output,
                error: event.toolResult.error,
                timestamp: Date.now(),
              });
              savePartialResponse(
                jKey,
                assistantText,
                assistantThinking,
                assistantActivity,
              );
            } else if (event.type === "done") {
              // Flush any remaining chunk
              flushChunk(lastToolName || undefined);

              // Save assistant message when complete (to project or global)
              if (
                assistantText ||
                assistantThinking ||
                assistantActivity.length > 0
              ) {
                const assistantMsg: Message = {
                  role: "assistant",
                  content: assistantText,
                  task: userText, // Store the original user prompt
                  chunks:
                    assistantChunks.length > 0 ? assistantChunks : undefined,
                  thinking: assistantThinking || undefined,
                  activity:
                    assistantActivity.length > 0
                      ? assistantActivity
                      : undefined,
                  startedAt: taskStartedAt,
                  completedAt: new Date().toISOString(),
                  timestamp: new Date().toISOString(),
                };
                if (projectId) {
                  addProjectMessage(projectId, assistantMsg, conversationId);
                } else {
                  addMessage(assistantMsg);
                }
              }
              // Push notification for task completion
              const snippet = assistantText.slice(0, 100) || "Task finished";
              sendPushToAll("Task complete", snippet, "/").catch((err) =>
                console.error("[push] Failed to send done push:", err),
              );
              // Clear pending debounced writes and partial response file
              pendingPartials.delete(jKey);
              clearPartialResponse(jKey);
              // Clear active job
              activeJobs.delete(jKey);
              console.log(
                `[${deviceId}] Job complete for ${projectId || "global"}, cleared from active jobs`,
              );
            }
          },
          abortController.signal,
          sessionId,
          projectPath,
        );
      } else if (msg.type === "tool_answer") {
        if (!authenticated) {
          sendEncrypted({ type: "error", error: "Not authenticated" });
          return;
        }

        const projectId = msg.projectId;
        const conversationId = msg.conversationId;
        if (projectId && !validateProjectId(projectId)) {
          sendEncrypted({
            type: "error",
            error: "Invalid project ID",
            projectId,
          });
          return;
        }

        const jKey = jobKey(currentDevice.id, projectId, conversationId);
        const pending = pendingQuestions.get(jKey);

        if (!pending) {
          sendEncrypted({
            type: "error",
            error: "No pending question found",
            projectId,
          });
          return;
        }

        console.log(
          `[${currentDevice.id}] Received tool answer for ${projectId || "global"}`,
        );
        pendingQuestions.delete(jKey);

        // Format the answer as a user message and resume the session
        const answerText = msg.answers
          ? msg.answers.map((a) => `${a.header}: ${a.answer}`).join("\n")
          : msg.text || "";

        const formattedAnswer = `[User answered your question]\n${answerText}`;

        // Save answer as user message
        if (projectId) {
          addProjectMessage(
            projectId,
            {
              role: "user",
              content: formattedAnswer,
              timestamp: new Date().toISOString(),
            },
            conversationId,
          );
        } else {
          addMessage({
            role: "user",
            content: formattedAnswer,
            timestamp: new Date().toISOString(),
          });
        }

        // Resume session with the answer — reuse the message handling path
        // by injecting a synthetic message event
        msg.type = "message";
        msg.text = formattedAnswer;
        // Fall through won't work here, so we need to emit a new message event
        // Instead, directly spawn Claude with the answer
        const answerAbortController = new AbortController();
        activeJobs.set(jKey, answerAbortController);

        let ansAssistantThinking = "";
        let ansAssistantText = "";
        const ansAssistantActivity: ToolActivity[] = [];
        const ansAssistantChunks: OutputChunk[] = [];
        let ansLastToolName: string | null = null;
        let ansCurrentChunkText = "";
        const ansTaskStartedAt = new Date().toISOString();

        const ansIsNewChunkStart = (text: string): boolean => {
          const trimmed = text.trim();
          if (ansLastToolName !== null) return true;
          if (text.startsWith("\n\n")) return true;
          if (
            /^(Now|Next|Let me|I'll|First|Finally|Done|After|Moving|Continuing|Great|Perfect|Looking|Based on|The |This |I |Here)/i.test(
              trimmed,
            )
          )
            return true;
          return false;
        };

        const ansFlushChunk = (afterTool?: string) => {
          if (ansCurrentChunkText.trim()) {
            ansAssistantChunks.push({
              text: ansCurrentChunkText.trim(),
              timestamp: Date.now(),
              afterTool,
            });
            ansCurrentChunkText = "";
          }
        };

        let ansProjectPath: string | undefined;
        if (projectId) {
          const project = getProject(projectId);
          if (project) ansProjectPath = project.path;
        }

        const deviceId = currentDevice.id;
        const _deviceSecret = currentDevice.sharedSecret;

        spawnClaude(
          formattedAnswer,
          (event: ClaudeEvent) => {
            console.log(
              "[ws] Claude answer event:",
              event.type,
              projectId ? `[project: ${projectId}]` : "",
            );

            if (event.type === "session_init" && event.sessionId) {
              if (projectId) {
                saveProjectSessionId(projectId, event.sessionId, conversationId);
              } else {
                saveClaudeSessionId(event.sessionId);
              }
              return;
            }

            let transformedEvent = event;
            if (event.type === "error" && event.text && !("error" in event)) {
              transformedEvent = { ...event, error: event.text };
            }

            const eventWithProject = {
              ...transformedEvent,
              ...(projectId ? { projectId } : {}),
              ...(conversationId ? { conversationId } : {}),
            };

            const eventJson = JSON.stringify(eventWithProject);
            let sentToAny = false;
            for (const [connDeviceId, connWs] of connectedClients.entries()) {
              if (connWs.readyState === WebSocket.OPEN) {
                const connDevice = devices.find((d) => d.id === connDeviceId);
                if (connDevice) {
                  const encrypted = encrypt(eventJson, connDevice.sharedSecret);
                  connWs.send(JSON.stringify(encrypted));
                  sentToAny = true;
                }
              }
            }
            if (!sentToAny) {
              appendEvent(deviceId, eventWithProject);
            }

            if (event.type === "thinking" && event.text) {
              ansAssistantThinking += event.text;
              savePartialResponse(
                jKey,
                ansAssistantText,
                ansAssistantThinking,
                ansAssistantActivity,
              );
            } else if (event.type === "text" && event.text) {
              if (
                ansIsNewChunkStart(event.text) &&
                ansCurrentChunkText.trim()
              ) {
                ansFlushChunk(ansLastToolName || undefined);
                ansLastToolName = null;
              }
              ansCurrentChunkText += event.text;
              ansAssistantText += event.text;
              savePartialResponse(
                jKey,
                ansAssistantText,
                ansAssistantThinking,
                ansAssistantActivity,
              );
            } else if (event.type === "tool_use" && event.toolUse) {
              ansFlushChunk();
              ansLastToolName = event.toolUse.tool;
              ansAssistantActivity.push({
                type: "tool_use",
                tool: event.toolUse.tool,
                id: event.toolUse.id,
                input: event.toolUse.input,
                timestamp: Date.now(),
              });
              savePartialResponse(
                jKey,
                ansAssistantText,
                ansAssistantThinking,
                ansAssistantActivity,
              );

              if (
                event.toolUse.tool === "AskUserQuestion" &&
                event.toolUse.id
              ) {
                const currentSessionId = projectId
                  ? getProjectSessionId(projectId, conversationId)
                  : getClaudeSessionId();
                pendingQuestions.set(jKey, {
                  toolUseId: event.toolUse.id,
                  questions: (event.toolUse.input.questions ||
                    []) as PendingQuestion["questions"],
                  projectId,
                  sessionId: currentSessionId || "",
                });
                // Push notification for AskUserQuestion (answer flow)
                const questionText =
                  (
                    event.toolUse.input.questions as Array<{ question: string }>
                  )?.[0]?.question || "Claude has a question";
                sendPushToAll("Question from Claude", questionText, "/").catch(
                  (err) =>
                    console.error(
                      "[push] Failed to send AskUserQuestion push:",
                      err,
                    ),
                );
              }
            } else if (event.type === "tool_result" && event.toolResult) {
              ansAssistantActivity.push({
                type: "tool_result",
                tool: event.toolResult.tool,
                output: event.toolResult.output,
                error: event.toolResult.error,
                timestamp: Date.now(),
              });
              savePartialResponse(
                jKey,
                ansAssistantText,
                ansAssistantThinking,
                ansAssistantActivity,
              );
            } else if (event.type === "done") {
              ansFlushChunk(ansLastToolName || undefined);
              if (
                ansAssistantText ||
                ansAssistantThinking ||
                ansAssistantActivity.length > 0
              ) {
                const assistantMsg: Message = {
                  role: "assistant",
                  content: ansAssistantText,
                  task: formattedAnswer,
                  chunks:
                    ansAssistantChunks.length > 0
                      ? ansAssistantChunks
                      : undefined,
                  thinking: ansAssistantThinking || undefined,
                  activity:
                    ansAssistantActivity.length > 0
                      ? ansAssistantActivity
                      : undefined,
                  startedAt: ansTaskStartedAt,
                  completedAt: new Date().toISOString(),
                  timestamp: new Date().toISOString(),
                };
                if (projectId) {
                  addProjectMessage(projectId, assistantMsg, conversationId);
                } else {
                  addMessage(assistantMsg);
                }
              }
              // Push notification for task completion (answer flow)
              const snippet = ansAssistantText.slice(0, 100) || "Task finished";
              sendPushToAll("Task complete", snippet, "/").catch((err) =>
                console.error("[push] Failed to send done push:", err),
              );
              pendingPartials.delete(jKey);
              clearPartialResponse(jKey);
              activeJobs.delete(jKey);
            }
          },
          answerAbortController.signal,
          pending.sessionId,
          ansProjectPath,
        );
      } else if (msg.type === "cancel") {
        if (msg.projectId && !validateProjectId(msg.projectId)) {
          sendEncrypted({ type: "error", error: "Invalid project ID" });
          return;
        }
        console.log(
          "Cancel requested",
          msg.projectId ? `[project: ${msg.projectId}]` : "[global]",
          msg.conversationId ? `[conv: ${msg.conversationId}]` : "",
        );
        const jKey = jobKey(currentDevice.id, msg.projectId, msg.conversationId);
        const abortController = activeJobs.get(jKey);
        if (abortController) {
          abortController.abort();
          activeJobs.delete(jKey);
        }
        // Notify other devices about the cancel
        broadcastToOthers(currentDevice.id, {
          type: "sync_cancel",
          projectId: msg.projectId,
          conversationId: msg.conversationId,
        });
      } else {
        console.log("Unknown message type:", msg.type);
      }
    });

    ws.on("close", () => {
      // Don't abort - let Claude keep running
      // Just remove from connected clients
      if (currentDevice) {
        connectedClients.delete(currentDevice.id);
        console.log(
          `[${currentDevice.id}] Client disconnected, Claude will continue running`,
        );
      }
    });
  });

  server.listen(port, () => {
    console.log(`> Server ready on ${serverUrl}`);
    console.log(`> Client URL: ${clientUrl}`);
    console.log(`> Paired devices: ${devices.length}`);
    if (serverState.pairingToken) {
      const pairUrl = `${clientUrl}/pair?server=${encodeURIComponent(serverUrl)}&token=${serverState.pairingToken}`;
      console.log(`> Pair URL: ${pairUrl}`);
      console.log("");
      qrcode.generate(pairUrl, { small: true });
    }
  });
}

main();
