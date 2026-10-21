import { RALLY_HEADERS, rallyHeaderAliases, readRallyHeader } from "@rally/contracts/http-headers";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import type { MiddlewareHandler } from "hono";
import type { HonoAppEnv } from "../env";
import { ApiError } from "../lib/api-error";
import { logEvent } from "../observability/logger";

export const requestContext: MiddlewareHandler<HonoAppEnv> = async (c, next) => {
  c.set("requestReceivedAt", Date.now());
  const incoming = c.req.header("x-request-id");
  const requestId = incoming && /^[A-Za-z0-9._:-]{1,100}$/u.test(incoming) ? incoming : crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  const requestedRegion = readRallyHeader((name) => c.req.header(name), RALLY_HEADERS.REGION);
  if (requestedRegion && requestedRegion !== c.env.AVALON_REGION) {
    throw new ApiError(409, "region_mismatch", "This workspace belongs to a different data region");
  }

  const started = Date.now();
  await next();
  logEvent(c, "info", "http_request", {
    method: c.req.method,
    path: new URL(c.req.url).pathname,
    status: c.res.status,
    duration_ms: Date.now() - started,
  });
};

export function securityMiddleware(): MiddlewareHandler<HonoAppEnv>[] {
  return [
    secureHeaders({
      crossOriginResourcePolicy: "same-site",
      referrerPolicy: "no-referrer",
      strictTransportSecurity: "max-age=31536000; includeSubDomains",
      xContentTypeOptions: "nosniff",
      xFrameOptions: "DENY",
    }),
    cors({
      origin: (origin, c) => {
        const allowed = new Set(c.env.ALLOWED_ORIGINS.split(",").map((value: string) => value.trim()).filter(Boolean));
        return allowed.has(origin) ? origin : undefined;
      },
      // Both spellings of every product header: the browser matches the
      // preflight list literally, so a shipped build still sending the
      // superseded name is rejected before any route code runs.
      allowHeaders: [
        "authorization",
        "content-type",
        "if-none-match",
        "idempotency-key",
        ...rallyHeaderAliases(RALLY_HEADERS.CLIENT_CONTRACT),
        ...rallyHeaderAliases(RALLY_HEADERS.DRAFT_ID),
        ...rallyHeaderAliases(RALLY_HEADERS.OPERATION_ID),
        ...rallyHeaderAliases(RALLY_HEADERS.REGION),
        "x-request-id",
      ],
      exposeHeaders: ["x-request-id", "etag"],
      allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      credentials: false,
      maxAge: 600,
    }),
  ];
}
