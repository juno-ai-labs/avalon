# Cloud browser

> Created 2026-09-05.
>
> A participant gives Rally a private cloud browser, signs into websites through
> a live view, and lets an authorized work-stream task continue without their
> computer. Companions: [browser design and tool contract](design.md),
> [state](state.md).
> Standing contract: [the Rally implementation brief](../2026-08-05_avalon-implementation-brief/prd.md).
> Read alongside [agent tools](../../agent-tools.md),
> [Terminal workspaces](../../terminal-workspaces.md),
> [security](../../security.md), and [regionalization](../../regionalization.md).

## Summary

A participant can ask Rally to work on a website that requires a browser or a
personal login. Rally opens a cloud browser in the work stream's contextual
right rail. The participant can sign in directly, watch progress, take control,
and return control to Rally. Once authorized, the task continues if the
participant closes Rally or their laptop. A later task can reuse the same
browser profile while the website's session remains valid.

The first release uses Chromium and Playwright in a dedicated private Daytona
sandbox. Browser is a loadable plugin in the existing work-stream agent, with
personal authority and a lifetime independent of Terminal. The feature provides
general website interaction; it does not promise that a website permits
automation or that a particular login will work from a cloud environment.

## Motivation

On 2026-09-05, the requesting product owner reported asking Rally to access
LinkedIn and research their connections. Rally could not complete the request
with its Daytona Terminal alone. In this repository task, the owner then asked
how a cloud browser would work and requested this PRD. This is one reported
case; there is no measured frequency or demonstrated customer cohort behind it.

The code corroborates the capability gap, rather than the exact cause of that
production run: [Terminal's tool contract](../../../apps/api/src/services/terminal/contract.ts)
exposes file, command, resource, and repository operations, but no browser
observation, personal browser profile, or interactive login handoff. The
[agent harness](../../agent-harness.md) also has public-web tools; those do not
carry a participant's signed-in browser session. Installing a browser from a
command does not supply the missing account authority or product experience.

Leaving the gap requires the participant to retrieve private website material
manually before Rally can help. It also prevents ongoing browser work from
surviving closure of the participant's computer. A cloud browser addresses the
general gap. LinkedIn itself remains subject to its
[automation policy](https://www.linkedin.com/help/linkedin/answer/a1341387) and
[restricted Connections API](https://learn.microsoft.com/en-us/linkedin/shared/integrations/people/connections-api).
Its supported [connections export](https://www.linkedin.com/help/linkedin/answer/a566336)
is an alternative input for that original research request. It is not the
acceptance fixture for this feature.

## Goals

1. A participant completes a browser-dependent task, including on a website
   requiring login, without copying credentials into a message or Terminal.
2. The participant sees and controls the same browser Rally operates, with an
   explicit, reliable transfer of control in either direction.
3. Authorized browser work continues while the desktop is disconnected, and
   pauses durably when the account owner must act.
4. Later work can reuse the owner's website sessions without sharing the
   profile with another person, workspace, or Terminal sandbox.
5. Browser outcomes, failures, and uncertain actions are visible in the work
   stream; recovery never blindly repeats an action that might have succeeded.
6. The configured medium fallback model can discover the plugin, inspect a
   page, complete a multi-tool task, and recover from stale page controls.

## Non-goals

1. **Controlling local Chrome or importing its cookies — deferred.** This
   release owns a cloud profile; a browser extension is a separate capability.
2. **A shared team browser identity or multiple named profiles — deferred.**
   The initial product has one personal profile per member per workspace.
   Sharing a work stream never shares another participant's account access.
3. **Scheduled or connector-triggered browser automations — deferred.** An
   ordinary admitted work-stream task can continue unattended. Persistently
   binding a personal browser to an automation subscription is separate work.
   Automation architects, workspace-principal runs, and inbound-email runs do
   not acquire Browser in this release.
4. **An unrestricted remote desktop, shell, or script executor — rejected for
   this surface.** The browser controller exposes browser operations, not
   operating-system input, arbitrary JavaScript, CDP, or provider APIs.
5. **Guaranteed access to every website — rejected.** No CAPTCHA bypass,
   anti-detection service, account rotation, or evasion of a site's controls.
   A challenge or unsupported site produces an honest stop or human handoff.
6. **File upload, download export, and browser extensions — deferred.** The
   first release produces findings through existing work-stream resources and
   responses. Automatic downloads are refused visibly; browser profiles are
   never exportable artifacts. This keeps the first tool contract focused.
7. **A second browser provider or provider-selection framework — deferred.**
   Browserbase is a considered alternative, not a parallel implementation.
8. **General “read-only browser” enforcement — rejected as a promise.** A click,
   key, or navigation can write to a website. Research intent constrains what
   Rally should do; it is not a technical guarantee that arbitrary websites
   cannot mutate state.

## Product behavior

### Entry and account ownership

The plugin is called **Browser**. It is discoverable in an eligible ordinary
work-stream run and grouped under **Computer** in transcript activity, following
[plugin activity rows](../../plugin-activity-rows.md). Loading it exposes its
tools and guidance without creating compute, connecting an account, or changing
permissions. The account is always the initiating participant's personal
browser in the selected workspace. The model cannot choose another owner.

The first `browser_open` request without a connected profile produces an
owner-addressed **Connect browser** card and suspends the task. No sandbox is
allocated until the owner chooses **Connect and continue**. The card explains:

> Rally uses a private browser in the cloud. Website sessions stay in that
> browser. Pages Rally reads are sent to its model, and findings it posts are
> visible to people who can read this work stream. You can take control or
> disconnect the browser at any time.

This connection grant permits ordinary browser use for tasks initiated by this
owner in this workspace. The current task remains the authority for what to do;
the grant is not permission to explore unrelated accounts. An existing grant
does not produce another connection confirmation for every task or click.

The new **Browser** entry in workspace settings shows the current member's
personal connection, its availability, **Open browser**, and **Disconnect and
delete browser data**. Other members and administrators do not get a live view
or profile access through their workspace roles. An administrator can disable
the capability through workspace policy without becoming the profile's owner.

### Live view and control

The contextual right rail hosts a browser preview with a title, current site,
connection status, **Open larger**, **Take control**, and **Stop task**. A larger
isolated window provides enough space to sign in and operate ordinary websites;
the narrow rail is not the only way to use a desktop-sized page. The view shows
the same cloud session and tab that the agent controls. Switching the displayed
tab alone does not submit a browser action.

Watching is noninteractive. **Take control** first fences new agent actions,
settles or marks the current action uncertain, and only then enables user input.
The view shows **You have control** and **Continue with Rally**. Agent page
reads, screenshots, and input are blocked during this period. A second viewer
can watch only if it belongs to the same owner; it cannot also acquire control.
The handoff protocol enforces this server-side and at the browser controller.

The owner can sign in, complete a verification step, or repair the page directly.
Passwords and verification codes are not elicited through the composer or typed
by the model. Human input is excluded from inference capture, tool arguments,
session recordings, telemetry, and screenshots sent to the model. This does not
claim that the website or cloud browser provider cannot receive the login.

**Continue with Rally** relinquishes human input, invalidates prior element and
screenshot references, and resumes the same suspended task with a fresh page
inspection. It never resubmits a form merely to recreate the page the agent
previously saw. Signing in does not grant permission to send messages, buy,
publish, or make other changes unrelated to the task.

### Login and other interruptions

When login or verification is required, the transcript shows **Sign in to
continue** or **Complete verification to continue**, addressed to the browser
owner. The work stream enters its existing `needs_input` state. The owner opens
the live view and continues as above. The model receives an explicit suspended
result and does not poll for completion.

The model can request a handoff for an interaction its tools cannot complete.
The owner can choose **Continue with Rally** or **Cancel browser task**. Declining
the connection or cancelling a handoff stops browser work without fabricating
research. It does not disconnect an already connected profile unless the owner
chooses the settings action.

An occupied profile presents **Open current task**, when visible, and **Try
again**. The owner can stop the earlier task through its existing controls or
wait for it to finish, then choose Try again to resume the suspended open. A
failed reacquisition keeps the same card. There is no automatic task queue,
silent takeover, or repeated model call while the profile is occupied.

Human control must not become a path to a terminal, browser
DevTools, arbitrary URL schemes, downloads, or another profile. The delivered
viewer presents browser content and host-owned navigation controls through the
controller's frame/input relay. Daytona's virtual display is an internal runtime
component; its raw VNC desktop is not exposed to participants.

### Empty, loading, active, error, and offline states

| State | What the participant sees | What Rally does |
| --- | --- | --- |
| No connection | Connect browser card; no empty live canvas | Suspends before provider allocation. |
| Starting or restoring | Starting browser with Cancel | Tracks the existing start operation durably; does not create another sandbox after a lost response. |
| Working | Live page and Browser activity | Operates within task, principal, network, and control authority. |
| Owner action needed | Named handoff and Open browser | Suspends without model polling. |
| Human control | You have control; Continue with Rally | Blocks observation and agent input. |
| Browser occupied by another task | Browser is in use; link only if that work stream is visible | Requests owner action; never borrows its tab or starts a hidden parallel profile. |
| Website refuses access | Site-specific explanation and available manual alternative | Stops or hands off; does not change identity or route around the refusal. |
| Provider or controller unavailable | Browser unavailable; retained task and connection state | Reconciles an accepted action before another input is admitted. |
| Desktop offline | Last frame marked Disconnected, with last-update time | Cloud work continues if it owns control. The frame is not presented as live. |
| Owner disconnects during human control | Task remains waiting for owner | Does not infer permission to resume. Stops unused compute, preserving profile state where possible. |
| Finished, cancelled, or stopped | Final findings or concrete stopped reason | Closes task tabs and stops compute after action settlement. Retains the connected profile. |
| Disconnect/delete in progress | Browser access revoked; deleting data | Denies access immediately and confirms deletion only after provider acknowledgement. |

### Reuse, results, and collaboration

A fresh task uses a fresh set of tabs within the retained personal profile. It
does not inherit another task's open pages or unsubmitted forms. Cookies and
other browser storage may preserve login; the UI never promises permanent login.
Browser compute is released when neither an active task nor a connected human
controller needs it. There is no invented idle timer in this proposal.

Research responses cite the website URLs actually observed and distinguish
observed pages from estimates or unavailable material. The normal resource tools
can save an authored report. Raw observations and screenshots are private agent
evidence, not automatically shared resources or activity previews. Findings the
owner asks Rally to post are ordinary work-stream content. A later run initiated
by another participant does not inherit personal browser evidence from receipts
or a compaction checkpoint.

Another participant can steer or stop shared work under existing work-stream
rules, but cannot answer an owner-only login handoff or gain browser authority.
Changing the execution principal requires release and new admission. Removing
membership, abandoning the workspace, withdrawing the connection, or disabling
the feature fences active browser access and schedules cleanup.

### Authorized actions and uncertainty

Browser tasks follow the standing rule for ordinary authorized external writes:
there is no global approval gate. The task must authorize the action and supply
grounded targets. A request to research connections does not authorize sending
invitations or messages. Existing connector tools remain preferable when they
provide the required operation and a narrower permission boundary.

Websites generally do not accept Rally's idempotency keys. The controller avoids
redispatching the same accepted input, and Rally persists completed results, but
neither promises exactly-once website effects. A crash between input delivery
and durable completion becomes an uncertain action. Recovery inspects the
website when safe or asks the owner to reconcile; it never blindly repeats the
input. A message about completion is supported by observed site state, not by
the absence of an automation exception.

## Impact on the product contract

This extends the brief's typed-tools clause with a user-visible cloud browser
and human handoff. It preserves the work stream as the home for the task,
personal-connection ownership, viewing without participation, and the absence
of a global approval gate. It introduces no global inbox or browser history
search and no user-authored background service runtime.

The implementing change updates the brief's typed-tools clause to explicitly
permit an isolated personal cloud browser with typed operations and a live
handoff. Its prohibition on a user-visible terminal, host shell, PTY, and
user-authored runtime remains. It also clarifies the existing “every attempt is
idempotent” wording for providers without idempotency support: completed attempts
replay their saved outcomes, and uncertain attempts are reconciled rather than
repeated. This PRD does not silently claim exactly-once effects on arbitrary
websites or amend the standing brief ahead of implementation.

## Decision log

None yet.

## Key design decisions

1. **Daytona is the first provider.** Rally already operates it, so a dedicated
   browser environment reuses that operational relationship. Browserbase has
   [persistent contexts](https://docs.browserbase.com/platform/browser/core-features/contexts)
   and an [interactive live view](https://docs.browserbase.com/platform/browser/observability/session-live-view),
   and remains a viable alternative if the provider acceptance fails. Building
   both providers or a general provider framework now adds no user outcome.
2. **Browser is separate from Terminal.** Personal login state outlives a work
   stream, while Terminal can execute arbitrary commands and replace its
   sandbox for repository work. Reusing that filesystem would expose credentials
   and couple login survival to unrelated Terminal lifecycle decisions.
3. **The existing Rally agent drives typed browser operations.** Playwright
   runs in the browser environment and exposes a small controller to the host.
   A second autonomous browser agent would duplicate planning and complicate
   cancellation and evidence without a demonstrated need.
4. **One controller owns the profile at a time.** This is a correctness rule
   for one mutable browser profile, not an invented capacity ceiling. Another
   work stream receives a visible occupied state. A browser task queue and
   concurrent profile cloning are deferred.
5. **Login is a private human handoff.** Copying passwords or cookies through
   Terminal, chat, or model tools is rejected. The profile remains cloud-held
   credential material; the UI explains that fact.
6. **Use existing lifecycle and receipt mechanisms.** Regional object storage,
   action intents, alarms, and owner-only resumptions carry progress. A second
   workflow engine, model polling loop, and guessed timeout policy are rejected.

## Data model

The [design](design.md#authority-and-storage) sketches new WorkspaceDO-owned
`browser_profiles`, `browser_sessions`, and `browser_handoffs` records, keyed to
regional member and workspace authority. The owning SubstreamAgent retains
tool effects and private observation references under its existing ledger.
Provider profile bytes stay in the browser environment; they are not connector
configuration JSON or normal R2 resources. No existing personal or workspace
connection is automatically enrolled and no Terminal state is backfilled.

The implementation adds `docs/cloud-browser.md` with its running changelog and
registers that durable module document in the documentation index. It updates
the owning architecture, data model, harness, security, regionalization,
feature-flag, plugin-activity, and operational documents with the code. The PRD
itself is not registered in the index.

## Regional impact

Profile metadata, receipts, handoffs, page evidence, and cleanup ownership stay
with the workspace's regional API and Durable Objects. Neither profile selection
nor a user-supplied URL chooses the Rally region. Global inference capture and
EU non-export continue to follow the existing regional policies.

The current [Terminal subprocessor exception](../../regionalization.md#2026-08-30--eu-terminal-uses-the-same-daytona-environment-as-global)
runs both Global and EU Terminal compute on Daytona's US fleet. It is not proof
that personal browser credentials may receive the same treatment. The initial
proposal enables provider acceptance in Global and keeps Browser unavailable
for EU until the team explicitly approves a browser-specific US-subprocessor
exception or provisions and verifies suitable EU compute and persistence.
No implementation guesses `DAYTONA_TARGET=eu` or falls back from EU to Global.

That decision covers browser cookies, storage, screenshots, provider diagnostics,
backups, and deletion, as well as running compute. Geography of websites visited
is distinct from where Rally and its browser subprocessor retain product data.

## Security and trust model

The new trust boundary is personal cloud-held website authority. Current owner,
workspace membership, run scope, profile generation, and control ownership are
verified on every browser operation and live-view admission. A profile ID is a
reference, never a credential. Revocation closes existing control transports;
checking only when a viewer first connects is insufficient.

Website scripts, page text, accessible names, screenshots, and redirects remain
untrusted content. They cannot request new Rally permissions, override the task,
or turn a cited link into an authorized data destination. The model receives no
cookies, request headers, stored passwords, arbitrary evaluation endpoint,
provider token, shell, or reusable live-view URL. Secret-field input requires
human control. No authenticated page is placed in the product renderer's origin
or given Rally's preload bridge.

Workspace network policy applies to Browser. The browser image has a reviewed
bootstrap baseline of its own; it does not inherit Terminal's package-registry
exceptions. Redirects, subresources, sockets, and human navigation remain subject
to provider egress enforcement, and private/control-plane addresses are blocked.
The model cannot loosen policy after a website fails to load. The
[design](design.md#network-and-viewer-boundaries) specifies what is enforced
outside the model and the provider acceptance that must prove it.

Content-free telemetry records lifecycle, action category, timing, and failure
codes. Page text, full URLs, credentials, frames, and user keystrokes do not go
to telemetry or recordings. Agent observations can be captured by the existing
Global raw-inference pipeline when supplied to a model; the connection disclosure
and retention documentation must say so. Human-control frames never enter that
pipeline. Deleting a profile revokes browser access and removes provider-held
browser data; it does not pretend to erase reports already shared in a work
stream or inference retained under its separate policy.

## Agent behavior

The built-in deferred plugin ID is `rally:browser`, its wire prefix is
`browser`, and its display name is Browser. Its complete ordered tool catalog,
exact prompt, inputs, successful outputs, failure sentences, and lifecycle
semantics are in [the tool contract](design.md#plugin-contract). That companion
is normative, not an illustrative implementation sketch.

The plugin is registered only for eligible owner-principal ordinary work-stream
runs. Loading is allocation-free. `browser_open` acquires or requests the
personal connection; `browser_list_tabs` and `browser_inspect` supply all tab,
element, screenshot, and continuation prerequisites. Observation and input are
serialized with the control owner. No tool grants the model a shell or another
person's session. Login and unsupported interactions use
`browser_request_handoff`, which suspends the existing loop.

Browser is absent from automation and read-only inbound-email execution in this
release. Child agents cannot independently acquire it; browser work stays with
the owning main substream so delegation cannot compete for the same profile.
Public research still uses the existing Web plugin when it satisfies the task.

## Provider configuration

Each enabled regional deployment requires a Browser capability setting, Daytona
credential with the necessary sandbox/preview permissions, explicit provider
target, and a verified browser image containing Chromium, Playwright, and the
required display packages. The image is built without personal profile data.
Provider credentials remain Worker secrets. The browser sandbox has no R2,
Cloudflare administration, Terminal, or GitHub connector credential.

Production acceptance verifies authenticated controller/viewer access,
revocation of existing connections, egress policy, Chromium sandboxing, browser
profile persistence, and provider data deletion. It also verifies that recording
and content-bearing provider diagnostics are disabled or meet the declared data
policy. Merely reaching Daytona's dashboard is not acceptance of Rally's viewer.
Missing or rejected configuration makes the capability unavailable with a
concrete reason; it does not silently allocate in another target.

## Rollout

The product owner was asked on 2026-09-05 whether this feature ships behind a
flag, as required by [PRD conventions](../../prds.md#optional-sections). The
answer is pending; the recommendation is a default-off `cloud-browser-enabled`
flag with explicit audience targeting. This is not recorded as an approved
rollout decision. Resolve the question before implementation rollout is agreed.

If confirmed, registration includes `ProductFeatureFlagKeySchema`, the resolver
in `client-feature-flags.ts`, `MANAGED_FLAGS` in `apps/ace/src/protocol.ts`, and
the matching `ensureFlag` provisioning in `apps/ace/scripts/deploy.mjs`, all with
the same description and default `false`. Staff are enabled by a targeting rule,
not a hard-coded exception. The server checks eligibility as well as the client.
If the owner chooses no flag, this section instead records that decision and its
rationale; provider and authorization gates still apply.

Rollout acceptance begins with a controlled signed-in fixture: connect, log in,
hand off, inspect, stop/restart, reuse valid login, and complete while the desktop
is closed. Then exercise revocation, uncertain input, human takeover, and
cross-principal isolation before any wider audience. This is an acceptance
sequence, not an implementation `plan.md`; that file belongs to a later change.

Disabling the capability blocks new starts and input, fences active sessions,
settles in-flight actions, closes viewers, and stops compute. It retains profile
data under its stated lifecycle rather than treating rollback as silent deletion.
The owner retains a disconnect/delete path while the feature is disabled.

## Acceptance

1. An eligible owner discovers Browser and loads its catalog without allocation.
   A first open presents the connection disclosure; decline creates no sandbox.
2. A real window shows connection, starting, live, takeover, handoff, disconnected,
   failure, and deleted states at rail and larger-window sizes. The page is
   visible and usable, including login and verification controls.
3. The owner signs into a controlled test site without putting credentials in
   chat, model inputs, logs, recordings, or shared resources. Returning control
   resumes the same task and supplies fresh observation references.
4. A valid site session survives a graceful sandbox stop/start. An expired
   session produces a handoff. A corrupt profile is reported before replacement;
   Rally never labels a fresh profile as the retained login.
5. Browser work finishes with the desktop closed. A login needed while it is
   closed waits without polling or inventing an answer and resumes on return.
6. A second task cannot operate the occupied profile. Another participant,
   workspace, child agent, or automation cannot acquire it, view it, or replay
   its private evidence. Deliberately shared final findings remain readable.
7. Takeover and revocation race an in-flight action. No new action crosses the
   control fence; an already-dispatched uncertain action is not replayed.
   Response loss after a successful click does not submit it again.
8. Private-address navigation, redirects, subresources, popups, non-web schemes,
   DevTools, shell access, and raw controller/preview access fail at their stated
   boundaries. Tests distinguish network enforcement from model guidance.
9. Page mutation invalidates stale controls and screenshot coordinates. The
   medium fallback model reinspects, handles continuation, completes a multi-tool
   sequence, and stops for handoff or policy failures without loops.
10. Session/profile deletion and membership loss revoke current access, stop
    compute, and reconcile provider deletion. An old viewer or operation token
    cannot act on a replacement generation.
11. The catalog and all strict wire shapes have schema/contract tests. Real
    workerd tests prove owner, admission, suspension/resume, receipts, alarms,
    and revocation; real Chromium tests prove page and controller behavior;
    real Daytona acceptance proves the provider-dependent guarantees.
12. Integration tests receive the break-production-behavior check required by
    [testing](../../testing.md#prove-the-test-can-fail). The implementing change
    passes lint, typecheck, affected tests, provider builds, and visible-window
    QA; it publishes the durable subsystem documentation with its changelog.

## Open questions

1. **Rollout decision — blocks rollout approval.** Does the owner choose the
   recommended default-off flag? The question has been sent; no answer is assumed.
2. **EU browser residency — blocks EU enablement only.** Approve a named
   browser subprocessor exception or provision a verified regional environment.
3. **Retention and operational bounds — blocks production enablement where a
   finite value is required.** The design names justified open settings and the
   arithmetic needed to choose them. This PRD does not assign arbitrary session,
   profile-retention, observation-size, or access-ticket numbers.
4. **Confined live view and egress acceptance — blocks provider enablement.**
   Prove that the proposed Daytona deployment supports revocable owner control,
   a browser-only viewer, and the required network boundary. If not, return with
   the concrete deficiency and reconsider Browserbase or a confined rendering
   path; do not silently weaken the product contract.
