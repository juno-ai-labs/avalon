import type { TelemetryEnvelope } from "@avalon/contracts/telemetry";
import { PostHog } from "posthog-node";

const APPROVED_POSTHOG_ORIGINS = new Set([
  "https://us.i.posthog.com",
  "https://us.posthog.com",
]);

export interface GlobalTelemetryDeliveryRow {
  eventId: string;
  envelope: TelemetryEnvelope;
  analyticsSubjectId: string;
  workspaceAnalyticsId: string | null;
  normalizedTimestamp: string;
  /** Regionally resolved application locations. Source contents and paths are never included. */
  symbolicatedFrames?: string[];
}

export interface GlobalCrashDeliveryRow {
  crashId: string;
  analyticsSubjectId: string;
  workspaceAnalyticsId: string | null;
  processPersonProfile: boolean;
  receivedAt: string;
  release: string;
  buildId: string;
  platform: "darwin" | "win32" | "linux";
  architecture: "arm64" | "x64";
  processRole: "main" | "renderer" | "utility" | "gpu" | "unknown";
  launchId: string;
  channel: "development" | "alpha" | "beta" | "stable";
  parserState: "symbolicated" | "unsymbolicated" | "malformed";
  fingerprint: string;
  report: unknown;
}

export interface GlobalProfileDeliveryRow {
  jobId: string;
  kind: "epoch_transition" | "person_profile" | "group_profile";
  destinationAnalyticsId: string;
  anonymousEpochId: string | null;
  properties: Record<string, string>;
  createdAt: string;
}

export interface PostHogCapture {
  event: string;
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

export function mapPostHogCapture(row: GlobalTelemetryDeliveryRow): PostHogCapture {
  const envelope = row.envelope;
  const personless = envelope.identityScope === "installation" || envelope.identityScope === "anonymous-epoch";
  return {
    event: envelope.name,
    timestamp: row.normalizedTimestamp,
    properties: {
      distinct_id: row.analyticsSubjectId,
      $insert_id: row.eventId,
      $geoip_disable: true,
      ...(row.workspaceAnalyticsId ? { $groups: { workspace: row.workspaceAnalyticsId } } : {}),
      $lib: "avalon-regional-telemetry",
      $lib_version: "1",
      $process_person_profile: !personless,
      ...(!personless ? { $set_once: { first_avalon_release: envelope.context.release } } : {}),
      schema_version: envelope.schemaVersion,
      source: envelope.source,
      category: envelope.category,
      environment: envelope.context.environment,
      release: envelope.context.release,
      build_id: envelope.context.buildId,
      ...optionalContext(envelope),
      ...envelope.properties,
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
    $lib: "avalon-regional-telemetry",
    $lib_version: "1",
  };
  if (row.kind === "epoch_transition") {
    if (!row.anonymousEpochId) throw new Error("posthog_anonymous_epoch_required");
    return {
      event: "$identify",
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
      timestamp: row.createdAt,
      properties: { distinct_id: row.destinationAnalyticsId, $set: row.properties, ...shared },
    };
  }
  return {
    event: "$groupidentify",
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

export type PostHogDeliveryResult = {
  result: "delivered" | "retry" | "terminal";
  requestId: string | null;
  retryAfterMs: number | null;
};

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
  rows: GlobalTelemetryDeliveryRow[];
}): Promise<PostHogDeliveryResult> {
  return sendPostHogCaptures({
    host: input.host,
    projectToken: input.projectToken,
    captures: input.rows.map(mapPostHogCapture),
  });
}

export async function sendPostHogCrashBatch(input: {
  host: string;
  projectToken: string;
  rows: GlobalCrashDeliveryRow[];
  clientFactory?: (projectToken: string, host: string) => PostHogExceptionClient;
}): Promise<PostHogDeliveryResult> {
  const origin = new URL(input.host).origin;
  if (!APPROVED_POSTHOG_ORIGINS.has(origin)) throw new Error("posthog_host_forbidden");
  const client = (input.clientFactory ?? createExceptionClient)(input.projectToken, origin);
  try {
    for (const row of input.rows) {
      client.captureException(nativeCrashError(row), row.analyticsSubjectId, {
        $geoip_disable: true,
        ...(row.workspaceAnalyticsId ? { $groups: { workspace: row.workspaceAnalyticsId } } : {}),
        $process_person_profile: row.processPersonProfile,
        $exception_fingerprint: row.fingerprint,
        $exception_source: "avalon_native",
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
}): Promise<PostHogDeliveryResult> {
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
        $process_person_profile: true,
        $exception_fingerprint: properties.fingerprint,
        $exception_source: "avalon_javascript",
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
}): Promise<PostHogDeliveryResult> {
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
}): Promise<PostHogDeliveryResult> {
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
