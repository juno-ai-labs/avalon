# Coding practices and style

This document owns repository-wide implementation rules that are broader than
one product module and narrower than the quality gates in `AGENTS.md`. Read it
before introducing a new dependency pattern, changing module boundaries, or
adding a repository-wide lint rule.

## Imports are static

Use static `import` declarations. Do not use JavaScript or TypeScript dynamic
`import()` in production code, tests, or repository scripts.

Static imports keep the complete dependency graph visible to TypeScript, the
bundler, lint, reviewers, and deployment tooling before execution. A dependency
must not first become resolvable because a request, test branch, or script path
happened to run. If two dependency graphs must initialize independently, make
that a real process or deployment boundary with a typed contract. In Cloudflare
Workers, that means a separate Worker reached through a typed Service Binding;
it does not mean loading a module from an event handler.

The rule has three practical consequences:

- Optional product behavior is selected by ordinary control flow over statically
  imported implementations or by a typed external service boundary.
- Tests isolate module state through explicit factories and dependency
  injection, not cache-busting imports.
- Scripts import their supported dependencies at module scope. A dependency
  that is genuinely unavailable in one environment belongs in a separate
  environment-specific entrypoint.

Existing dynamic imports outside the files being changed are migration debt,
not examples to copy. A change that touches one should replace it with a static
import or move the dependency behind the correct typed deployment boundary.

## Boundaries stay typed

Cross-package and cross-service inputs and outputs use an exported TypeScript
contract. Parse again when the boundary accepts untrusted or independently
versioned data. Do not trade an import-cycle problem for untyped `fetch`,
`unknown` payloads, or duplicated interfaces. Put a shared contract in the
lowest layer both sides can import without importing an implementation.

## API schemas use the startup-efficient runtime

Production modules in the regional API and every shared package import
`zod/v3` for ordinary validation. Ace and desktop modules that compose those
shared schemas use the same runtime. Bind, the Engineering MCP SDK, and harness
features that require Zod v4 retain an explicit adapter at that compatibility
edge. Do not move an ordinary validation schema back to the bare `zod` export:
Zod v4's classic API allocates substantially more objects while the Worker
evaluates its static module graph, and nesting schemas from different major
runtimes breaks their input/output inference.

The compatibility runtime does not authorize a looser contract. Integer chains
include `.safe()` because Zod v4's `.int()` rejects integers JavaScript cannot
represent safely. This applies to every `zod/v3` schema, including one declared
inside an explicit mixed-runtime adapter file. UUID strings use
`STRICT_UUID_PATTERN` because Zod v3's generic UUID check accepts variants Zod
v4 refuses. Provider-facing JSON Schema goes through `providerJsonSchema`, which
preserves native-v4 default, strict UUID, and output-required behavior,
including schemas nested inside unions. Required opaque fields use
`RequiredUnknownSchema`, offset-aware timestamps use `OffsetDateTimeSchema`,
and non-integer number chains include `.finite()`; direct v3 forms otherwise
admit missing properties, invalid offsets, or infinities that v4 refused. Code that
classifies failures from both schema runtimes uses `isZodValidationError`; a
single-version `instanceof` check loses the other runtime's diagnostics.

`scripts/check-api-startup-schema-runtime.mjs` enforces these source boundaries.
Adding a genuine v4-only operation means isolating and documenting the narrow
compatibility file rather than widening the allowlist around ordinary schemas.

## Testing

Repository-wide rules should have a mechanical check when the syntax can be
identified without false positives. The static-import rule is enforced over
production JavaScript and TypeScript source. Existing test and operator-script
exceptions are migration debt and must be removed when those files are touched;
native host-language calls such as Objective-C's `ObjC.import` are not
JavaScript module imports.

## Changelog

### 2026-09-01 — API schema construction leaves the Zod v4 hot path

**What changed:** Schema-heavy API, contract, and connector modules now use the
shipped Zod v3-compatible runtime, as do Ace and desktop consumers that compose
those shared schemas. A checked compatibility layer preserves required opaque
fields, finite numbers, offset datetimes, safe integers, strict UUIDs, nested
provider JSON Schema, and cross-version error behavior; Bind's
JSON-Schema compiler and the Engineering MCP SDK remain on Zod v4 through
explicit adapters.

**Why:** Cloudflare rejected a fully verified 7.16 MiB Global API artifact with
startup CPU error 10021. Its retained profile attributed most active startup to
Zod v4 schema constructors and garbage collection. In the exact merged bundle,
local active startup was 205.4 ms including 109.9 ms of GC; the compatible
runtime reduced five repeated samples to 71.7–74.0 ms including 23.8–27.7 ms of
GC on the final 7,340.37 KiB artifact.

**Considered and rejected:** Retrying or minifying the same eager graph leaves
deployment dependent on validator timing. Request-time imports violate the
static-import rule. Another service split was rejected because the remaining
schemas enforce regional routes, RPC, and Durable Object authority rather than
one coherent stateless provider capability.

**Consequences:** Both Zod runtimes remain in the artifact, so this optimizes
initialization rather than source bytes. New API schemas and consumers that
compose them use `zod/v3` and its checked semantic shims; v4-only work stays at
the named compatibility edge and reparses through the shared contract. There is
no data migration.

### 2026-08-30 — Module imports are always static

**What changed:** Dynamic JavaScript and TypeScript module imports are no longer
an accepted implementation or test-isolation technique. Independent startup
graphs require a typed process or deployment boundary.

**Why:** Request-time loading hides the deployable dependency graph until code
runs and makes startup behavior depend on execution order. The API Worker
startup incident needed an explicit platform boundary, not a lazy import that
turned initialization into request work.

**Considered and rejected:** Allowing dynamic imports only for large optional
dependencies was rejected because it preserves two loading models and makes the
same dependency appear or disappear from startup based on bundler behavior.

**Consequences:** Touched dynamic imports are migrated rather than copied.
Cloudflare startup isolation uses statically built Workers and typed Service
Bindings, even when that requires more deployment configuration.
