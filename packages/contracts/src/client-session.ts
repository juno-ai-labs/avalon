import type { Region } from "./regions";

/** Identity and workspace presentation available to collaboration on every client. */
export interface ClientSession {
  expiresAt: string;
  apiBaseUrl: string;
  user: {
    id: string;
    email: string;
    name: string;
    avatarUrl?: string;
    timezone?: string;
  };
  workspace: {
    id: string;
    name: string;
    region: Region;
    role: "owner" | "admin" | "member" | null;
    accessClass?: "member" | "guest";
    timezone?: string;
  } | null;
}

/** A same-origin cookie session never carries a JavaScript bearer credential. */
export interface CookieClientSession extends ClientSession {
  authentication: "cookie";
}

/** Whether a session is the browser's cookie session: the one question of "am I the browser?". */
export function isCookieSession(session: ClientSession | null | undefined): session is CookieClientSession {
  return session != null && "authentication" in session && session.authentication === "cookie";
}
