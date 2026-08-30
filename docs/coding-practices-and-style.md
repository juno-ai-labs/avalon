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

## Testing

Repository-wide rules should have a mechanical check when the syntax can be
identified without false positives. The static-import rule is enforced over
production JavaScript and TypeScript source. Existing test and operator-script
exceptions are migration debt and must be removed when those files are touched;
native host-language calls such as Objective-C's `ObjC.import` are not
JavaScript module imports.

## Changelog

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
