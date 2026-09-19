import { Hono } from "hono";

import type { HonoAppEnv } from "../env";

/**
 * Projects are gone; Spaces replace them.
 *
 * This is not a compatibility protocol and is not trying to be one. The PRD
 * rejected running both authorities beside each other — two directories could
 * disagree about the same Channel — so a client that still speaks Project gets
 * one honest answer rather than a partial or malformed payload it would render
 * as though the hierarchy still existed.
 *
 * `410` rather than `404`: the resource existed and is permanently gone, which
 * is the difference between "you have the wrong id" and "update the app". The
 * body names the replacement so whoever finds this in a log knows where the
 * surface went. Phase 5 removes the Project authority underneath it.
 */
export const projectRoutes = new Hono<HonoAppEnv>();

projectRoutes.all("/*", (c) => c.json({
  error: "client_update_required",
  message: "Projects have been replaced by Spaces. Update Rally to continue.",
  replacement: "/spaces",
}, 410));
