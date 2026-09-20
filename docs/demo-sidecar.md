# Demo messaging sidecar

The Demo sidecar is a separate window inside Rally. It uses the existing operator
session, stays bound to its launching demo Organization, and sends participant
messages over HTTP. [Impersonation](impersonation.md) owns server authority.

## Where the code lives

| File | Responsibility |
| --- | --- |
| `apps/desktop/src/main/demo-sidecar-controller.ts` | Bound windows and account/navigation lifecycle. |
| `apps/desktop/src/main/index.ts` | Credential selection, HTTP adapter, window creation, narrow IPC ownership. |
| `apps/desktop/src/preload/demo-sidecar.ts` | Catalog/send and theme notifications only. |
| `apps/desktop/src/common/demo-cards.ts` | Immutable attempts and retry keys. |
| `apps/desktop/src/renderer/screens/demo-sidecar.tsx` | Catalog and message-card host. |
| `packages/ui/src/components/message-card-stack.tsx` | Shared accessible presentation. |

## How it works

The account menu checks canonical HTTP eligibility for the active identity and
Organization. Opening revalidates that binding; it cannot launch against an ID
supplied for some other Organization. The main process selects only the stored
credential matching the window's original user, Organization, and region. Refresh
uses the same credential and cannot fall back to the active Organization.

Each operator/demo has one window. A second launch focuses it. Another eligible
demo can have its own window. Account changes or sign-out close existing windows;
navigation to a regular Organization closes all sidecars. While a new destination's
eligibility is unresolved, sidecar IPC is unavailable. Normal deep-link routing
is unchanged. Closing discards in-memory cards but cannot undo an admitted send.

The separate renderer entry point mounts no Rally session or socket providers.
Catalog reads happen on launch and explicit refresh. A send awaits only the direct
HTTP response. The sidecar never polls or subscribes to downstream work.

A draft is editable. Submitting freezes its payload and key immediately, before
awaiting IPC. A confirmed send cannot resend. An unknown response may retry the
same immutable payload/key. A rejected attempt needs a new card. New cards retain
only currently valid selections, clear the text, and allocate a fresh key.

## Invariants

- Eligibility requires a verified company operator in the original cast of a
  published active demo, plus ordinary current authority. A regular Organization
  never qualifies, even with an impersonation relationship.
- A window never retargets when the main window navigates or refreshes credentials.
- The sidecar renderer receives no session or participant credentials.
- Submitted payloads never change, and uncertain retries preserve the key.
- The sidecar owns no sockets, transcripts, model controls, or background polling.

## Boundary

The sandboxed window has its own preload exposing only catalog, send, and theme
notification operations. It is excluded from the shared trusted IPC sender list.
Every request checks window ownership and the main frame; message arguments use
the strict contract. Navigation and new windows are denied. The renderer CSP
withholds remote API connections; HTTP is performed by main with configured
regional endpoints. Development's local Vite HMR is the only development socket.

## Failure modes and limits

Missing credentials or unavailable eligibility fails closed. Catalog denial locks
the composer; network failure offers explicit retry. A failed or lost send response
never implies cancellation: retrying an unknown result uses ordinary server
idempotency. No card, request, or timeout limit is introduced. Cards are memory-only.

## Testing

The card model and controller suites cover attempt immutability, duplicate clicks,
window reuse, separate demos, sign-out during launch, and non-demo navigation.
Renderer tests exercise the actual shared controls and host adapter. Server tests
run against migrated SQLite and real workerd; see [impersonation](impersonation.md).
The production Electron renderer/preload bundle is also inspected in a real window
with catalog/direct-response fixtures for loading, draft, sending, sent, failed,
unknown, denied, and offline states. These visual fixtures do not claim an end-to-end
provider or OAuth test.

## Changelog

### 2026-09-20 — Launch-bound HTTP messaging

**What changed:** Added the eligible menu action, isolated window, pinned session
adapter, shared cards, and direct-response retry behavior.

**Why:** A presenter needs repeated participant turns without coordinating other
signed-in clients or allowing represented sends in regular Organizations.

**Considered and rejected:** A separately installed app and OAuth callback would
duplicate existing authentication. Reusing the main renderer would inherit sockets
and broad IPC that this window does not need. Mutable retries could duplicate or
change a message after a lost response.

**Consequences:** Future sidecar capabilities must preserve the original binding and
narrow preload. Shared presentation remains independent of Electron and authority.
