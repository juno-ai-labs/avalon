# Design: the browser's Global-to-regional cookie handoff

Goal 9 of the [PRD](prd.md): a member whose workspace lives in any configured
deployment can use it from the browser. This is the bridge contract the PRD's
**Regional impact** section says must be written down before it is built.

## Constraints

- **Identity is Global.** Sign-in (email and Google), the platform identity and
  cross-region discovery live only on Global. `PlatformOnboardingService` refuses
  to run anywhere else.
- **Regional user ids differ.** A deployment links the platform identity to its
  own `users` row (`platform_user_id`), with its own id. A Global session and a
  regional session for the same person name different user ids.
- **A browser never holds a bearer.** The cookie is the only credential
  JavaScript may cause to be sent, and it is host-only on the browser host
  (`__Host-rally-browser-<region>`, one per deployment). The PRD's security
  model rules out a token in a URL, a response body or a fragment.
- **A cookie for a deployment can only be minted where its session row lives.**
  `BrowserSessionService` resolves a cookie against its own D1.

## Flow

```
browser ──/regional/global/browser/workspaces──▶ Global ── discover ──▶ every region
browser ──/regional/global/browser/workspace/activate {region, workspaceId}──▶ Global
   Global: discovery check → bridge(region).activateBrowser(identity, …)
   region: admit (as activate) → identity session → browser session → select
   region ──{ credential, expiresAt }──▶ Global (service-binding RPC)
   Global ──Set-Cookie: __Host-rally-browser-<region>──▶ browser (via the browser Worker)
browser ──/regional/<region>/browser/workspace/select──▶ region (its own cookie)
```

1. **List.** On Global, `GET /browser/workspaces` resolves the Global cookie and
   adds every other deployment's memberships to the local list, each with its
   `region`. Each deployment is asked on its own: one that fails is logged by
   name and code (`browser_workspace_discovery_failed`) and the rest still show.
   Nothing is reconciled; desktop's binding bookkeeping is not the browser's to
   change. Elsewhere the route lists the local deployment only.
2. **Activate.** `POST /browser/workspace/activate { region, workspaceId }` on
   Global asks the target deployment alone for discovery, so another
   deployment's outage cannot block it, and refuses a workspace the identity is
   not a member of, as desktop activation does. It then calls the target's
   identity bridge, `activateBrowser`, with the same input desktop `activate`
   sends.
3. **Register in the target.** `RegionalOnboardingService.activateBrowser`
   runs the same admission as `activate` (regional user link, preference
   projection, placement affinity, membership, demo admission, workspace object
   initialization). Instead of a workspace bearer session it creates a regional
   *identity* session, registers it as a browser session, and selects the
   workspace under it. It returns only `{ credential, expiresAt }`.
4. **Set the cookie.** Global answers `204` with `Set-Cookie` for the target's
   cookie name. The response reaches the browser through the browser Worker on
   the app host, so the host-only cookie is valid there.
5. **Use it.** From then on the client talks to
   `/regional/<region>/browser/*`, and the target resolves its own cookie. A
   later visit that finds no target cookie (`401` from the target's select)
   repeats step 2 and retries once.

The credential crosses one hop: service-binding RPC between two of Rally's own
Workers, which is not reachable from a public hostname. It is never logged and
never reaches JavaScript.

## The browser Worker

`/regional/<region>/*` forwards to a service binding named
`<bindingPrefix>_API` from `config/regions.json` (`GLOBAL_API` today), instead
of only `GLOBAL_API`. A configured region without a binding answers `404`, so a
deployment is reachable from the browser only once its binding is added.

The Worker drops `Authorization` and every cookie but the target's own
(`rally-browser-<region>` and its `-google-` state cookies) before forwarding,
so one deployment never sees another's session. A socket upgrade carries no
cookie at all.

## The client

- Sign-in (email and Google) always goes to Global. When the page a member
  signed in from is in another deployment, the client does not show the Global
  session; it lets the restore path activate the target.
- The workspace list comes from Global and links each workspace to its own
  region's path.
- Opening a workspace selects it in its region. A `401` there for a non-Global
  region activates through Global and retries once. The member shell's
  Organization switcher lists through Global for the same reason.
- Sign-out posts `/logout` to every configured deployment and waits for all of
  them. A deployment this host has no binding for (`404`) holds no cookie; any
  other failure tells the member to sign out again.
- A renewal that finds such a deployment's cookie gone (`401`) reopens the
  workspace through Global the same way, rather than signing the tab out.
- Tabs share one session-invalidation channel across deployments, so a
  sign-out in any tab reaches tabs open on every deployment.
- Sessions are compared within one region only: a Global session's user id is
  never compared with a regional one.

## Rejected

- **Global proxies regional API calls.** It would put every request on two
  hops and make Global a single point of failure for other deployments' data.
- **A one-use handoff code the browser redeems at the target.** That puts a
  credential in JavaScript and a URL, which the security model rules out.
- **Sharing one cookie across deployments.** Each deployment's session ledger is
  separate; a shared credential would need a shared ledger.

## What is not covered

- **Invitations.** Scoped invitation links name no region; a second deployment
  needs its own invitation routing, per
  [`regionalization.md`](../../regionalization.md).
- **Production proof.** Only `global` is configured. The flow is proven against
  a simulated second region in tests until a second deployment exists.
