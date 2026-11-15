import { RegisterPushDeviceRequestSchema } from '@rally/contracts/push-notifications';
import { MobileAuthExchangeSchema } from '@rally/contracts';
import { MobileCrashReportSchema, MobileCrashScopeSchema } from '@rally/contracts/crash-reports';
import { z } from 'zod';
import { parseArtifactHost, parseArtifactSiteOpenPath } from '@rally/contracts';
import { HttpUrlSchema } from '@rally/contracts/url-schemas';

// Presentation capacity, from the approved Home + four tabs design. This is not
// a server pin limit: pins made on desktop remain in the sidebar in full.
export const VISIBLE_PIN_COUNT = 4;
export const MOBILE_CHANNEL = 'rally.mobile.v1';
export const MOBILE_COMMAND_EVENT = 'rally:mobile-command';

/** The bootstrap may redeem, but must stop before generated code loads. */
export function artifactPreparationNavigation(canonicalUrl: string, target: string): 'allow' | 'ready' | 'block' {
  try {
    const canonical = new URL(canonicalUrl);
    const url = new URL(target);
    if (url.href === canonical.href) return 'ready';
    return url.origin === canonical.origin && ['/__rally/open', '/__rally/redeem'].includes(url.pathname) ? 'allow' : 'block';
  } catch { return 'block'; }
}

export function artifactLoadFailure(access: { openUrl: string; canonicalUrl: string }, target: string, status: number): 'ignore' | 'renew' | 'fail' {
  const mainDocument = [new URL(access.openUrl).href, new URL(access.canonicalUrl).href, new URL('/__rally/redeem', access.canonicalUrl).href].includes(target);
  if (!mainDocument || status < 400) return 'ignore';
  return access.openUrl === access.canonicalUrl && [401, 403].includes(status) ? 'renew' : 'fail';
}

/** Only the serving Worker's handoff for this site can renew a lost cookie. */
export function artifactAuthHandoff(canonicalUrl: string, target: string, appUrl: string): boolean {
  try {
    const url = new URL(target);
    const host = parseArtifactHost(new URL(canonicalUrl).host);
    const handoff = parseArtifactSiteOpenPath(url.pathname);
    return url.origin === new URL(appUrl).origin && !url.username && !url.password
      && Boolean(host?.hostnameStub && handoff && host.hostnameStub === handoff.hostnameStub && host.region === handoff.region);
  } catch { return false; }
}

export const CanvasSummarySchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  icon: z.string().nullable().optional(),
  color: z.string().nullable().optional(),
  updatedAt: z.string(),
});
export type CanvasSummary = z.infer<typeof CanvasSummarySchema>;

export const MobileSnapshotSchema = z.object({
  userId: z.string(),
  userName: z.string(),
  workspaceId: z.string(),
  workspaceName: z.string(),
  workspacePath: z.string().regex(/^\/app\/workspaces\/[^/?#]+\/[^/?#]+$/u),
  canvases: z.array(CanvasSummarySchema),
  pins: z.array(z.string()),
  hasMore: z.boolean(),
  loading: z.boolean(),
  pinBusy: z.boolean(),
  pinError: z.string().nullable(),
  directoryError: z.boolean().default(false),
  canvasId: z.string().nullable(),
  tabId: z.string().nullable(),
  view: z.enum(['home', 'artifact', 'conversation', 'create']),
  title: z.string(),
  artifactId: z.string().nullable(),
  artifactPicker: z.boolean(),
  inlineChat: z.boolean().optional(),
});
export type MobileSnapshot = z.infer<typeof MobileSnapshotSchema>;

export const NativeArtifactSchema = z.object({
  canvasId: z.string(), resourceId: z.string(), version: z.number().int().positive(),
  openUrl: z.string(), canonicalUrl: z.string(),
});
export type NativeArtifact = z.infer<typeof NativeArtifactSchema>;

/** Artifact code gets its own origin and no application bridge. */
export function trustedArtifact(access: NativeArtifact, domain: string): boolean {
  try {
    const opened = new URL(access.openUrl), canonical = new URL(access.canonicalUrl);
    const suffix = `.${domain}`;
    return opened.origin === canonical.origin && opened.hostname.endsWith(suffix)
      && !opened.hostname.slice(0, -suffix.length).includes('.')
      && opened.hostname.length > suffix.length && !opened.username && !opened.password
      && !canonical.username && !canonical.password
      && (opened.protocol === 'https:' || (opened.protocol === 'http:' && domain.endsWith('.localhost')));
  } catch { return false; }
}

export const PreparedCanvasSchema = z.object({ canvasId: z.string(), resourceId: z.string(), version: z.number().int().positive(), title: z.string() });
export type PreparedCanvas = z.infer<typeof PreparedCanvasSchema>;

/** A web build is named by its entry script, whose hash changes with any chunk it loads. */
export function webBuildFromHtml(html: string): string | null {
  return /<script\b[^>]*\btype="module"[^>]*\bsrc="(\/assets\/[^"]+\.js)"/u.exec(html)?.[1] ?? null;
}

export const MobileEventSchema = z.discriminatedUnion('type', [
  // `build` is the page's entry script path. Older hosts omit it.
  z.object({ type: z.literal('ready'), waitForContent: z.boolean().optional(), build: z.string().optional() }),
  z.object({ type: z.literal('screen-ready') }),
  z.object({ type: z.literal('crash-permission'), requestId: z.string().uuid(), scope: MobileCrashScopeSchema, enabled: z.boolean() }),
  z.object({ type: z.literal('crash-uploaded'), scope: MobileCrashScopeSchema, uploadId: z.string().uuid(), ok: z.boolean() }),
  z.object({ type: z.literal('notification-opened'), url: HttpUrlSchema }),
  z.object({ type: z.literal('push-device-result'), requestId: z.string().uuid(), userId: z.string(), workspaceId: z.string(), ok: z.boolean(), enabled: z.boolean() }),
  z.object({ type: z.literal('sign-in') }),
  z.object({ type: z.literal('prepared-canvas'), userId: z.string(), workspaceId: z.string(), canvasId: z.string(), canvas: PreparedCanvasSchema.nullable() }),
  z.object({ type: z.literal('prepared-artifact'), requestId: z.string(), artifact: NativeArtifactSchema.nullable() }),
  z.object({ type: z.literal('artifact'), artifact: NativeArtifactSchema }),
  z.object({ type: z.literal('artifact-unavailable'), canvasId: z.string(), resourceId: z.string() }),
  z.object({ type: z.literal('open-canvas'), id: z.string().min(1) }),
  z.object({ type: z.literal('signed-out') }),
  z.object({ type: z.literal('snapshot'), snapshot: MobileSnapshotSchema }),
]);
export type MobileEvent = z.infer<typeof MobileEventSchema>;

export const MobileCommandSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('home') }),
  z.object({ type: z.literal('crash-status'), requestId: z.string().uuid() }),
  z.object({ type: z.literal('crash-upload'), report: MobileCrashReportSchema }),
  z.object({ type: z.literal('push-device'), requestId: z.string().uuid(), userId: z.string(), workspaceId: z.string(), installationId: z.string().uuid(), registration: RegisterPushDeviceRequestSchema.nullable() }),
  z.object({ type: z.literal('open-notification'), url: HttpUrlSchema }),
  z.object({ type: z.literal('sign-in-complete'), proof: MobileAuthExchangeSchema }),
  z.object({ type: z.literal('create') }),
  z.object({ type: z.literal('open-chat'), id: z.string().min(1) }),
  z.object({ type: z.literal('close-chat') }),
  z.object({ type: z.literal('open'), id: z.string().min(1), pinned: z.boolean() }),
  z.object({ type: z.literal('pin'), id: z.string().min(1), pinned: z.boolean(), beforeId: z.string().min(1).optional() }),
  z.object({ type: z.literal('reorder'), ids: z.array(z.string().min(1)) }),
  z.object({ type: z.literal('load-more') }),
  z.object({ type: z.literal('refresh') }),
  z.object({ type: z.literal('sign-out') }),
  z.object({ type: z.literal('switch-workspace') }),
  z.object({ type: z.literal('open-prepared-artifact'), requestId: z.string(), userId: z.string(), workspaceId: z.string(), canvas: PreparedCanvasSchema }),
  z.object({ type: z.literal('reopen-artifact'), canvasId: z.string(), resourceId: z.string() }),
]);
export type MobileCommand = z.infer<typeof MobileCommandSchema>;

export const MobileEnvelopeSchema = z.object({
  channel: z.literal(MOBILE_CHANNEL),
  token: z.string().min(1),
  event: MobileEventSchema,
});

/** Only the configured application origin can supply shell state. */
export function isAppUrl(candidate: string, appUrl: string): boolean {
  try {
    const target = new URL(candidate);
    const app = new URL(appUrl);
    return target.origin === app.origin && !target.username && !target.password
      && (target.pathname === '/' || target.pathname.startsWith('/app/'));
  } catch { return false; }
}

export function parseMobileEvent(data: string, url: string, appUrl: string, token: string): MobileEvent | null {
  if (!isAppUrl(url, appUrl)) return null;
  try {
    const parsed = MobileEnvelopeSchema.safeParse(JSON.parse(data));
    return parsed.success && parsed.data.token === token ? parsed.data.event : null;
  } catch { return null; }
}

export function mobileUrl(base: string, workspacePath?: string, conversationId?: string): string {
  const url = new URL(workspacePath ?? '/', base);
  url.searchParams.set('mobile', '1');
  url.hash = conversationId ? `/canvases/${encodeURIComponent(conversationId)}?view=chat` : '/canvases';
  return url.href;
}

/** Used by native injection and the browser preview. Payloads remain data. */
export function commandScript(command: MobileCommand, appUrl?: string): string {
  const dispatch = `window.dispatchEvent(new CustomEvent(${JSON.stringify(MOBILE_COMMAND_EVENT)}, {detail: ${JSON.stringify(command)}}));`;
  // Re-check at execution, since navigation can race an authentication sheet.
  // In particular, a same-origin resource document must never receive proof.
  return appUrl
    ? `if (location.origin === ${JSON.stringify(new URL(appUrl).origin)} && (location.pathname === "/" || location.pathname.startsWith("/app/"))) { ${dispatch} } true;`
    : `${dispatch} true;`;
}

export function movePin(ids: readonly string[], from: number, to: number): string[] {
  const result = [...ids];
  if (from < 0 || to < 0 || from >= ids.length || to >= ids.length) return result;
  const [id] = result.splice(from, 1);
  if (id !== undefined) result.splice(to, 0, id);
  return result;
}

/** New hosts wait for usable content; older deployed hosts keep their handshake. */
export function mobileContentReady(event: MobileEvent): boolean {
  return (event.type === 'ready' && !event.waitForContent)
    || event.type === 'screen-ready' || event.type === 'signed-out'
    || (event.type === 'snapshot' && (!event.snapshot.loading || event.snapshot.directoryError));
}
