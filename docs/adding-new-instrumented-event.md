# Adding a new instrumented event

Use this checklist for a new semantic product, reliability, or diagnostic event.
Telemetry is observational: it must never change whether the product operation
succeeds.

Read [`telemetry.md`](telemetry.md) first. The canonical registry is
`TELEMETRY_EVENTS` in `packages/contracts/src/telemetry.ts`; do not add a generic
`capture(name, properties)` call or send directly from the renderer.

## 1. Define the measurement

Before changing code, write down:

- the product or reliability question the event answers;
- the one authoritative producer: desktop renderer, desktop main, preload, or API;
- whether it is `essential`, `product`, or `diagnostic`;
- the allowed identity scopes: installation, anonymous epoch, platform user,
  workspace user, or personless workspace execution;
- the smallest closed property schema needed to answer the question;
- the classification of every property: operational, product, or diagnostic;
- priority, retention, sample rate, and destination.

Do not include prompts, messages, documents, request bodies, URLs, arbitrary
errors, tokens, account/user identity IDs, or other content. An opaque UUID for
the resource being measured—such as a conversation, message, note, automation,
run, or tool invocation—may be included when it is required for paths, joins, or
deduplication and is declared as a product property in the closed registry.
Never include a resource title, body, clipboard value, tool argument, tool
result, or provider account identifier beside it. Names and email addresses
belong in the approved profile flow, not ordinary event properties.

For a user action whose result is known by the server, use two events:
`*_requested` for client intent and `*_completed` for the authoritative API
outcome. Correlate them with one `operationId`; give each outcome its own durable,
event-specific event ID for idempotency.

## 2. Register the contract

Add one closed entry to `TELEMETRY_EVENTS`:

```ts
example_completed: event({
  ...common,
  name: "example_completed",
  definition: "The authoritative outcome of the example operation.",
  productQuestion: "What share of example attempts complete successfully?",
  sources: ["api"],
  authoritativeSource: "api",
  category: "product",
  identityScopes: ["workspace-user"],
  properties: z.object({ result: resultClass }).strict(),
  propertyClassifications: { result: "product" },
  priority: "normal",
  regionalRetention: "13-months",
}),
```

Every property must appear in both the Zod schema and
`propertyClassifications`. Reuse bounded enums or introduce a bounded enum near
the registry. Do not widen a shipped field to arbitrary strings. Incompatible
changes require a new schema version or a new event contract.

## 3. Add the typed producer

Choose the narrowest existing path:

- **Renderer intent or screen:** extend the typed DTO in
  `apps/desktop/src/common/desktop.ts`, the narrow renderer facade, the validated
  main IPC handler, and `TelemetryReporter`. The renderer never receives a
  provider token or a generic event API.

- **Desktop reliability:** add a typed `TelemetryReporter` method and call it
  from the main-owned lifecycle or observer that knows the result.

- **API outcome:** build the envelope with `apiTelemetryEnvelope`, then emit it
  with `emitAuthenticatedApiTelemetry` from the service or route that knows the
  committed outcome. Never send it back through the authenticated desktop event
  endpoint: that route rejects `source: api` so a modified client cannot forge
  authoritative outcomes.

- **Workspace-owned API execution:** use `emitWorkspaceApiTelemetry` through a
  narrow semantic helper. This scope is for background work with no responsible
  person, uses the stable workspace analytics ID as a personless distinct ID,
  and cannot enter through the authenticated desktop batch endpoint.

- **Diagnostic or crash:** use the sanitized exception/crash pipeline. PostHog
  exception events have additional fingerprint, frame, symbol, and artifact
  requirements; they are not ordinary product events.

SDK-style app, OS, device, display, viewport, session, and window fields belong
in the closed context-v2 envelope and are derived by main from trusted Electron
or installation state. Context v1 is frozen for old clients and replay; adding
another context field requires a new reader version deployed before its producer.
Do not ask the renderer to provide context, copy it into each event's semantic
property schema, or use a hostname as a device name. A desktop
batch carrying `context.deviceId` must send the same random installation ID in
the batch-level `installationId`; contract validation rejects mismatches before
regional persistence.

For agent-tool adoption, emit at the durable invocation admission boundary—not
when a menu or model schema merely exposes the tool. Allowlist only the canonical
tool name, plugin ID, capability, read/write mode, run kind, execution scope,
and opaque conversation/run/automation IDs. Arguments, outputs, summaries,
provider payloads, and error text are prohibited.

### PostHog destination compatibility

Keep the registry name provider-neutral. If PostHog has a reserved event for
the exact observation, translate it in
`apps/api/src/telemetry/posthog-adapter.ts`, retain the registry name in
`rally_event_name`, and test that one occurrence produces one destination
event. For example, a registered `screen_viewed` observation becomes `$screen`
with `$screen_name`; it is not also delivered under `screen_viewed`.

Do not choose a reserved name merely because a PostHog tool recognizes it. In
particular, do not manufacture `$pageview`, `$pageleave`, `$snapshot`, survey
responses, feature-flag exposures, logs, traces, or `$ai_*` records unless the
corresponding runtime actually observed the complete provider-defined action
and supplies its required properties. See the compatibility table in
[`telemetry.md`](telemetry.md#posthog-product-compatibility).
The public-site reporter is the approved `$pageview`/`$pageleave` producer;
Electron routes remain `$screen` even when their internal navigation resembles a
URL.

## 4. Test every boundary

Add focused tests for:

1. registry governance, exact properties, and rejected extra/prohibited fields;

2. the producer, including the event name, source, identity scope, and operation
   correlation;

3. regional acceptance, preference behavior, routing, and idempotency;

5. failure behavior proving telemetry cannot fail or retry the product action.

6. migration behavior proving a current occurrence does not emit both a legacy
   and replacement contract, or both a custom and reserved destination event.

When an API producer is observational, use `runtimeDeferral` from
`apps/api/src/lib/defer.ts` or an owning request deferral instead of awaiting the
analytics path or floating its promise. Worker deferral extends the invocation;
Durable Objects already stay active for pending asynchronous I/O. This is still
best effort until D1, R2, or Queue accepts a durable hand-off, so a deferral must
guard synchronous registration failure and observe rejection.

Run the focused telemetry suites documented in [`telemetry.md`](telemetry.md#testing),
then run:

```bash
pnpm lint
pnpm typecheck
pnpm test
```

- Update [`telemetry.md`](telemetry.md) when the event changes subsystem behavior
  or invariants, including its running changelog when required.

- Update dashboards, funnels, or alerts that should consume the event.

- Verify opt-out, retention, and prohibited-data behavior before shipping.


## 5. Finish the change
