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
  /**
   * The Rally staff member acting as `user`, on a support session only
   * (`docs/impersonation.md`). The shell shows them beside `user` and offers
   * **End impersonation** in place of signing out.
   */
  impersonator?: {
    id: string;
    email: string;
    name: string;
    avatarUrl?: string;
  };
}

/** A same-origin cookie session never carries a JavaScript bearer credential. */
export interface CookieClientSession extends ClientSession {
  authentication: "cookie";
}

/** Whether a session is the browser's cookie session: the one question of "am I the browser?". */
export function isCookieSession(session: ClientSession | null | undefined): session is CookieClientSession {
  return session != null && "authentication" in session && session.authentication === "cookie";
}
