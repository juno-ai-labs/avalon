/**
 * The operator site and its JSON mirror.
 *
 * Every route is behind the same Access check, including the JSON ones: an
 * operator reading the site and a script reading the API are the same
 * principal, and there is no second credential to keep in step. The site holds
 * no product data — object identifiers, class names, schema versions, and
 * migration error text — but it does describe the shape of the fleet, which is
 * not something to serve to the internet.
 */
import { Hono } from "hono";
import { readAccessConfiguration, accessFailureMessage, verifyAccessRequest } from "./access";
import { dispatchMigrationRun, dispatchableRegions } from "./dispatch";
import { devAuthEnabled, type Env } from "./env";
import { logEvent } from "./logger";
import {
  MigrationRunRequestSchema,
  ObjectQuerySchema,
  type MigrationRunRequest,
  type MigrationsOverview,
  type ObjectQuery,
} from "./protocol";
import { REGISTRY_OBJECT_NAME } from "./registry";
import type { MigrationRegistry } from "./registry";
import {
  layout,
  migrationsPage,
  notFoundPage,
  objectPage,
  objectsPage,
  overviewPage,
  refusalPage,
} from "./views";

interface Variables {
  /** The signed-in email when the assertion carried one; shown, never checked. */
  principal: string | null;
}

export const app = new Hono<{ Bindings: Env; Variables: Variables }>();

const DEV_PRINCIPAL = "developer@localhost";

app.use("*", async (context, next) => {
  if (devAuthEnabled(context.env)) {
    context.set("principal", DEV_PRINCIPAL);
    return next();
  }

  const result = await verifyAccessRequest(
    context.req.raw,
    readAccessConfiguration(context.env),
  );
  if (!result.ok) {
    logEvent("warn", "migration_tracker_access_denied", {
      message: `migration_tracker_access_denied ${result.reason}`,
      reason: result.reason,
      path: new URL(context.req.url).pathname,
    });
    const message = accessFailureMessage(result.reason);
    // 403 rather than 401: there is no credential this Worker could ask for.
    // Access mints the assertion, so the fix is always to come through it.
    if (context.req.path.startsWith("/api/")) {
      return context.json({ error: result.reason, message }, 403);
    }
    return context.html(refusalPage(message), 403);
  }

  context.set("principal", result.principal.email);
  return next();
});

app.get("/", async (context) => {
  const overview = await registry(context.env).overview();
  return context.html(layout("Overview", context.get("principal"), overviewPage(overview)));
});

app.get("/objects", async (context) => {
  const query = parseObjectQuery(context.req.url);
  const stub = registry(context.env);
  const [page, options] = await Promise.all([stub.listObjects(query), stub.filterOptions()]);
  return context.html(layout(
    "Objects",
    context.get("principal"),
    objectsPage(page, query, options),
  ));
});

app.get("/objects/:objectId", async (context) => {
  const detail = await registry(context.env).objectDetail(context.req.param("objectId"));
  if (!detail) {
    return context.html(layout("Not found", context.get("principal"), notFoundPage()), 404);
  }
  return context.html(layout(
    detail.object.objectName ?? "Object",
    context.get("principal"),
    objectPage(detail),
  ));
});

app.get("/migrations", async (context) => {
  const url = new URL(context.req.url);
  return context.html(layout(
    "Force a migration",
    context.get("principal"),
    migrationsPage(await migrationsOverview(context.env), url.searchParams.get("run")),
  ));
});

/**
 * Start a run, then redirect to the page that lists it.
 *
 * Post/redirect/get, so that the browser reload an operator reaches for while
 * waiting for reports to arrive does not dispatch the whole class a second
 * time. The run id travels in the query string, which is what the page uses to
 * point at the row that was just created.
 */
app.post("/migrations", async (context) => {
  const refusal = sameOriginRefusal(context.req.raw);
  if (refusal) return context.html(refusalPage(refusal), 403);
  const parsed = MigrationRunRequestSchema.safeParse(
    migrationRunFields(await context.req.parseBody()),
  );
  if (!parsed.success) {
    return context.html(layout(
      "Force a migration",
      context.get("principal"),
      migrationsPage(await migrationsOverview(context.env), null, "Pick a class to migrate."),
    ), 400);
  }
  const run = await startMigrationRun(context.env, parsed.data, context.get("principal"));
  return context.redirect(`/migrations?run=${encodeURIComponent(run.runId)}`, 303);
});

app.get("/api/migrations", async (context) => context.json(await migrationsOverview(context.env)));

app.post("/api/migrations", async (context) => {
  const refusal = sameOriginRefusal(context.req.raw);
  if (refusal) return context.json({ error: "cross_origin_write", message: refusal }, 403);
  const parsed = MigrationRunRequestSchema.safeParse(await context.req.json().catch(() => null));
  if (!parsed.success) {
    return context.json({
      error: "invalid_migration_run_request",
      issues: parsed.error.issues.map((issue) => issue.path.map(String).join(".") || "(root)"),
    }, 400);
  }
  return context.json(
    await startMigrationRun(context.env, parsed.data, context.get("principal")),
  );
});

app.get("/api/overview", async (context) => context.json(await registry(context.env).overview()));

app.get("/api/objects", async (context) => context.json(
  await registry(context.env).listObjects(parseObjectQuery(context.req.url)),
));

app.get("/api/objects/:objectId", async (context) => {
  const detail = await registry(context.env).objectDetail(context.req.param("objectId"));
  return detail ? context.json(detail) : context.json({ error: "object_not_found" }, 404);
});

app.notFound((context) => (context.req.path.startsWith("/api/")
  ? context.json({ error: "not_found" }, 404)
  : context.html(layout("Not found", context.get("principal") ?? null, notFoundPage()), 404)));

/**
 * A malformed filter is dropped rather than refused. The query string is a
 * bookmark an operator pasted mid-incident; answering with the unfiltered list
 * is more useful than answering with a validation error.
 */
export function parseObjectQuery(url: string): ObjectQuery {
  const parameters = new URL(url).searchParams;
  // The filter form submits an empty string for "any". Left as-is it fails the
  // enum and drops every *other* filter with it, so empty is normalized away
  // before the parse rather than after it.
  const text = (name: string): string | undefined => {
    const value = parameters.get(name)?.trim();
    return value ? value : undefined;
  };
  const numeric = (name: string): number | undefined => {
    const value = text(name);
    if (value === undefined) return undefined;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : undefined;
  };
  const candidate = {
    status: text("status"),
    component: text("component"),
    region: text("region"),
    scriptName: text("script"),
    search: text("search"),
    limit: numeric("limit"),
    offset: numeric("offset"),
  };
  const parsed = ObjectQuerySchema.safeParse(candidate);
  if (parsed.success) return parsed.data;

  // One bad parameter used to drop every filter on the request: a pasted link
  // with `component=substream_agent_do&limit=99999` returned the whole unfiltered
  // fleet, which reads as "this component has everything in it" rather than
  // "your limit was out of range". Drop only the fields Zod actually rejected,
  // so the rest of the operator's query survives.
  const rejected = new Set(parsed.error.issues.map((issue) => String(issue.path[0])));
  const kept = Object.fromEntries(
    Object.entries(candidate).filter(([field]) => !rejected.has(field)),
  );
  const fallback = ObjectQuerySchema.safeParse(kept);
  return fallback.success ? fallback.data : ObjectQuerySchema.parse({});
}

export function registry(env: Env): DurableObjectStub<MigrationRegistry> {
  return env.MIGRATION_REGISTRY.get(env.MIGRATION_REGISTRY.idFromName(REGISTRY_OBJECT_NAME));
}

async function migrationsOverview(env: Env): Promise<MigrationsOverview> {
  const stub = registry(env);
  const [components, runs] = await Promise.all([stub.forceableComponents(), stub.listMigrationRuns()]);
  return { components, runs, dispatchableRegions: dispatchableRegions(env) };
}

/**
 * Dispatch a run and log it, in the one place both entry points share.
 *
 * The log line is not decoration: a forced fan-out is the only write this site
 * performs, and Workers Logs is where it is visible without opening the page
 * that started it.
 */
async function startMigrationRun(
  env: Env,
  request: MigrationRunRequest,
  principal: string | null,
): Promise<Awaited<ReturnType<typeof dispatchMigrationRun>>> {
  const run = await dispatchMigrationRun(
    env,
    registry(env),
    request,
    principal ?? "unknown",
  );
  logEvent(run.status === "failed" ? "error" : "info", "migration_run_dispatched", {
    message: `migration_run_dispatched ${run.className} ${run.status}`
      + ` ${run.dispatched}/${run.matched} objects`,
    run_id: run.runId,
    class_name: run.className,
    region: run.region,
    matched_count: run.matched,
    dispatched_count: run.dispatched,
    unroutable_count: run.unroutable,
    truncated: run.truncated,
    status: run.status,
    error_message: run.errorMessage,
  });
  return run;
}

/**
 * Refuse a write that a browser reports as coming from somewhere else.
 *
 * Cloudflare Access is authentication, not intent: an operator's session cookie
 * travels with a form another site submits, so the assertion on such a request
 * is genuine and proves nothing about who asked for it. Every read here is
 * harmless, so only the two writes carry this.
 *
 * Checked when present rather than required, because `Origin` is a browser
 * header and its absence is what a script has. A browser omits it on a
 * same-origin `GET` and sends it on every cross-origin `POST`, which is the
 * case this exists to catch; a `curl` against the JSON twin sends none and is
 * not a confused deputy.
 */
function sameOriginRefusal(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin === null) return null;
  return origin === new URL(request.url).origin
    ? null
    : "This request came from another site. Start a migration from this page.";
}

/** The two fields the form submits, as `MigrationRunRequestSchema` reads them. */
function migrationRunFields(body: Record<string, unknown>): {
  className: unknown;
  region: unknown;
} {
  const region = typeof body.region === "string" && body.region.trim() !== ""
    ? body.region.trim()
    : null;
  return { className: body.className, region };
}
