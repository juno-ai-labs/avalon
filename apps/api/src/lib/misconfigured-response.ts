import type { Env } from "../env";

/**
 * The 503 for a misconfigured deployment, carrying its own CORS headers.
 *
 * The environment assertion runs at the entrypoint, before `app.fetch`, so this
 * answer never reaches the `cors()` middleware. Without these headers the
 * desktop client sees an opaque network failure rather than the status and code
 * — the browser refuses to expose a cross-origin response it cannot validate,
 * which would hide the one signal this path exists to send.
 *
 * The origin is echoed only when `ALLOWED_ORIGINS` lists it, matching the
 * middleware exactly. If that variable is itself the broken one, nothing is
 * echoed: a misconfigured deployment is not a reason to widen the boundary.
 */
export function misconfiguredResponse(request: Request, env: Env): Response {
  const origin = request.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((value) => value.trim());
  const headers = origin && allowed.includes(origin)
    ? { "access-control-allow-origin": origin, vary: "Origin" }
    : {};
  // Answering the preflight is what lets the real request be attempted at all,
  // and therefore what lets the client read the 503 below.
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
  return Response.json(
    { error: { code: "service_misconfigured", message: "The service is misconfigured", requestId: null } },
    { status: 503, headers },
  );
}
