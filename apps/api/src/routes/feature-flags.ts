import { ClientFeatureFlagsSchema } from "@rally/contracts";
import { Hono } from "hono";
import type { HonoAppEnv } from "../env";
import { getIdentityAuth } from "../middleware/auth";
import { resolveClientFeatureFlags } from "../services/client-feature-flags";

export const featureFlagRoutes = new Hono<HonoAppEnv>();

/**
 * Every client-visible flag, resolved for the signed-in person. The desktop
 * polls this, so it answers under identity auth rather than workspace auth:
 * eligibility is a property of the account, and a device that has not chosen an
 * organization yet still has to be told the feature is off rather than left
 * reading a 403 as an outage.
 */
featureFlagRoutes.get("/", async (c) => {
  // The answer is per person and this is the one route a client polls on a
  // timer, so it is exactly the shape an intermediary would be tempted to
  // cache — and a cached answer would either withhold a grant that has landed
  // or, worse, serve one person's to another. The identity routes set this for
  // the same reason.
  c.header("Cache-Control", "no-store");
  return c.json(ClientFeatureFlagsSchema.parse(await resolveClientFeatureFlags(c.env, getIdentityAuth(c))));
});
