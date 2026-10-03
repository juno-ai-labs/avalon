# Full browser client: build plan

Phases for [the PRD](prd.md). Each phase lands as its own pull request and is
done only when its acceptance gate holds.

## Phase 1: member shell

- [x] The cookie adapter forwards the member route families (`spaces`,
      `projects`, `onboarding`, `work-opportunities`, `digest`,
      `push-devices`, `workspaces`) and still refuses `auth`, `internal`,
      `ingest`, `access`, `slack`, `sideline` and `dev`.
- [x] A member's workspace in the browser mounts the desktop shell: sidebar
      from the workspace socket provider, Spaces, Channels, Breakouts and the
      details rail. Guests keep the guest shell.
- [x] Settings opens as a route; OS-level sections read "Available in the Mac
      app". Sidekicks open in a named tab.
- [x] The shell reads `multiple-workspaces-enabled` and
      `live-artifacts-enabled` as the Mac app does.

**Gate:** a member signed in by email sees a Channel reached only through
General, in a real browser window, and a guest still sees the guest shell.

## Phase 2: Google sign-in

- [ ] `/browser/google/start` and `/browser/google/callback`, with the callback
      on the app host, set the browser cookie.
- [ ] **Continue with Google** on the entry.
- [ ] Google redirect URI registered (provider configuration).

**Gate:** Google and email sign-in with one address reach one identity.

## Phase 3: connectors

- [ ] Browser return target for connector OAuth, accepted only under
      `BROWSER_APP_ORIGIN`.
- [ ] Browser `ConnectorSetupCapability`: popup, polling, completion page.
- [ ] `browser-connectable-capabilities` flag registered in Ace; other
      connectors disabled with "Download the Mac app to connect this."

**Gate:** Gmail and Drive connect from the browser in both scopes.

## Phase 4: realtime parity

- [ ] Each tab opens the desktop feed set over native sockets.
- [ ] Presence published from page visibility and focus.

**Gate:** another member sees the browser member as present; switching to a
warmed pinned Channel shows no loading state.

## Phase 5: Web Push

- [ ] Web device type and VAPID provider on the server.
- [ ] `/sw.js` served from the app root; `worker-src 'self'`.
- [ ] **Turn on notifications** in the account menu.

**Gate:** a push arrives with the tab closed and opens the conversation.

## Phase 6: inline artifact preview

- [ ] Artifact `frame-ancestors` names `BROWSER_APP_ORIGIN`; `X-Frame-Options`
      dropped.
- [ ] Partitioned framed viewer cookie; public fallback.
- [ ] Shell `frame-src`; sandbox `allow-same-origin allow-scripts allow-forms`.
- [ ] `live-web-artifacts.md` records the exception.

**Gate:** a live artifact previews inline in the rail.

## Phase 7: regions

- [ ] `design.md` for the Global-to-regional cookie handoff.
- [ ] Per-region service bindings in the browser Worker.
- [ ] Global discovery and activation routes; server-to-server registration.

**Gate:** proven in local multi-region development; production proof waits
for a second deployment.
