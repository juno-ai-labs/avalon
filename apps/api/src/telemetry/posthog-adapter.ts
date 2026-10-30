import { isRetiredMeetingTelemetry, type TelemetryEnvelope } from "@rally/contracts/telemetry";
import { PostHog } from "posthog-node";
import type {
  GlobalCrashDeliveryRow,
  GlobalProfileDeliveryRow,
  GlobalTelemetryDeliveryRow,
  TelemetryDestinationResult,
} from "./telemetry-delivery-contract";

export type {
  GlobalCrashDeliveryRow,
  GlobalProfileDeliveryRow,
  GlobalTelemetryDeliveryRow,
  TelemetryDestinationResult,
} from "./telemetry-delivery-contract";

const APPROVED_POSTHOG_ORIGINS = new Set([
  "https://us.i.posthog.com",
  "https://us.posthog.com",
]);
const POSTHOG_APP_NAME = "Rally";
const POSTHOG_APP_NAMESPACE = "app.rally.desktop";
const POSTHOG_LIBRARY = "rally-regional-telemetry";
const POSTHOG_LIBRARY_VERSION = "1";

export interface PostHogCapture {
  event: string;
  /**
   * The outbox row's id. With `event`, `timestamp` and `distinct_id`, all read
   * from the stored row, it is PostHog's deduplication key, so a re-sent row
   * collapses to one event once PostHog's background merge runs. `$insert_id`
   * carries the same id for readers that expect it; PostHog ignores it.
   */
  uuid: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

export interface PostHogExceptionClient {
  captureException(
    error: unknown,
    distinctId?: string,
    additionalProperties?: Record<string, unknown>,
    uuid?: string,
  ): void;
  flush(): Promise<void>;
}

function optionalContext(envelope: TelemetryEnvelope): Record<string, unknown> {
  const context = envelope.context;
  return {
    ...(context.region ? { region: context.region } : {}),
    ...(context.platform ? { platform: context.platform } : {}),
    ...(context.arch ? { architecture: context.arch } : {}),
    ...(context.channel ? { channel: context.channel } : {}),
    ...(context.launchId ? { launch_id: context.launchId } : {}),
    ...(context.sessionId || context.launchId
      ? { $session_id: context.sessionId ?? context.launchId }
      : {}),
    ...(context.onboardingJourneyId ? { onboarding_journey_id: context.onboardingJourneyId } : {}),
    ...(context.operationId ? { operation_id: context.operationId } : {}),
    ...(context.requestId ? { request_id: context.requestId } : {}),
    ...(context.traceId ? { trace_id: context.traceId } : {}),
    ...(context.spanId ? { span_id: context.spanId } : {}),
  };
}

function postHogOsName(platform: "darwin" | "win32" | "linux"): "macOS" | "Windows" | "Linux" {
  if (platform === "darwin") return "macOS";
  if (platform === "win32") return "Windows";
  return "Linux";
}

function postHogWebOsName(platform: "darwin" | "win32" | "linux"): "Mac OS X" | "Windows" | "Linux" {
  if (platform === "darwin") return "Mac OS X";
  return platform === "win32" ? "Windows" : "Linux";
}

function desktopApplicationContext(input: {
  release: string;
  buildId: string;
  platform: "darwin" | "win32" | "linux" | undefined;
  deviceId?: string | undefined;
  osVersion?: string | undefined;
  locale?: string | undefined;
  timezone?: string | undefined;
  screenWidth?: number | undefined;
  screenHeight?: number | undefined;
  viewportWidth?: number | undefined;
  viewportHeight?: number | undefined;
  windowId?: string | undefined;
}): Record<string, unknown> {
  const osName = input.platform ? postHogOsName(input.platform) : undefined;
  return {
    $app_name: POSTHOG_APP_NAME,
    $app_namespace: POSTHOG_APP_NAMESPACE,
    $app_version: input.release,
    $app_build: input.buildId,
    $device_type: "Desktop",
    ...(osName && input.platform ? { $os_name: osName, $os: postHogWebOsName(input.platform) } : {}),
    ...(input.deviceId ? { $device_id: input.deviceId } : {}),
    ...(input.osVersion ? { $os_version: input.osVersion } : {}),
    ...(input.locale ? { $locale: input.locale } : {}),
    ...(input.timezone ? { $timezone: input.timezone } : {}),
    ...(input.screenWidth ? { $screen_width: input.screenWidth } : {}),
    ...(input.screenHeight ? { $screen_height: input.screenHeight } : {}),
    ...(input.viewportWidth ? { $viewport_width: input.viewportWidth } : {}),
    ...(input.viewportHeight ? { $viewport_height: input.viewportHeight } : {}),
    ...(input.windowId ? { $window_id: input.windowId } : {}),
  };
}

function destinationEvent(envelope: TelemetryEnvelope, webBaseUrl: string): {
  event: string;
  properties: Record<string, unknown>;
} {
  if (envelope.name === "screen_viewed" || envelope.name === "surface_viewed") {
    return {
      event: "$screen",
      properties: { $screen_name: envelope.properties["screen"] ?? envelope.properties["surface"] },
    };
  }
  if (envelope.name === "site_page_viewed") return { event: "$pageview", properties: webPageContext(envelope, webBaseUrl) };
  if (envelope.name === "site_page_left") return { event: "$pageleave", properties: webPageContext(envelope, webBaseUrl) };
  if (envelope.name === "application_lifecycle") {
    const state = envelope.properties["state"];
    if (state === "background") return { event: "Application Backgrounded", properties: {} };
  }
  if (envelope.name === "application_opened") {
    const phase = envelope.properties["phase"];
    return {
      event: "Application Opened",
      properties: {
        application_open_source: envelope.properties["entrypoint"],
        from_background: phase === "activation",
        ...(phase === "cold_start"
          ? { version: envelope.context.release, build: envelope.context.buildId }
          : {}),
      },
    };
  }
  if (envelope.name === "application_version_changed") {
    if (envelope.properties["state"] === "installed") {
      return {
        event: "Application Installed",
        properties: { version: envelope.context.release, build: envelope.context.buildId },
      };
    }
    return {
      event: "Application Updated",
      properties: {
        version: envelope.context.release,
        build: envelope.context.buildId,
        previous_version: envelope.properties["previousVersion"],
        previous_build: envelope.properties["previousBuild"],
      },
    };
  }
  return { event: envelope.name, properties: {} };
}

/**
 * Rebuilds the page URL PostHog's web analytics reads from the one part of it
 * the site is allowed to report.
 *
 * A site envelope carries a `pathname` and nothing else about where it came
 * from — deliberately, per `docs/public-site-telemetry.md`. The origin is
 * therefore supplied here, from the deployment's own configured web base URL
 * rather than a literal, so it follows the canonical domain instead of having
 * to be found and edited when that domain changes.
 *
 * That makes the host the *canonical* one, not the one that served the page:
 * while two domains both answer, a visit arriving on either is attributed to
 * whichever `PUBLIC_WEB_BASE_URL` names. Splitting acquisition by domain would
 * mean the site reporting its own host, which is a registered telemetry
 * property and a privacy-boundary decision — not a default worth assuming.
 */
function webPageContext(envelope: TelemetryEnvelope, webBaseUrl: string): Record<string, unknown> {
  const pathname = envelope.properties["pathname"];
  if (typeof pathname !== "string") return {};
  const referringDomain = envelope.properties["referringDomain"];
  const base = new URL(webBaseUrl);
  return {
    // Concatenated onto the origin rather than resolved against it: the
    // telemetry schema admits a pathname beginning with `//`, which `new URL`
    // reads as a network-path reference and resolves to a different host
    // entirely. It is reachable by visiting a doubled-slash path on our own
    // site, and would report someone else's host as ours.
    $current_url: `${base.origin}${pathname}`,
    $pathname: pathname,
    $host: base.host,
    ...(typeof referringDomain === "string"
      ? { $referrer: `https://${referringDomain}/`, $referring_domain: referringDomain }
      : {}),
    ...(typeof envelope.properties["campaignSource"] === "string"
      ? { $utm_source: envelope.properties["campaignSource"] }
      : {}),
    ...(typeof envelope.properties["campaignMedium"] === "string"
      ? { $utm_medium: envelope.properties["campaignMedium"] }
      : {}),
    ...(typeof envelope.properties["campaignName"] === "string"
      ? { $utm_campaign: envelope.properties["campaignName"] }
      : {}),
  };
}

function applicationSettingsPersonProperties(envelope: TelemetryEnvelope): Record<string, unknown> | null {
  if (envelope.name === "application_settings_state" || envelope.name === "application_settings_state_v2") {
    return {
      rally_launch_at_login_enabled: envelope.properties["launchAtLoginEnabled"],
      rally_launch_at_login_available: envelope.properties["launchAtLoginAvailable"],
      rally_lockdown_mode_enabled: envelope.properties["lockdownModeEnabled"],
      rally_lockdown_mode_available: envelope.properties["lockdownModeAvailable"],
      rally_application_icon: envelope.properties["applicationIcon"],
      rally_application_icon_automatic: envelope.properties["applicationIconAutomatic"],
      rally_application_icon_available: envelope.properties["applicationIconAvailable"],
      ...(envelope.name === "application_settings_state_v2" ? {
        rally_menu_bar_enabled: envelope.properties["menuBarEnabled"],
        rally_menu_bar_available: envelope.properties["menuBarAvailable"],
        rally_menu_bar_present: envelope.properties["menuBarPresent"],
      } : {}),
    };
  }
  if (envelope.name === "application_setting_change_completed"
    || envelope.name === "application_setting_change_completed_v2") {
    const setting = envelope.properties["setting"];
    if (setting === "launch_at_login") {
      return { rally_launch_at_login_enabled: envelope.properties["appliedEnabled"] };
    }
    if (setting === "lockdown_mode") {
      return { rally_lockdown_mode_enabled: envelope.properties["appliedEnabled"] };
    }
    if (setting === "menu_bar") {
      return { rally_menu_bar_enabled: envelope.properties["appliedEnabled"] };
    }
  }
  if (envelope.name === "application_icon_changed") {
    return {
      rally_application_icon: envelope.properties["selectedIcon"],
      rally_application_icon_automatic: envelope.properties["automatic"],
    };
  }
  return null;
}

export function mapPostHogCapture(
  row: GlobalTelemetryDeliveryRow,
  options: { webBaseUrl: string },
): PostHogCapture {
  const envelope = row.envelope;
  const personless = envelope.identityScope === "installation"
    || envelope.identityScope === "anonymous-epoch"
    || envelope.identityScope === "workspace";
  const mapped = destinationEvent(envelope, options.webBaseUrl);
  const desktopSource = envelope.source.startsWith("desktop-");
  const settingsPersonProperties = personless ? null : applicationSettingsPersonProperties(envelope);
  return {
    event: mapped.event,
    uuid: row.eventId,
    timestamp: row.normalizedTimestamp,
    properties: {
      distinct_id: row.analyticsSubjectId,
      $insert_id: row.eventId,
      $geoip_disable: true,
      ...(row.workspaceAnalyticsId ? { $groups: { workspace: row.workspaceAnalyticsId } } : {}),
      $lib: POSTHOG_LIBRARY,
      $lib_version: POSTHOG_LIBRARY_VERSION,
      ...(envelope.source === "api" ? { $is_server: true } : {}),
      $process_person_profile: !personless,
      $is_identified: !personless,
      ...(!personless ? { $set_once: { first_rally_release: envelope.context.release } } : {}),
      ...(settingsPersonProperties ? { $set: settingsPersonProperties } : {}),
      ...(desktopSource ? desktopApplicationContext({
        release: envelope.context.release,
        buildId: envelope.context.buildId,
        platform: envelope.context.platform,
        deviceId: envelope.context.deviceId,
        osVersion: envelope.context.osVersion,
        locale: envelope.context.locale,
        timezone: envelope.context.timezone,
        screenWidth: envelope.context.screenWidth,
        screenHeight: envelope.context.screenHeight,
        viewportWidth: envelope.context.viewportWidth,
        viewportHeight: envelope.context.viewportHeight,
        windowId: envelope.context.windowId,
      }) : {}),
      rally_event_name: envelope.name,
      schema_version: envelope.schemaVersion,
      source: envelope.source,
      category: envelope.category,
      environment: envelope.context.environment,
      release: envelope.context.release,
      build_id: envelope.context.buildId,
      ...optionalContext(envelope),
      ...envelope.properties,
      ...mapped.properties,
    },
  };
}

function nativeCrashError(row: GlobalCrashDeliveryRow): Error {
  const processName = row.processRole === "unknown"
    ? "NativeCrash"
    : `Native${row.processRole[0]!.toUpperCase()}${row.processRole.slice(1)}Crash`;
  const humanProcess = row.processRole === "unknown" ? "process" : row.processRole;
  const error = new Error(`Native ${humanProcess} crash`);
  error.name = processName;
  const frames = nativeStackFrames(row.report);
  if (frames.length > 0) {
    error.stack = `${processName}: ${error.message}\n${frames.map((frame) => `    at ${frame}`).join("\n")}`;
  }
  return error;
}

function nativeStackFrames(report: unknown): string[] {
  if (!report || typeof report !== "object" || Array.isArray(report)) return [];
  const threads = (report as Record<string, unknown>)["threads"];
  if (!Array.isArray(threads)) return [];
  const result: string[] = [];
  for (const thread of threads) {
    if (!thread || typeof thread !== "object" || Array.isArray(thread)) continue;
    const frames = (thread as Record<string, unknown>)["frames"];
    if (!Array.isArray(frames)) continue;
    for (const frame of frames) {
      if (!frame || typeof frame !== "object" || Array.isArray(frame)) continue;
      const values = frame as Record<string, unknown>;
      const functionName = safeStackToken(values["function"], "native_frame");
      const moduleName = safeStackToken(values["module"] ?? values["file"], "native");
      const line = safeStackCoordinate(values["line"]);
      const column = safeStackCoordinate(values["column"]);
      result.push(`${functionName} (${moduleName}:${line}:${column})`);
      if (result.length === 100) return result;
    }
  }
  return result;
}

function safeStackToken(value: unknown, fallback: string): string {
  if (typeof value !== "string" || value.length === 0) return fallback;
  const bounded = value.slice(0, 160).replace(/[^a-zA-Z0-9_.$+<>@/-]/gu, "_");
  return bounded || fallback;
}

function safeStackCoordinate(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function javascriptExceptionError(row: GlobalTelemetryDeliveryRow): Error {
  const properties = row.envelope.properties as {
    process: "main" | "preload" | "renderer";
    errorCode: "type_error" | "range_error" | "unhandled_rejection" | "react_boundary" | "network_error" | "unknown";
    generatedFrames: string[];
  };
  const name = properties.errorCode.split("_")
    .map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`)
    .join("");
  const error = new Error(`Avalon ${properties.process} exception`);
  error.name = name;
  const frames = row.symbolicatedFrames ?? properties.generatedFrames;
  error.stack = `${name}: ${error.message}\n${frames.map((frame) => `    at ${frame}`).join("\n")}`;
  return error;
}

export function mapPostHogProfileCapture(row: GlobalProfileDeliveryRow): PostHogCapture {
  const shared = {
    $insert_id: row.jobId,
    $geoip_disable: true,
    $lib: POSTHOG_LIBRARY,
    $lib_version: POSTHOG_LIBRARY_VERSION,
    $is_server: true,
  };
  if (row.kind === "epoch_transition") {
    if (!row.anonymousEpochId) throw new Error("posthog_anonymous_epoch_required");
    return {
      event: "$identify",
      uuid: row.jobId,
      timestamp: row.createdAt,
      properties: {
        distinct_id: row.destinationAnalyticsId,
        $anon_distinct_id: row.anonymousEpochId,
        $set: row.properties,
        ...shared,
      },
    };
  }
  if (row.kind === "person_profile") {
    return {
      event: "$set",
      uuid: row.jobId,
      timestamp: row.createdAt,
      properties: { distinct_id: row.destinationAnalyticsId, $set: row.properties, ...shared },
    };
  }
  return {
    event: "$groupidentify",
    uuid: row.jobId,
    timestamp: row.createdAt,
    properties: {
      distinct_id: "avalon-server",
      $group_type: "workspace",
      $group_key: row.destinationAnalyticsId,
      $group_set: row.properties,
      ...shared,
    },
  };
}

function retryAfter(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

export async function sendPostHogBatch(input: {
  host: string;
  projectToken: string;
  webBaseUrl: string;
  rows: GlobalTelemetryDeliveryRow[];
}): Promise<TelemetryDestinationResult> {
  const rows = input.rows.filter(row => !isRetiredMeetingTelemetry(row.envelope));
  if (rows.length === 0) return { result: "delivered", requestId: null, retryAfterMs: null };
  return sendPostHogCaptures({
    host: input.host,
    projectToken: input.projectToken,
    captures: rows.map((row) => mapPostHogCapture(row, { webBaseUrl: input.webBaseUrl })),
  });
}

export async function sendPostHogCrashBatch(input: {
  host: string;
  projectToken: string;
  rows: GlobalCrashDeliveryRow[];
  clientFactory?: (projectToken: string, host: string) => PostHogExceptionClient;
}): Promise<TelemetryDestinationResult> {
  const origin = new URL(input.host).origin;
  if (!APPROVED_POSTHOG_ORIGINS.has(origin)) throw new Error("posthog_host_forbidden");
  const client = (input.clientFactory ?? createExceptionClient)(input.projectToken, origin);
  try {
    for (const row of input.rows) {
      client.captureException(nativeCrashError(row), row.analyticsSubjectId, {
        $geoip_disable: true,
        ...(row.workspaceAnalyticsId ? { $groups: { workspace: row.workspaceAnalyticsId } } : {}),
        ...desktopApplicationContext({
          release: row.release,
          buildId: row.buildId,
          platform: row.platform,
          deviceId: row.deviceId,
        }),
        $process_person_profile: row.processPersonProfile,
        $is_identified: row.processPersonProfile,
        $exception_fingerprint: row.fingerprint,
        $exception_source: "rally_native",
        $exception_level: "fatal",
        category: "diagnostic",
        release: row.release,
        build_id: row.buildId,
        platform: row.platform,
        architecture: row.architecture,
        process: row.processRole,
        $session_id: row.launchId,
        launch_id: row.launchId,
        channel: row.channel,
        parser_state: row.parserState,
        native_crash_report: row.report,
      }, row.crashId);
    }
    await client.flush();
    return { result: "delivered", requestId: null, retryAfterMs: null };
  } catch {
    return { result: "retry", requestId: null, retryAfterMs: null };
  }
}

export async function sendPostHogJavascriptExceptionBatch(input: {
  host: string;
  projectToken: string;
  rows: GlobalTelemetryDeliveryRow[];
  clientFactory?: (projectToken: string, host: string) => PostHogExceptionClient;
}): Promise<TelemetryDestinationResult> {
  const origin = new URL(input.host).origin;
  if (!APPROVED_POSTHOG_ORIGINS.has(origin)) throw new Error("posthog_host_forbidden");
  const client = (input.clientFactory ?? createExceptionClient)(input.projectToken, origin);
  try {
    for (const row of input.rows) {
      if (row.envelope.name !== "javascript_exception") throw new Error("posthog_exception_event_required");
      const properties = row.envelope.properties as {
        process: string;
        errorCode: string;
        breadcrumbStatus: string;
        fingerprint: string;
      };
      client.captureException(javascriptExceptionError(row), row.analyticsSubjectId, {
        $geoip_disable: true,
        ...(row.workspaceAnalyticsId ? { $groups: { workspace: row.workspaceAnalyticsId } } : {}),
        ...desktopApplicationContext({
          release: row.envelope.context.release,
          buildId: row.envelope.context.buildId,
          platform: row.envelope.context.platform,
          deviceId: row.envelope.context.deviceId,
          osVersion: row.envelope.context.osVersion,
          locale: row.envelope.context.locale,
          timezone: row.envelope.context.timezone,
          screenWidth: row.envelope.context.screenWidth,
          screenHeight: row.envelope.context.screenHeight,
          viewportWidth: row.envelope.context.viewportWidth,
          viewportHeight: row.envelope.context.viewportHeight,
          windowId: row.envelope.context.windowId,
        }),
        $process_person_profile: true,
        $is_identified: true,
        rally_event_name: row.envelope.name,
        $exception_fingerprint: properties.fingerprint,
        $exception_source: "rally_javascript",
        category: "diagnostic",
        schema_version: row.envelope.schemaVersion,
        source: row.envelope.source,
        environment: row.envelope.context.environment,
        release: row.envelope.context.release,
        build_id: row.envelope.context.buildId,
        ...optionalContext(row.envelope),
        process: properties.process,
        error_code: properties.errorCode,
        breadcrumb_status: properties.breadcrumbStatus,
      }, row.eventId);
    }
    await client.flush();
    return { result: "delivered", requestId: null, retryAfterMs: null };
  } catch {
    return { result: "retry", requestId: null, retryAfterMs: null };
  }
}

function createExceptionClient(projectToken: string, host: string): PostHogExceptionClient {
  return new PostHog(projectToken, {
    host,
    disableGeoip: true,
    enableExceptionAutocapture: false,
    enableLocalEvaluation: false,
    isServer: false,
    flushAt: 50,
    flushInterval: 0,
    fetchRetryCount: 0,
    requestTimeout: 10_000,
  });
}

export async function sendPostHogProfileBatch(input: {
  host: string;
  projectToken: string;
  rows: GlobalProfileDeliveryRow[];
}): Promise<TelemetryDestinationResult> {
  return sendPostHogCaptures({
    host: input.host,
    projectToken: input.projectToken,
    captures: input.rows.map(mapPostHogProfileCapture),
  });
}

async function sendPostHogCaptures(input: {
  host: string;
  projectToken: string;
  captures: PostHogCapture[];
}): Promise<TelemetryDestinationResult> {
  const origin = new URL(input.host).origin;
  if (!APPROVED_POSTHOG_ORIGINS.has(origin)) throw new Error("posthog_host_forbidden");
  let response: Response;
  try {
    response = await fetch(`${origin}/batch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: input.projectToken,
        batch: input.captures,
      }),
    });
  } catch {
    return { result: "retry", requestId: null, retryAfterMs: null };
  }
  const requestId = response.headers.get("x-request-id");
  if (response.ok) return { result: "delivered", requestId, retryAfterMs: null };
  if (response.status === 408 || response.status === 429 || response.status >= 500) {
    return { result: "retry", requestId, retryAfterMs: retryAfter(response) };
  }
  return { result: "terminal", requestId, retryAfterMs: null };
}
