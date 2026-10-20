import {
  SessionSchema,
  SidelineCatalogSchema,
  SidelineSendRequestSchema,
  SidelineSendResponseSchema,
  ChannelAccessSchema,
  SocketTicketSchema,
  WorkspaceIdSchema,
  WorkspaceSchema,
  type Session,
} from "@rally/contracts";
import { z } from "zod";
import { SIDELINE_AUTH_CALLBACK_URI } from "@rally/contracts/desktop-deep-link";
import { CLIENT_CONTRACT_VERSION, RALLY_HEADERS } from "@rally/contracts/http-headers";
import { socketTicketProtocols } from "@rally/contracts/socket-tickets";
import { workstreamDeepLink } from "@rally/contracts/workstream-links";
import { watchWorkspaceReach, type ReachWatchDiagnostic } from "@rally/contracts/workspace-reach-watch";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  MenuItem,
  net,
  safeStorage,
  shell,
  type IpcMainInvokeEvent,
} from "electron";
import { randomBytes, createHash } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

import {
  sidelineHttpOutcome,
  type SidelineOrganization,
  type SidelineOrganizationSwitch,
  type SidelineSendResult,
  type SidelineSession,
} from "../common/bridge";
import { initializeSidelineUpdater, sidelineUpdateMenuItem, type SidelineUpdateHandle } from "./updater";
import { sidelineHttpSend, sidelineHttpSendResponse } from "./send-request";

const API_BASE_URL = (
  process.env.VITE_API_GLOBAL_URL ?? (app.isPackaged ? "https://api.rallywith.ai" : "http://127.0.0.1:8787")
).replace(/\/$/u, "");
const __dirname = fileURLToPath(new URL(".", import.meta.url));
const VISUAL_STATE = app.isPackaged ? undefined : process.env.SIDELINE_VISUAL_STATE;
const SESSION_FILE = "sideline-session.bin";
/** The origin Sideline's workspace socket presents; the Worker's `ALLOWED_ORIGINS` must admit it. */
const SIDELINE_SOCKET_ORIGIN = "app://sideline";
declare const __SIDELINE_BUILD_TIME__: string | undefined;

let mainWindow: BrowserWindow | null = null;
let updateHandle: SidelineUpdateHandle | null = null;
let session: Session | null = null;
let pendingAuth: { attemptId: string; verifier: string } | null = null;
let stopReachWatch: (() => void) | null = null;
let reachWatchGeneration = 0;

const visualSession: SidelineSession = {
  user: {
    id: "00000000-0000-7000-8000-00000000c001",
    email: "operator@rallywith.ai",
    name: "Jordan Lee",
    avatarUrl: null,
    timezone: "America/Los_Angeles",
    createdAt: "2026-09-21T00:00:00.000Z",
  },
  workspace: {
    id: "00000000-0000-7000-8000-00000000c002",
    name: "Northstar Launch",
    slug: "northstar-launch",
    region: "global",
    role: "member",
    timezone: "America/Los_Angeles",
    createdAt: "2026-09-21T00:00:00.000Z",
  },
};
const visualCatalog = SidelineCatalogSchema.parse({
  workspace: { id: visualSession.workspace.id, name: visualSession.workspace.name },
  operator: { userId: visualSession.user.id, name: visualSession.user.name },
  participants: [{
    userId: "00000000-0000-7000-8000-00000000c003",
    name: "Priya Shah",
    avatarUrl: null,
    destinations: [
      {
        workstreamId: "00000000-0000-7000-8000-00000000c004",
        substreamId: "0",
        label: "Launch readiness",
        workstreamLabel: "Launch readiness",
      },
      {
        workstreamId: "00000000-0000-7000-8000-00000000c004",
        substreamId: "00000000-0000-7000-8000-00000000c005",
        label: "Pricing review",
        workstreamLabel: "Launch readiness",
      },
    ],
  }, {
    userId: visualSession.user.id,
    name: visualSession.user.name,
    avatarUrl: null,
    destinations: [{
      workstreamId: "00000000-0000-7000-8000-00000000c006",
      substreamId: "0",
      label: "Executive briefing",
      workstreamLabel: "Executive briefing",
    }],
  }],
});

class HttpResponseError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function publicSession(value: Session | null): SidelineSession | null {
  return value?.workspace ? { user: value.user, workspace: value.workspace } : null;
}

/** Tell the renderer, if there is still a window to tell. */
function sendToWindow(channel: string, ...payload: unknown[]): void {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, ...payload);
}

function base64url(value: Buffer): string {
  return value.toString("base64").replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/gu, "");
}

async function storeSession(value: Session | null): Promise<void> {
  const path = join(app.getPath("userData"), SESSION_FILE);
  if (!value) {
    await unlink(path).catch(() => undefined);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) throw new Error("Secure credential storage is unavailable");
  await writeFile(path, safeStorage.encryptString(JSON.stringify(value)));
}

async function loadSession(): Promise<Session | null> {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null;
    const bytes = await readFile(join(app.getPath("userData"), SESSION_FILE));
    return SessionSchema.parse(JSON.parse(safeStorage.decryptString(bytes)));
  } catch {
    return null;
  }
}

async function jsonRequest(url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await net.fetch(url, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body
      ? (body as { error?: { message?: unknown } }).error
      : null;
    throw new HttpResponseError(
      response.status,
      error && typeof error.message === "string" ? error.message : `Sideline request failed (${response.status})`,
    );
  }
  return body;
}

/**
 * Whether `/auth/refresh` refused the refresh token itself, as opposed to
 * failing to answer. Only a refusal ends the session: a network failure while
 * the laptop wakes, or a 5xx, leaves the session and the operator's drafts in
 * place for the next attempt.
 */
function refreshRefused(error: unknown): boolean {
  return error instanceof HttpResponseError && [400, 401, 403].includes(error.status);
}

// One refresh at a time. The server rotates the refresh token on every call,
// so two concurrent refreshes with the same token each rotate it, and the
// second retires the first one's answer at once. Keeping that answer holds a
// token the next refresh is refused for.
let refreshInFlight: Promise<Session> | null = null;

async function refreshIfNeeded(force = false): Promise<Session> {
  if (!session) throw new Error("Sign in to use Sideline");
  if (!force && Date.parse(session.expiresAt) - Date.now() > 30_000) return session;
  refreshInFlight ??= refreshSession(session).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

async function refreshSession(current: Session): Promise<Session> {
  try {
    const next = SessionSchema.parse(await jsonRequest(`${current.apiBaseUrl}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refreshToken: current.refreshToken }),
    }));
    // Signed out or into another session while this ran: that is the session now.
    if (session !== current) throw new Error("Sign in to use Sideline");
    session = next;
    await storeSession(session);
    return session;
  } catch (error) {
    if (session === current && refreshRefused(error)) {
      session = null;
      await storeSession(null);
      restartReachWatch();
      sendToWindow("sideline:session-changed", null);
    }
    throw error;
  }
}

async function authenticated(path: string, init: RequestInit = {}): Promise<unknown> {
  const request = async (active: Session): Promise<unknown> => jsonRequest(
    `${active.apiBaseUrl}${path}`,
    { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${active.accessToken}`, ...init.headers } },
  );
  const active = await refreshIfNeeded();
  try {
    return await request(active);
  } catch (error) {
    if (!(error instanceof HttpResponseError) || error.status !== 401) throw error;
    return request(await refreshIfNeeded(true));
  }
}

/** A line an operator reading the terminal can act on, naming why the catalog stopped following. */
function logReachDiagnostic(diagnostic: ReachWatchDiagnostic): void {
  const reason = "error" in diagnostic
    ? diagnostic.error instanceof HttpResponseError
      ? `${diagnostic.code} (${diagnostic.error.status})`
      : `${diagnostic.code} (${diagnostic.error instanceof Error ? diagnostic.error.name : "unknown"})`
    : diagnostic.code === "timeout" || diagnostic.code === "transport_error" ? `${diagnostic.phase}_${diagnostic.code}`
      : `${diagnostic.code} (close ${diagnostic.closeCode})`;
  console.warn(`[sideline] membership updates paused: ${reason}`);
}

/**
 * Follow the current session's workspace socket, and tell the renderer when
 * its catalog went stale. Called whenever `session` is set or cleared; a
 * refresh replaces the token without moving the socket.
 */
function restartReachWatch(): void {
  stopReachWatch?.();
  stopReachWatch = null;
  const generation = ++reachWatchGeneration;
  if (!session || VISUAL_STATE) return;
  stopReachWatch = watchWorkspaceReach({
    ticket: async (signal) => SocketTicketSchema.parse(await authenticated("/workspace/socket", {
      signal,
      headers: { [RALLY_HEADERS.CLIENT_CONTRACT]: String(CLIENT_CONTRACT_VERSION) },
    })),
    open: (url, ticket) => new WebSocket(url, socketTicketProtocols(ticket), { origin: SIDELINE_SOCKET_ORIGIN }),
    onStale: () => sendToWindow("sideline:catalog-stale"),
    onDiagnostic: (diagnostic) => {
      logReachDiagnostic(diagnostic);
      if (diagnostic.code !== "stopped" || generation !== reachWatchGeneration) return;
      // The server ended this session's access. A forced refresh either signs
      // the operator out, which stops the watch, or issues a session the
      // server accepts, which is worth one more connection.
      void refreshIfNeeded(true).then(() => { if (session) restartReachWatch(); }, () => undefined);
    },
  });
}

async function chooseWorkspace(identity: Session): Promise<Session> {
  const response = await jsonRequest(`${API_BASE_URL}/auth/workspaces`, {
    headers: { Authorization: `Bearer ${identity.accessToken}` },
  }) as { workspaces?: unknown[] };
  const priorWorkspaceId = session?.workspace?.id;
  const workspaces = Array.isArray(response.workspaces) ? [...response.workspaces] : [];
  workspaces.sort((left, right) => {
    const leftId = left && typeof left === "object" ? (left as { id?: unknown }).id : undefined;
    const rightId = right && typeof right === "object" ? (right as { id?: unknown }).id : undefined;
    return Number(rightId === priorWorkspaceId) - Number(leftId === priorWorkspaceId);
  });
  let emptySelection: Session | null = null;
  for (const candidate of workspaces) {
    if (!candidate || typeof candidate !== "object" || typeof (candidate as { id?: unknown }).id !== "string") continue;
    const selected = SessionSchema.parse(await jsonRequest(`${API_BASE_URL}/auth/workspace/select`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${identity.accessToken}` },
      body: JSON.stringify({ workspaceId: (candidate as { id: string }).id }),
    }));
    try {
      const catalog = SidelineCatalogSchema.parse(await jsonRequest(
        `${selected.apiBaseUrl}/sideline/catalog`,
        { headers: { Authorization: `Bearer ${selected.accessToken}` } },
      ));
      if (catalog.participants.length > 0) return selected;
      emptySelection ??= selected;
    } catch (error) {
      if (!(error instanceof HttpResponseError) || error.status !== 403) throw error;
      // A membership without an active relationship is not Sideline's current workspace.
    }
  }
  if (emptySelection) return emptySelection;
  throw new Error("No Organization currently grants this account Sideline access");
}

async function finishSignIn(identity: Session): Promise<void> {
  session = await chooseWorkspace(identity);
  await storeSession(session);
  restartReachWatch();
  sendToWindow("sideline:session-changed", publicSession(session));
}

async function beginSignIn(): Promise<void> {
  if (process.env.RALLY_DEV_AUTH === "true") {
    const development = SessionSchema.parse(await jsonRequest(`${API_BASE_URL}/auth/dev/session`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }));
    session = development;
    await storeSession(session);
    restartReachWatch();
    sendToWindow("sideline:session-changed", publicSession(session));
    return;
  }
  const verifier = base64url(randomBytes(32));
  const attemptId = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  pendingAuth = { attemptId, verifier };
  const started = await jsonRequest(`${API_BASE_URL}/auth/google/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ returnUri: SIDELINE_AUTH_CALLBACK_URI, desktopAttemptId: attemptId, desktopCodeChallenge: challenge }),
  }) as { url?: unknown };
  if (typeof started.url !== "string") throw new Error("Rally returned an invalid sign-in URL");
  const authorizationUrl = new URL(started.url);
  if (authorizationUrl.protocol !== "https:") throw new Error("Rally returned an invalid sign-in URL");
  await shell.openExternal(authorizationUrl.toString());
}

async function handleCallback(raw: string): Promise<void> {
  const callback = new URL(raw);
  const expected = new URL(SIDELINE_AUTH_CALLBACK_URI);
  if (
    callback.protocol === expected.protocol
    && callback.host === expected.host
    && callback.pathname === expected.pathname
    && callback.searchParams.get("ticket")
    && pendingAuth
  ) {
    const proof = pendingAuth;
    pendingAuth = null;
    const identity = SessionSchema.parse(await jsonRequest(`${API_BASE_URL}/auth/desktop/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticket: callback.searchParams.get("ticket"),
        region: "global",
        attemptId: proof.attemptId,
        codeVerifier: proof.verifier,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    }));
    await finishSignIn(identity);
  }
}

/** Revoke a session on the server; a failure leaves it to expire. */
async function endSession(value: Session): Promise<void> {
  await jsonRequest(`${value.apiBaseUrl}/auth/logout`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${value.accessToken}` },
    body: JSON.stringify({ refreshToken: value.refreshToken }),
  }).catch(() => undefined);
}

function assertSender(event: IpcMainInvokeEvent): void {
  if (!mainWindow || event.sender !== mainWindow.webContents) throw new Error("Untrusted Sideline IPC sender");
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 980,
    height: 780,
    minWidth: 680,
    minHeight: 560,
    title: "Sideline",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  window.once("ready-to-show", () => window.show());
  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(__dirname, "../renderer/index.html"));
  return window;
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", (_event, argv) => {
    const link = argv.find((value) => value.startsWith("sideline://"));
    if (link) void handleCallback(link);
    mainWindow?.show();
  });
  app.on("open-url", (event, url) => { event.preventDefault(); void handleCallback(url); });
  app.on("activate", () => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.show();
    else mainWindow = createWindow();
  });
  void app.whenReady().then(async () => {
    app.setAsDefaultProtocolClient("sideline");
    session = VISUAL_STATE ? null : await loadSession();
    mainWindow = createWindow();
    restartReachWatch();
    const handle = initializeSidelineUpdater({
      isPackaged: app.isPackaged,
      isReleaseBuild: process.env.SIDELINE_RELEASE_BUILD === "true",
      platform: process.platform,
      arch: process.arch,
      // Stamped by electron.vite.config.ts; absent where no build ran (unit tests).
      currentBuildTime: typeof __SIDELINE_BUILD_TIME__ === "string" ? Date.parse(__SIDELINE_BUILD_TIME__) : undefined,
      onDownloaded: (version) => sendToWindow("sideline:update-downloaded", version),
      showMessageBox: (options) => mainWindow && !mainWindow.isDestroyed()
        ? dialog.showMessageBox(mainWindow, options)
        : dialog.showMessageBox(options),
    });
    updateHandle = handle;
    if (process.platform === "darwin") {
      const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([
        { role: "appMenu" },
        { role: "fileMenu" },
        { role: "editMenu" },
        { role: "viewMenu" },
        { role: "windowMenu" },
      ]);
      const appMenu = menu.items[0]?.submenu;
      if (appMenu && !appMenu.getMenuItemById("sideline-check-for-updates")) {
        appMenu.insert(Math.min(1, appMenu.items.length), new MenuItem(sidelineUpdateMenuItem(handle)));
        Menu.setApplicationMenu(menu);
      }
    }
  });
}

ipcMain.handle("sideline:downloaded-update", (event) => {
  assertSender(event);
  return updateHandle?.downloadedVersion() ?? null;
});
ipcMain.handle("sideline:install-update", (event) => {
  assertSender(event);
  updateHandle?.installDownloadedUpdate();
});
ipcMain.handle("sideline:session", (event) => {
  assertSender(event);
  return VISUAL_STATE && VISUAL_STATE !== "denied" ? visualSession : publicSession(session);
});
ipcMain.handle("sideline:sign-in", async (event) => { assertSender(event); await beginSignIn(); });
ipcMain.handle("sideline:sign-out", async (event) => {
  assertSender(event);
  // Cleared before the logout call, so a switch finishing meanwhile sees the
  // sign-out and does not commit the session it selected.
  const ending = session;
  session = null;
  if (ending) await endSession(ending);
  await storeSession(null);
  restartReachWatch();
  sendToWindow("sideline:session-changed", null);
});
const OrganizationsResponseSchema = z.object({ workspaces: z.array(WorkspaceSchema) });

/** Parse a server response, naming the rejected field in what crosses the IPC boundary. */
function parseResponse<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  throw new Error(zodDiagnosticCode(parsed.error, label) ?? `${label}_invalid`);
}

ipcMain.handle("sideline:organizations", async (event): Promise<SidelineOrganization[]> => {
  assertSender(event);
  if (VISUAL_STATE) {
    return [
      { id: visualSession.workspace.id, name: visualSession.workspace.name },
      { id: "00000000-0000-7000-8000-00000000c009", name: "Juno Labs" },
    ];
  }
  const { workspaces } = parseResponse(OrganizationsResponseSchema, await authenticated("/auth/workspaces"), "organizations");
  return workspaces.map((workspace) => ({ id: workspace.id, name: workspace.name }));
});
/**
 * Move the session to another Organization. The new session must be admitted
 * to Sideline's catalog before it replaces the current one, so a refusal
 * leaves the operator where they were.
 */
async function switchOrganization(workspaceId: string): Promise<SidelineOrganizationSwitch> {
  const current = session;
  if (!current || current.workspace?.id === workspaceId) return "switched";
  const selected = parseResponse(SessionSchema, await authenticated("/auth/workspace/select", {
    method: "POST",
    body: JSON.stringify({ workspaceId }),
  }), "organization_session");
  try {
    parseResponse(SidelineCatalogSchema, await jsonRequest(
      `${selected.apiBaseUrl}/sideline/catalog`,
      { headers: { Authorization: `Bearer ${selected.accessToken}` } },
    ), "sideline_catalog");
  } catch (error) {
    void endSession(selected);
    if (error instanceof HttpResponseError && error.status === 403) return "not_admitted";
    throw error;
  }
  // Saved before it goes live, so a write failure leaves the old session in charge.
  try {
    await storeSession(selected);
  } catch (error) {
    void endSession(selected);
    throw error;
  }
  // Signed out while this ran: that is the session now, so put it back on disk.
  // A token refresh replaces the object but not the Organization, so compare that.
  const previous = session;
  if (!previous || previous.workspace?.id !== current.workspace?.id) {
    await storeSession(previous).catch(() => undefined);
    void endSession(selected);
    return "superseded";
  }
  session = selected;
  restartReachWatch();
  sendToWindow("sideline:session-changed", publicSession(session));
  void endSession(previous);
  return "switched";
}
// One switch at a time: each starts from the session the previous one left, so
// two quick choices cannot both select a session and orphan one of them.
let organizationSwitchTail: Promise<unknown> = Promise.resolve();
ipcMain.handle("sideline:switch-organization", (event, raw: unknown): Promise<SidelineOrganizationSwitch> => {
  assertSender(event);
  const workspaceId = WorkspaceIdSchema.parse(raw);
  const run = organizationSwitchTail.then(() => switchOrganization(workspaceId));
  organizationSwitchTail = run.catch(() => undefined);
  return run;
});
ipcMain.handle("sideline:catalog", async (event) => {
  assertSender(event);
  if (VISUAL_STATE === "loading") return new Promise(() => undefined);
  if (VISUAL_STATE === "offline") throw new Error("SIDELINE_OFFLINE: Sideline is offline. Drafts remain available.");
  if (VISUAL_STATE === "error") throw new Error("Sideline could not refresh this Organization.");
  if (VISUAL_STATE) return visualCatalog;
  return SidelineCatalogSchema.parse(await authenticated("/sideline/catalog"));
});
ipcMain.handle("sideline:send", async (event, raw) => {
  assertSender(event);
  const parsed = SidelineSendRequestSchema.parse(raw);
  const input = SidelineSendRequestSchema.parse({
    ...parsed,
    app: { ...parsed.app, version: app.getVersion() },
  });
  if (VISUAL_STATE === "sending") {
    return new Promise<SidelineSendResult>((resolve) => setTimeout(() => resolve({
      ok: true,
      response: SidelineSendResponseSchema.parse({
        messageId: "00000000-0000-7000-8000-00000000c007",
        createdAt: "2026-09-21T12:00:00.000Z",
      }),
    }), 30_000));
  }
  if (VISUAL_STATE === "failed") {
    return { ok: false, outcome: "rejected", message: "This destination no longer accepts messages." } satisfies SidelineSendResult;
  }
  if (VISUAL_STATE === "unknown") {
    return { ok: false, outcome: "unknown", message: "Send outcome unknown. Retry uses the same send key." } satisfies SidelineSendResult;
  }
  if (VISUAL_STATE) {
    return {
      ok: true,
      response: SidelineSendResponseSchema.parse({
        messageId: "00000000-0000-7000-8000-00000000c007",
        createdAt: "2026-09-21T12:00:00.000Z",
      }),
    } satisfies SidelineSendResult;
  }
  try {
    if (!session) throw new Error("Sign in to use Sideline");
    const request = sidelineHttpSend(session.user.id, input);
    const response = sidelineHttpSendResponse(request.kind, await authenticated(
      request.path,
      {
        method: "POST",
        ...(request.kind === "self" ? { headers: { [RALLY_HEADERS.OPERATION_ID]: request.operationId } } : {}),
        body: JSON.stringify(request.body),
      },
    ));
    return { ok: true, response } satisfies SidelineSendResult;
  } catch (error) {
    if (error instanceof HttpResponseError) {
      const outcome = sidelineHttpOutcome(error.status);
      return {
        ok: false,
        outcome,
        message: outcome === "rejected"
          ? error.message
          : "Send outcome unknown. Retry uses the same send key.",
      } satisfies SidelineSendResult;
    }
    return {
      ok: false,
      outcome: "unknown",
      message: "Send outcome unknown. Retry uses the same send key.",
    } satisfies SidelineSendResult;
  }
});
ipcMain.handle("sideline:open-in-rally", async (event, raw) => {
  assertSender(event);
  if (!session?.workspace || !raw || typeof raw !== "object") throw new Error("No active Sideline destination");
  const input = raw as { workstreamId?: unknown; substreamId?: unknown };
  if (typeof input.workstreamId !== "string" || typeof input.substreamId !== "string") throw new Error("Invalid Sideline destination");
  const access = ChannelAccessSchema.parse(await authenticated(`/workstreams/${input.workstreamId}/access`));
  const spaceId = [...access.spaceIds].sort()[0];
  if (!spaceId) throw new Error("This channel has no Space to open");
  await shell.openExternal(workstreamDeepLink({
    region: session.workspace.region,
    workspaceId: session.workspace.id,
    spaceId,
    workstreamId: input.workstreamId,
    ...(input.substreamId === "0" ? {} : { substreamId: input.substreamId }),
  }));
});
