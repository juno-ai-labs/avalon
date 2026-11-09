# Type-safety boundaries

Rally keeps compile-time contracts meaningful by making every deliberate type
escape local and reviewable. Production values are parsed or converted at
runtime boundaries; application test doubles implement the smallest capability
their subject consumes; partial Cloudflare bindings are created by typed test
builders whose unavoidable completeness assertion lives in one place.

## Where the code lives

| Path | Responsibility |
| --- | --- |
| `scripts/eslint-rules/type-assertion-boundaries.mjs` | Enforces the production, application-mock, and Cloudflare-test boundaries. |
| `scripts/type-assertion-boundaries.test.mjs` | Regression tests for those ESLint rules. |
| `apps/api/test/helpers/cloudflare-test.ts` | Typed builders for partial `Env`, D1, Durable Object, R2, Queue, AI, Flagship, and Images doubles. |
| `apps/release-retention/test/helpers/cloudflare-test.ts` | The retention Worker's corresponding R2 builder. |
| `apps/desktop/src/renderer/lib/workstreams-cache.ts` | An example of a typed state boundary: every write to the conversation query cache. |

## How it works

Production TypeScript under `apps/**/src` and `packages/**/src` may use ordinary
narrowing and a justified single assertion, but ESLint rejects `as unknown as`.
Code crossing a real wire or SDK boundary converts each union member explicitly
or parses unknown data with a schema. `WorkstreamWakeupRowSchema`, for example,
parses D1 rows rather than telling the compiler what D1 returned.

Tests may not erase a value to `unknown` and then assert a Rally-owned imported
type. A subject declares a small exported capability such as
`CredentialRefreshAdapter`, `AppSessionDesktopBridge`, or `AutoUpdaterPort`, and
the fixture uses `satisfies` or implements that port. A return-type change on a
consumed method therefore fails the fixture at compile time.

Cloudflare's ambient interfaces describe complete workerd bindings and are too
large for focused unit fakes. Tests call `createTestEnv`,
`createTestD1Database`, `createTestD1Result`, or
`createCloudflareTestBinding`. Their mapped input types check every supplied
property and method name while the final assertion that unimplemented runtime
members exist is confined to the helper. ESLint rejects direct assertions to
those platform types outside the helper files.

The builders also retain workerd method parameter contracts and whether a
method is synchronous, asynchronous, or object-returning. Returned workerd
objects may remain partial because focused tests cannot honestly construct
runtime brands and every unused method. The retention R2 builder is stricter:
its methods retain their complete return contracts.

## Invariants

- **Production code never uses `as unknown as`.** Breaking this makes an SDK,
  protocol, or cache shape change compile cleanly and fail only at runtime.
- **Application mocks target the smallest consumed capability and use
  `satisfies` or `implements`.** Casting a partial object to a broad client lets
  unrelated missing methods hide a changed return contract.
- **Cloudflare completeness assertions live only in the two typed builder
  modules.** Scattered assertions make binding-name and supplied-method drift
  invisible and prevent a central audit of deliberate test-runtime gaps.
- **A typed builder validates every supplied member.** It may forgive omitted
  workerd members, but it must not accept misspelled environment keys or an
  untyped bag such as `Record<string, unknown>`.
- **Unknown external data is parsed before use.** Type assertions are not
  validation; violating this invariant makes malformed stored or remote data
  reach code whose branches assume a valid discriminant.

## Boundary

This module owns type-escape policy and the test-only construction of incomplete
platform bindings. It does not own the business schemas themselves, React Query
cache behavior, or the semantics of any Cloudflare binding. Those remain with
their feature modules; this boundary only decides how code may claim that a
value satisfies them.

Generated third-party declarations and deployed migrations are outside the
policy. Ordinary assertions after a runtime check remain allowed. The
application-contract rule specifically targets the dangerous double assertion,
not every use of TypeScript's `as` syntax.

## Failure modes and limits

The lint rules are syntax-aware but not a replacement for TypeScript's semantic
checker. An application type must be imported from a relative module or an
`@rally/*` package for the mock rule to recognize it. Capability aliases should
therefore stay exported and imported rather than duplicated structurally in a
test.

The Cloudflare builders deliberately accept partial callable surfaces because
workerd interfaces contain overloads, brands, and runtime-only members that a
Node unit fake cannot honestly implement. This is a bounded loss of
completeness, not runtime validation. They reject unrelated parameter types,
primitive returns from object-returning methods, and sync/async category drift,
but do not require a complete returned workerd object; integration tests remain
responsible for the actual binding behavior.

## Testing

`pnpm test:scripts` exercises each accepted and rejected lint shape. `pnpm lint`
applies the rules repository-wide, while `pnpm typecheck` proves that every
capability mock and every supplied Cloudflare test member still matches its
declared contract. Feature suites then exercise the behavior behind those
ports.

When adding a platform builder, add a failing direct-cast example and a passing
builder example to `scripts/type-assertion-boundaries.test.mjs`. Do not silence
the rule at a call site; extend the centralized helper only when the missing
surface is genuinely a platform-runtime gap.

## Changelog

### 2026-08-12 — Type escapes became explicit boundaries

**What changed:** Production double assertions are lint errors, application
test doubles use narrow capability ports with `satisfies`, and partial
Cloudflare bindings are constructed through typed helpers. The existing
work-stream cache write lint is joined by repository-wide type-assertion rules,
and stored wake-up rows plus harness SDK messages now cross explicit runtime or
conversion boundaries.

**Why:** A socket reconciliation wrote the page-shaped result of
`getWorkstreams()` into a cache whose readers expected an array. React Query's
key does not carry its value type, and the socket tests asserted partial objects
through `as unknown as RallyApi`; both the bad cache write and the changed API
return type therefore compiled. The same audit found hundreds of assertions to
Cloudflare runtime interfaces and several broad application mocks capable of
hiding the next contract change.

**Considered and rejected:** A repository-wide ban on every type assertion.
Cloudflare's branded workerd interfaces cannot be fully implemented by focused
Node test doubles, and ordinary post-validation narrowing is legitimate. Also
rejected: a generic `unsafeCast<T>` helper, which would reduce the visible count
without checking supplied members or expressing why the escape exists.

**Consequences:** Tests that need a new method must add it to the smallest
production capability and satisfy that port. New Cloudflare fakes may omit
unused runtime surface only through the centralized builders. Production SDK
drift must be handled by an explicit converter or runtime parser, which adds
code but makes unsupported variants fail at the boundary instead of downstream.
