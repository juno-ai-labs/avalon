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

## Presentation owns product copy

Presentation components accept semantic failure state, not exception text or
transport/provider response messages. A host may pass a boolean when one stable
failure treatment is enough, or a small domain union such as `load | attach`
when the action changes the recovery copy. The component maps that state to
Rally-authored language.

Raw diagnostics remain useful to logs, telemetry, and request tooling, but they
are not a presentation contract. In particular, never render `error.message`
in persistent navigation, sidebar, or inspector chrome. Those surfaces combine
many independent requests and remain visible after the action that failed, so a
server sentence there looks like product content and can outlive its context.
The scoped `rally/no-diagnostic-message-in-presentation` ESLint rule enforces
this boundary over the registered sidebar, rail, and adapter modules. It rejects
diagnostic `.message` reads, destructuring, `String(error)`, and
`error.toString()` while allowing domain objects whose fields happen to be named
`message`. A catch binding is diagnostic regardless of its local name, so
renaming `error` to `caught` or `failure` cannot bypass the rule. Sidebar/rail
filenames join that scope automatically; presentation modules with another name
must be added to the registry and its scope test.

## Errors require acknowledgement

Desktop and browser operational errors use the shared `ErrorNotice` popup with
an **OK** action. Inline error banners, paragraphs and DOM `role="alert"` are
banned. `rally/no-inline-errors` rejects these known patterns in both hosts and
shared UI, including the retired `InlineError` import. See
[shared UI](shared-ui.md#error-popups) for queue, retry and focus behavior.
Historical transcript/run status and loading indicators remain content; a new
failed operation is reported over the surface rather than inserted into it.

## Construct Zod object modes directly

In production source reachable from the API Worker, construct an object's
unknown-key mode directly:

- use `z.strictObject(shape)`, not `z.object(shape).strict()`;
- use `z.looseObject(shape)`, not `z.object(shape).passthrough()` or
  `z.object(shape).loose()`.

The direct constructors preserve the corresponding validation behavior without
first constructing a default object schema and then deriving a second schema.
This rule applies only when the chain starts directly at `z.object()`. A mode
change on an existing or further-derived schema is a different operation and
must stay explicit. ESLint enforces the direct cases in the API, contracts,
agent-harness, and connector production graphs.

## Defer cold Zod schema graphs without changing Zod

Use `deferredZodSchema()` from `@rally/contracts/deferred-zod-schema` when all
of these are true:

- the schema is statically reachable from a Worker entrypoint and would
  otherwise construct during global-scope evaluation;
- it is a non-trivial schema family, derived schema, or JSON Schema conversion,
  rather than a small scalar that would only add a lazy wrapper;
- it belongs to a capability that an isolate may never exercise, so paying the
  construction cost on that capability's first use is preferable to charging
  every isolate at startup; and
- its factory is deterministic and independent of request data, bindings,
  credentials, mutable state, and environment-specific values.

A retained `wrangler check startup` profile that shows schema construction or
allocation is the strongest evidence for applying the pattern. An obviously
cold capability-specific schema family is also enough; do not invent a timing
threshold merely to justify the wrapper. Do not defer a small schema used by
every startup path, a schema whose value intentionally depends on runtime
state, or a schema whose first-use construction would violate that capability's
latency requirement. Laziness moves the one-time cost; it does not eliminate
it.

The exported value remains a regular Zod schema: callers keep using `parse`,
`safeParse`, and `z.infer`, while the inner schema graph is constructed on
first use and memoized for the life of the isolate. The cache may contain only
a pure, immutable schema or derived JSON Schema.

This is evaluation laziness, not dependency laziness. Imports remain static.
Do not replace it with `import()`, and do not put an uncached schema factory in
a request handler. When one deferred object schema derives another with an
object-only API such as `.extend()` or `.shape`, unwrap the dependency inside
the deferred factory. Ordinary consumers should not unwrap merely to parse.

`deferredZodSchema()` uses regular Zod 4, including its default English locale,
custom refinements, issue paths, and detailed messages. It is not a reason to
switch to Zod Mini or to return raw Zod errors directly to users.

## Testing

Repository-wide rules should have a mechanical check when the syntax can be
identified without false positives. The static-import rule is enforced over
production JavaScript and TypeScript source. Existing test and operator-script
exceptions are migration debt and must be removed when those files are touched;
native host-language calls such as Objective-C's `ObjC.import` are not
JavaScript module imports.

### 2026-09-18 — Sidebar presentation owns failure language

**What changed:** Sidebar and inspector boundaries now carry semantic failure
states, and `rally/no-diagnostic-message-in-presentation` rejects direct and
common conversions of diagnostic errors into copy in their production modules.

**Why:** A router 404 sentence reached the Sidekicks rail as if it were Rally
copy. The same exception-to-string pattern existed in adjacent navigation,
project, work-stream action, picker, and resource surfaces.

**Considered and rejected:** Filtering known server strings would preserve an
unsafe default for the next unknown response. A repository-wide ban would also
reject legitimate diagnostic handling outside presentation.

**Consequences:** Rail components own stable copy for each action. The guarded
file registry has an executable scope test; new nonstandard adapter names must
be added there. The rule follows catch bindings and their immutable aliases,
while respecting lexical shadowing; lower layers remain free to retain rich
errors for diagnosis.

### 2026-09-01 — Cold API schema families construct on first use

**What changed:** API-reachable telemetry properties, capability-specific
WorkspaceDO protocols, internal object-port requests, engineering inspection,
GitHub tools, multimodal tools, and harness tool schemas now retain lightweight
Zod lazy shells at module evaluation and construct their inner graphs on first
use. Module-scope JSON Schema conversion for those tools is memoized behind the
same first-use boundary.

**Why:** Direct object constructors removed intermediate allocations, but the
exact Worker profile still showed Zod construction and garbage collection as a
large startup cost. These schema families were initialized together even though
one request exercises only a small subset of them.

**Considered and rejected:** Dynamic imports still violate the static-dependency
rule. Zod Mini would change default error localization. Rebuilding schemas in
each handler would trade startup cost for repeated request cost. A shared
memoized `z.lazy()` wrapper preserves the existing runtime and type contracts
while paying each inner graph at most once per isolate.

**Consequences:** The first use of a deferred capability pays its schema
construction cost. Only deterministic schema state may be retained. Code that
derives a `ZodObject` from another deferred schema unwraps it inside its own
factory; validation call sites continue to use the exported schema normally.

### 2026-09-01 — Construct API-reachable Zod object modes directly

**What changed:** API Worker production code now uses `z.strictObject()` and
`z.looseObject()` for direct object-mode construction. A scope-aware autofixable
lint rule enforces the form across the API and its three Zod-owning workspace
dependencies.

**Why:** The retained exact-SHA startup profile attributed most active startup
time to Zod schema construction and garbage collection. The direct public APIs
preserve parsing behavior while avoiding an intermediate default object schema.

**Considered and rejected:** A textual replacement was rejected because
`BaseSchema.strict()` and a mode change after another schema derivation are not
the same AST or necessarily the same construction. A startup-time lint
threshold was rejected because local timing varies by machine and Wrangler
already profiles the deployable artifact.

**Consequences:** New direct `z.object().strict()`,
`z.object().passthrough()`, and `z.object().loose()` chains in the startup graph
fail lint and can be autofixed. The fixer preserves grouping parentheses and
supplies the empty shape required by direct constructors when `z.object()`
omits it. Other schema chains remain available when their semantics require
them.

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
