# Guest sharing and browser collaboration

> Created 2026-09-16.
>
> Share conversations and workstreams with ordinary users through verified email
> entry and a lightweight browser collaboration client. Standing contract:
> [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> [Architecture](design.md) and [implementation evidence](implementation.md).

## Summary

A person may collaborate in several explicitly shared conversations and
workstreams across workspaces without joining each workspace as a full member.
They use the normal user identity and participant ledger, have full mutation
capabilities inside granted scopes, and can later become a full member without
changing identity or losing history.

## Motivation

External collaboration must not require workspace setup or installation. Existing
workspace-public and Main-participation assumptions cannot safely represent a
person invited only to a private child. Authorization needs exact scope grants
before browser login admits these users.

## Goals

- Share Main, individual children, or workstreams with multiple email recipients.
- Preserve ordinary identity, participation, attribution, mentions and history.
- Support email magic links and OTP, atomic invitation acceptance and resumable
  multi-workstream activation.
- Allow existing connector reads and writes within the shared execution context.
- Support promotion without another account, migration of authorship or loss of sessions.
- Share the application core between browser and Electron, using static HTML entry and
  persistent SPA navigation with direct, reused WebSockets.
- Make revocation durable and report committed versus applied state honestly.

## Non-goals

Full desktop parity in the browser, workspace setup, connector setup, onboarding,
and desktop settings are out of scope. The browser reuses shared conversation
surfaces, resources, participant controls and existing connector/Sidekick use.

New connector scopes, guest-specific identity stores, per-tool approval dialogs,
and a server WebSocket multiplexer are not part of this design. Deployment and a
pull request require a separate request.

## Product behavior

Guests see workspace name, icon and color when any conversation is shared with
them. Child-only access exposes a navigation container, never Main's transcript,
preview, summary or roster. Workstream sharing includes Main and current/future
inheriting children; restricted children require separate grants. Complete
sharing must accurately report any target the sharer cannot grant.

Conversation collaborators have the same mutation capabilities as members on
that scope, subject to existing ownership rules. Parent changes require parent
authority. Sharing is an explicit capability, not a consequence of reading.

Workstream Sidekick recommendations and owned Sidekicks are available subject to
source eligibility. Loaded attachments persist in their particular substream.
Using instructions grants neither source management nor authoring/run history.
Workstream-wide recommendation changes require parent authority. Existing
workspace connector execution preserves the initiating person's attribution.

## Impact on product contract

Workspace relationship gains an access class independent of administrative role.
WorkstreamDO becomes the Main and child grant owner; downstream admission is a
versioned projection. Resources, model context, search and bytes enforce the
same audience. Browser sessions use secure cookies; email credentials,
invitations, sessions and socket tickets have separate lifecycles.

## Decision log

- 2026-09-17: Preserve existing substream history and saved-context behavior when
  sharing. Add no context review, selection or fresh-substream option to sharing.
  Keep grants in the parent and retain coordination for actual participant
  additions; keep ordinary already-seated sends on the local path.

- 2026-09-17: User clarified the browser is a lite collaboration client with no
  setup or onboarding; complete this scope before opening the PR.

- 2026-09-16: User authorized implementation of the architecture report after
  rebasing onto main. Implementation proceeds under that explicit instruction.
- Guest means a workspace relationship, with upgrade preserving user identity.
- Reuse existing connectors; no new workstream connector binding model.
- New Sidekick architecture separates ownership, shared recommendation and
  persistent local loading. Browser invalidation reuses `automations` sync.
- Rollout flag choice and numeric email-challenge expiry/attempt/resend policy
  have been requested from the user. No numeric policy is invented here.
