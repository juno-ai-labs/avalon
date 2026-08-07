import type { Env } from "../env";

export function desktopHandoffUrl(
  env: Pick<Env, "PUBLIC_WEB_BASE_URL">,
  target: string | URL,
): string {
  const handoff = new URL("/auth/desktop/", env.PUBLIC_WEB_BASE_URL);
  handoff.hash = new URLSearchParams({ target: target.toString() }).toString();
  return handoff.toString();
}
