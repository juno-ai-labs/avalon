import type { Env } from "../env";
import { ApiError } from "./api-error";

/**
 * The browser client's origin, read from `BROWSER_APP_ORIGIN`. The value must
 * be an exact origin on https; plain http is accepted only in development.
 * Anything else means browser access is not configured.
 */
export function browserOrigin(env: Env): URL {
  let origin: URL;
  try { origin = new URL(env.BROWSER_APP_ORIGIN ?? ""); }
  catch { throw notConfigured(); }
  if (origin.origin !== env.BROWSER_APP_ORIGIN ||
    !(origin.protocol === "https:" || (env.APP_ENV === "development" && origin.protocol === "http:"))) {
    throw notConfigured();
  }
  return origin;
}

/** A path on the browser host, kept to that origin; the query and fragment are dropped. */
export function browserReturnUrl(env: Env, path: string | undefined): string {
  const origin = browserOrigin(env).origin;
  const target = new URL(path && path.startsWith("/") ? path : "/", origin);
  if (target.origin !== origin || target.pathname.startsWith("//")) {
    throw new ApiError(422, "invalid_return_uri", "The browser return path is not allowed");
  }
  return `${target.origin}${target.pathname}`;
}

function notConfigured(): ApiError {
  return new ApiError(503, "browser_configuration_required", "Browser access is not configured");
}
