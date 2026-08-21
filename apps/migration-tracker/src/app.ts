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
import { devAuthEnabled, type Env } from "./env";
import { logEvent } from "./logger";
import { ObjectQuerySchema, type ObjectQuery } from "./protocol";
import { REGISTRY_OBJECT_NAME } from "./registry";
import type { MigrationRegistry } from "./registry";
import {
  layout,
  notFoundPage,
  objectPage,
  objectsPage,
  overviewPage,
  refusalPage,
} from "./views";

interface Variables {
  principal: string;
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
  // with `component=workstream&limit=99999` returned the whole unfiltered fleet,
  // which reads as "this component has everything in it" rather than "your limit
  // was out of range". Drop only the fields Zod actually rejected, so the rest of
  // the operator's query survives.
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
