import {
  ConnectorError,
  type ConnectorAdapter,
  type ConnectorAgentAdapter,
  type ConnectorConnectionContext,
  type ConnectorLogLevel,
  type ConnectorObserver,
  type ConnectorPollingActivitySource,
  type ConnectorWebhookActivitySource,
} from "./types";
import { platformErrorCode } from "@rally/contracts/platform-diagnostics";
import { zodDiagnosticCode } from "@rally/contracts/zod-diagnostics";
import type { FetchLike } from "./provider-utils";

/** Logging is diagnostic only: a sink failure must never become a connector failure. */
export function observeConnector(
  observer: ConnectorObserver | undefined,
  level: ConnectorLogLevel,
  event: string,
  fields: Record<string, unknown>,
): void {
  try {
    observer?.(level, event, fields);
  } catch {
    // Intentionally ignored. Connector delivery is more important than its log.
  }
}

export function connectorObservationErrorCode(error: unknown): string {
  if (error instanceof ConnectorError) return zodDiagnosticCode(error.cause, "schema") ?? error.code;
  if (error instanceof Error && error.name === "AbortError") return "request_aborted";
  // A schema rejection is the one "unexpected" error that knows exactly what
  // went wrong. A provider answering 200 with a body this adapter does not
  // model is an ordinary Tuesday — the shape drifts, a field goes null, an
  // array holds objects where it held strings — and the whole diagnosis is the
  // path. Collapsing it to `unexpected_error` discards that and leaves an
  // operator comparing two identical log lines.
  // `schema`, not `response`: this classifies every adapter operation, and
  // `executeTool` parses the *model's* arguments with the same `.parse` —
  // `notion.ts:824` is one of several. Naming the provider there would pin a
  // model's malformed input on the provider, which is a worse lie than the
  // generic code it replaces.
  return zodDiagnosticCode(error, "schema") ?? "unexpected_error";
}

/**
 * `connectorObservationErrorCode` plus what the adapter recorded about why:
 * the provider's own HTTP status, its rate limit, or the runtime failure behind
 * a request that never completed. `provider_error` alone is the word a GitHub
 * 404, a 403 rate limit, a 500 and a dropped connection all say, and each
 * adapter already holds which one it was in `details`. Only the status number,
 * a flag and a platform word cross — never the provider's message.
 *
 * Kept apart from `connectorObservationErrorCode` because that code is also
 * persisted and compared, where a finer value would split a known state.
 */
export function connectorDiagnosticCode(error: ConnectorError): string {
  const code = connectorObservationErrorCode(error);
  const details = error.details;
  const platform = platformErrorCode(details);
  if (platform) return `${code}:${platform}`;
  if (!details || typeof details !== "object") return code;
  const { status, rateLimited } = details as { status?: unknown; rateLimited?: unknown };
  const http = typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599
    ? `:http_${status}`
    : "";
  return `${code}${http}${rateLimited === true ? ":rate_limited" : ""}`;
}

export function connectorObservationFailureLevel(error: unknown): ConnectorLogLevel {
  if (!(error instanceof ConnectorError)) return "error";
  return error.code === "invalid_configuration" ? "error" : "warn";
}

interface ConnectorObservationContext {
  connectorType: string;
  observer?: ConnectorObserver;
}

const observationsByConnection = new WeakMap<ConnectorConnectionContext, ConnectorObservationContext>();

function registerConnectionObservation(
  connection: ConnectorConnectionContext | undefined,
  connectorType: string,
  observer: ConnectorObserver | undefined,
): void {
  if (!connection) return;
  observationsByConnection.set(connection, { connectorType, ...(observer ? { observer } : {}) });
}

function connectionFields(
  connection: ConnectorConnectionContext | undefined,
): Record<string, unknown> {
  return connection ? {
    connection_id: connection.id,
    workspace_id: connection.workspaceId,
    connection_scope: connection.scope,
    owner_user_id: connection.ownerUserId,
  } : {};
}

const PROVIDER_TIMESTAMP_IDENTIFIER_KEYS = new Set([
  "event_ts",
  "message_ts",
  "thread_ts",
  "timestamp",
  "ts",
]);

function snakeCaseIdentifierKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9_]/gu, "_")
    .replace(/_+/gu, "_")
    .toLowerCase();
}

/**
 * Retains only explicitly ID-shaped tool arguments. Values such as message
 * text and search queries never cross this boundary, while Slack channel/user
 * IDs, Linear issue IDs, Google file IDs, and similar correlation keys do.
 */
function providerIdentifierFields(connectorType: string, value: unknown): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  let remaining = 32;
  const visit = (candidate: unknown, path: string[], depth: number): void => {
    if (remaining <= 0 || depth > 4 || !candidate || typeof candidate !== "object") return;
    for (const [rawKey, item] of Object.entries(candidate as Record<string, unknown>)) {
      if (remaining <= 0) return;
      const key = snakeCaseIdentifierKey(rawKey);
      const nextPath = [...path, key];
      const isIdentifier = /(?:^|_)ids?$/u.test(key)
        || (connectorType === "slack" && PROVIDER_TIMESTAMP_IDENTIFIER_KEYS.has(key));
      if (isIdentifier && typeof item === "string" && item.length <= 500) {
        fields[`provider_${nextPath.join("_")}`] = item;
        remaining -= 1;
      } else if (
        isIdentifier
        && Array.isArray(item)
        && item.length <= 50
        && item.every((entry) => typeof entry === "string" && entry.length <= 500)
      ) {
        fields[`provider_${nextPath.join("_")}`] = item;
        remaining -= 1;
      } else if (!Array.isArray(item)) {
        visit(item, nextPath, depth + 1);
      }
    }
  };
  try {
    visit(value, [], 0);
  } catch {
    // Argument inspection is diagnostic only; unusual objects remain usable.
  }
  return fields;
}

function activityResourceIds(
  activities: readonly { providerResourceId?: string | null }[],
): string[] {
  return [...new Set(activities.flatMap((activity) => (
    activity.providerResourceId ? [activity.providerResourceId] : []
  )))].slice(0, 50);
}

/** Emits from a shared helper after its adapter wrapper registered the connection. */
export function observeConnectorConnection(
  connection: ConnectorConnectionContext,
  level: ConnectorLogLevel,
  event: string,
  fields: Record<string, unknown> = {},
): void {
  const context = observationsByConnection.get(connection);
  if (!context) return;
  observeConnector(context.observer, level, event, {
    connector_type: context.connectorType,
    ...connectionFields(connection),
    ...fields,
  });
}

async function observeAsync<T>(
  observer: ConnectorObserver | undefined,
  connectorType: string,
  operation: string,
  fields: Record<string, unknown>,
  call: () => Promise<T>,
  successFields: (result: T) => Record<string, unknown> = () => ({}),
): Promise<T> {
  const startedAt = Date.now();
  observeConnector(observer, "debug", "connector_operation_started", {
    connector_type: connectorType,
    operation,
    ...fields,
  });
  try {
    const result = await call();
    let terminalFields: Record<string, unknown> = {};
    try {
      terminalFields = successFields(result);
    } catch {
      // Deriving optional log fields must not change a successful operation.
    }
    observeConnector(observer, "info", "connector_operation_finished", {
      connector_type: connectorType,
      operation,
      outcome: "succeeded",
      duration_ms: Date.now() - startedAt,
      ...fields,
      ...terminalFields,
    });
    return result;
  } catch (error) {
    observeConnector(observer, connectorObservationFailureLevel(error), "connector_operation_finished", {
      connector_type: connectorType,
      operation,
      outcome: "failed",
      code: connectorObservationErrorCode(error),
      duration_ms: Date.now() - startedAt,
      ...fields,
    });
    throw error;
  }
}

function observeSync<T>(
  observer: ConnectorObserver | undefined,
  connectorType: string,
  operation: string,
  fields: Record<string, unknown>,
  call: () => T,
  successFields: (result: T) => Record<string, unknown> = () => ({}),
): T {
  const startedAt = Date.now();
  observeConnector(observer, "debug", "connector_operation_started", {
    connector_type: connectorType,
    operation,
    ...fields,
  });
  try {
    const result = call();
    let terminalFields: Record<string, unknown> = {};
    try {
      terminalFields = successFields(result);
    } catch {
      // Deriving optional log fields must not change a successful operation.
    }
    observeConnector(observer, "info", "connector_operation_finished", {
      connector_type: connectorType,
      operation,
      outcome: "succeeded",
      duration_ms: Date.now() - startedAt,
      ...fields,
      ...terminalFields,
    });
    return result;
  } catch (error) {
    observeConnector(observer, connectorObservationFailureLevel(error), "connector_operation_finished", {
      connector_type: connectorType,
      operation,
      outcome: "failed",
      code: connectorObservationErrorCode(error),
      duration_ms: Date.now() - startedAt,
      ...fields,
    });
    throw error;
  }
}

function instrumentAgent(
  connectorType: string,
  surface: "native_agent" | "messaging_agent",
  agent: ConnectorAgentAdapter,
  observer: ConnectorObserver | undefined,
): ConnectorAgentAdapter {
  return {
    ...agent,
    parseInvocation(payload) {
      return observeSync(observer, connectorType, `${surface}_parse_invocation`, {}, () => (
        agent.parseInvocation(payload)
      ));
    },
    ...(agent.activationAcknowledgement ? {
      activationAcknowledgement(invocation: unknown) {
        return observeSync(
          observer,
          connectorType,
          `${surface}_activation_acknowledgement`,
          {},
          () => agent.activationAcknowledgement!(invocation),
          (command) => ({ outcome: command === null ? "skipped" : "created" }),
        );
      },
    } : {}),
    execute(command, context) {
      registerConnectionObservation(context.connection, connectorType, observer);
      return observeAsync(
        observer,
        connectorType,
        `${surface}_execute`,
        connectionFields(context.connection),
        () => agent.execute(command, context),
      );
    },
  };
}

function instrumentWebhook(
  connectorType: string,
  source: ConnectorWebhookActivitySource,
  observer: ConnectorObserver | undefined,
): ConnectorWebhookActivitySource {
  return {
    verify(input) {
      return observeAsync(observer, connectorType, "webhook_verify", {}, () => source.verify(input), (result) => ({
        delivery_id: result.deliveryId,
        provider_account_id: result.providerAccountId,
        event_type: result.eventType,
      }));
    },
    normalize(connection, event, payloadRef) {
      registerConnectionObservation(connection, connectorType, observer);
      return observeSync(
        observer,
        connectorType,
        "webhook_normalize",
        {
          ...connectionFields(connection),
          delivery_id: event.deliveryId,
          provider_account_id: event.providerAccountId,
          event_type: event.eventType,
        },
        () => source.normalize(connection, event, payloadRef),
        (activity) => ({
          outcome: activity === null ? "ignored" : "normalized",
          provider_resource_id: activity?.providerResourceId ?? null,
        }),
      );
    },
    // Carried through by name, like the two above. This wrapper is the only
    // copy of the source the host ever sees, so an optional method left out
    // here is silently absent everywhere — the first `derive` was.
    ...(source.derive ? {
      derive(connection, activity, event, signal) {
        registerConnectionObservation(connection, connectorType, observer);
        return observeAsync(
          observer,
          connectorType,
          "webhook_derive",
          {
            ...connectionFields(connection),
            delivery_id: event.deliveryId,
            provider_account_id: event.providerAccountId,
            event_type: event.eventType,
          },
          () => source.derive!(connection, activity, event, signal),
          (derived) => ({
            outcome: derived.outcome,
            derived_event_types: derived.activities.map((entry) => entry.eventType),
            ...(derived.failure ? {
              failure_code: derived.failure.code,
              ...(derived.failure.status !== undefined ? { failure_status: derived.failure.status } : {}),
            } : {}),
          }),
        );
      },
    } : {}),
  };
}

function instrumentPolling(
  connectorType: string,
  source: ConnectorPollingActivitySource,
  observer: ConnectorObserver | undefined,
): ConnectorPollingActivitySource {
  return {
    streams(connection) {
      registerConnectionObservation(connection, connectorType, observer);
      return observeSync(
        observer,
        connectorType,
        "poll_streams_list",
        connectionFields(connection),
        () => source.streams(connection),
        (streams) => ({ stream_count: streams.length }),
      );
    },
    normalizeHighWatermark(connection, stream, highWatermark) {
      registerConnectionObservation(connection, connectorType, observer);
      return observeSync(
        observer,
        connectorType,
        "poll_high_watermark_normalize",
        { ...connectionFields(connection), stream_id: stream.id },
        () => source.normalizeHighWatermark(connection, stream, highWatermark),
      );
    },
    pollStream(connection, stream, highWatermark, signal) {
      registerConnectionObservation(connection, connectorType, observer);
      return observeAsync(
        observer,
        connectorType,
        "poll_stream",
        { ...connectionFields(connection), stream_id: stream.id },
        () => source.pollStream(connection, stream, highWatermark, signal),
        (result) => ({
          activity_count: result.activities.length,
          has_more: result.hasMore,
          provider_resource_ids: activityResourceIds(result.activities),
        }),
      );
    },
  };
}

/**
 * Adds content-free lifecycle logs to every optional and required adapter
 * surface. The adapter remains the source of behavior; this wrapper only
 * records starts and terminal outcomes.
 */
export function instrumentConnectorAdapter(
  adapter: ConnectorAdapter,
  observer: ConnectorObserver | undefined,
): ConnectorAdapter {
  const connectorType = adapter.manifest.type;
  return {
    ...adapter,
    ...(adapter.dynamicAgentTools ? {
      dynamicAgentTools: {
        ...adapter.dynamicAgentTools,
        discover(connection, signal) {
          registerConnectionObservation(connection, connectorType, observer);
          return observeAsync(
            observer,
            connectorType,
            "dynamic_tools_discover",
            connectionFields(connection),
            () => adapter.dynamicAgentTools!.discover(connection, signal),
            (tools) => ({ tool_count: tools.length }),
          );
        },
      },
    } : {}),
    ...(adapter.nativeAgent ? {
      nativeAgent: instrumentAgent(connectorType, "native_agent", adapter.nativeAgent, observer),
    } : {}),
    ...(adapter.messagingAgent ? {
      messagingAgent: instrumentAgent(connectorType, "messaging_agent", adapter.messagingAgent, observer),
    } : {}),
    ...(adapter.beginAuthorization ? {
      beginAuthorization(input) {
        return observeAsync(observer, connectorType, "authorization_begin", {}, () => (
          adapter.beginAuthorization!(input)
        ));
      },
    } : {}),
    ...(adapter.handleAuthorizationCallback ? {
      handleAuthorizationCallback(input) {
        return observeAsync(observer, connectorType, "authorization_callback", {}, () => (
          adapter.handleAuthorizationCallback!(input)
        ));
      },
    } : {}),
    ...(adapter.refreshCredentials ? {
      refreshCredentials(connection, signal) {
        registerConnectionObservation(connection, connectorType, observer);
        return observeAsync(
          observer,
          connectorType,
          "credentials_refresh",
          connectionFields(connection),
          () => adapter.refreshCredentials!(connection, signal),
        );
      },
    } : {}),
    ...(adapter.revoke ? {
      revoke(connection, signal) {
        registerConnectionObservation(connection, connectorType, observer);
        return observeAsync(
          observer,
          connectorType,
          "authorization_revoke",
          connectionFields(connection),
          () => adapter.revoke!(connection, signal),
        );
      },
    } : {}),
    ...(adapter.webhookActivity ? {
      webhookActivity: instrumentWebhook(connectorType, adapter.webhookActivity, observer),
    } : {}),
    ...(adapter.pollingActivity ? {
      pollingActivity: instrumentPolling(connectorType, adapter.pollingActivity, observer),
    } : {}),
    ...(adapter.poll ? {
      poll(connection, signal) {
        registerConnectionObservation(connection, connectorType, observer);
        return observeAsync(
          observer,
          connectorType,
          "poll",
          connectionFields(connection),
          () => adapter.poll!(connection, signal),
          (result) => ({
            activity_count: result.activities.length,
            stream_error_count: result.streamErrors?.length ?? 0,
            // A poll whose every stream failed logs as `succeeded` with a
            // count. The codes are the adapter's own or a schema rejection's
            // paths — never the messages, which can carry provider text and
            // already reach the connection row.
            ...(result.streamErrors?.length
              ? { stream_error_codes: [...new Set(result.streamErrors.map((entry) => entry.code))] }
              : {}),
            provider_resource_ids: activityResourceIds(result.activities),
          }),
        );
      },
    } : {}),
    ...(adapter.hydrateResource ? {
      hydrateResource(connection, resource, signal) {
        registerConnectionObservation(connection, connectorType, observer);
        return observeAsync(
          observer,
          connectorType,
          "resource_hydrate",
          connectionFields(connection),
          () => adapter.hydrateResource!(connection, resource, signal),
        );
      },
    } : {}),
    ...(adapter.probeResourceAccess ? {
      probeResourceAccess(connection, reference, signal) {
        registerConnectionObservation(connection, connectorType, observer);
        return observeAsync(
          observer,
          connectorType,
          "resource_access_probe",
          connectionFields(connection),
          () => adapter.probeResourceAccess!(connection, reference, signal),
        );
      },
    } : {}),
    ...(adapter.validateToolInput ? {
      validateToolInput(name, args) {
        return observeSync(
          observer,
          connectorType,
          "tool_input_validate",
          { tool_name: name, ...providerIdentifierFields(connectorType, args) },
          () => adapter.validateToolInput!(name, args),
          // A returned `ZodError` had its paths in hand and logged the word
          // `invalid`; the same rejection thrown would have been named. Paths
          // and issue codes are the tool's schema, not the model's values.
          (error) => ({
            outcome: error === null ? "valid" : "invalid",
            ...(error === null ? {} : { code: zodDiagnosticCode(error, "tool_input") }),
          }),
        );
      },
    } : {}),
    executeTool(name, args, context) {
      registerConnectionObservation(context.connection, connectorType, observer);
      return observeAsync(
        observer,
        connectorType,
        "tool_execute",
        {
          ...connectionFields(context.connection),
          tool_name: name,
          principal_type: context.principal.type,
          ...providerIdentifierFields(connectorType, args),
        },
        () => adapter.executeTool(name, args, context),
        (result) => ({ provider_operation_id: result.providerOperationId ?? null }),
      );
    },
    ...(adapter.repair ? {
      repair(connection, signal) {
        registerConnectionObservation(connection, connectorType, observer);
        return observeAsync(
          observer,
          connectorType,
          "connection_repair",
          connectionFields(connection),
          () => adapter.repair!(connection, signal),
          (result) => ({ repaired: result.repaired }),
        );
      },
    } : {}),
    healthCheck(connection, signal) {
      registerConnectionObservation(connection, connectorType, observer);
      const fields = connectionFields(connection);
      const startedAt = Date.now();
      observeConnector(observer, "debug", "connector_operation_started", {
        connector_type: connectorType,
        operation: "health_check",
        ...fields,
      });
      return Promise.resolve().then(() => adapter.healthCheck(connection, signal)).then((result) => {
        observeConnector(
          observer,
          result.ok && !result.warning ? "info" : "warn",
          "connector_operation_finished",
          {
            connector_type: connectorType,
            operation: "health_check",
            outcome: result.ok ? (result.warning ? "degraded" : "healthy") : "unhealthy",
            reconnect_required: result.reconnectRequired ?? false,
            warning_present: Boolean(result.warning),
            // An adapter that *returns* `ok: false` had its reason in hand and
            // dropped it here, while one that *throws* got a `code` logged four
            // lines down. Granola returns, so "Granola webhook endpoint identity
            // is missing" — the entire diagnosis, already computed — reached the
            // log as the word `unhealthy` and nothing else.
            //
            // `message` is deliberately not what is logged. It is written for a
            // person and an adapter may fill it from a caught provider error:
            // `x.ts` returns the provider body's own `message` field verbatim.
            // `redact` keys on field names, so nothing would catch that. Only
            // `reasonCode`, which an adapter writes as a literal, crosses here.
            // A degraded result carries one for the same reason: its `warning`
            // is prose too.
            ...(result.reasonCode === undefined ? {} : { reason_code: result.reasonCode }),
            duration_ms: Date.now() - startedAt,
            ...fields,
          },
        );
        return result;
      }).catch((error: unknown) => {
        observeConnector(observer, connectorObservationFailureLevel(error), "connector_operation_finished", {
          connector_type: connectorType,
          operation: "health_check",
          outcome: "failed",
          code: connectorObservationErrorCode(error),
          duration_ms: Date.now() - startedAt,
          ...fields,
        });
        throw error;
      });
    },
  };
}

function providerRequestDescriptor(input: string | URL | Request, init?: RequestInit): {
  provider_origin: string;
  method: string;
} {
  const rawUrl = input instanceof Request ? input.url : String(input);
  let providerOrigin = "unavailable";
  try {
    providerOrigin = new URL(rawUrl).origin;
  } catch {
    // A malformed URL remains observable without copying its content.
  }
  return {
    provider_origin: providerOrigin,
    method: (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase(),
  };
}

/** Adds a second, provider-transport layer of logs without consuming the response body. */
export function instrumentConnectorFetch(
  connectorType: string,
  fetcher: FetchLike,
  observer: ConnectorObserver | undefined,
): FetchLike {
  return async (input, init) => {
    let descriptor = { provider_origin: "unavailable", method: "UNKNOWN" };
    try {
      descriptor = providerRequestDescriptor(input, init);
    } catch {
      // The fetcher remains authoritative over whether an unusual input works.
    }
    const fields = {
      connector_type: connectorType,
      ...descriptor,
    };
    const startedAt = Date.now();
    observeConnector(observer, "debug", "connector_provider_request_started", fields);
    try {
      const response = await fetcher(input, init);
      const level: ConnectorLogLevel = response.status >= 500
        ? "error"
        : response.ok
          ? "info"
          : "warn";
      observeConnector(observer, level, "connector_provider_request_finished", {
        ...fields,
        outcome: response.ok ? "succeeded" : "provider_rejected",
        status: response.status,
        duration_ms: Date.now() - startedAt,
      });
      return response;
    } catch (error) {
      observeConnector(observer, "error", "connector_provider_request_finished", {
        ...fields,
        outcome: "failed",
        code: connectorObservationErrorCode(error),
        duration_ms: Date.now() - startedAt,
      });
      throw error;
    }
  };
}
