import { afterEach, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { DIGESTS_ENABLED_FLAG_KEY, resolveDigestsEnabled } from "../src/services/digest-flags";
import { clearFlagTargetingAttributeCache } from "../src/services/flag-targeting-attributes";
import { createCloudflareTestBinding, createTestEnv } from "./helpers/cloudflare-test";

// APP_ENV production so the unreachable-binding path warns rather than staying
// quiet the way it does in development.
const baseEnv = createTestEnv({
  AVALON_REGION: "global",
  APP_ENV: "production",
  LOG_LEVEL: "error",
});

const SUBJECT = { userId: "usr-1", workspaceId: "wsp-1" };

afterEach(() => {
  // Attributes are cached in the isolate; a test must not inherit another's rows.
  clearFlagTargetingAttributeCache();
});

type DetailsStub = (
  flagKey: string,
  defaultValue: boolean,
  context?: FlagshipEvaluationContext,
) => Promise<Partial<FlagshipEvaluationDetails<unknown>>>;

/** Binds a `getBooleanDetails` stub, the only Flagship method the resolver calls. */
function envWithFlags(getBooleanDetails: DetailsStub): Env {
  return { ...baseEnv, FLAGS: createCloudflareTestBinding<Flagship>({ getBooleanDetails }) };
}

describe("digests-enabled flag", () => {
  it("keeps digests enabled when no binding is attached", async () => {
    await expect(resolveDigestsEnabled(baseEnv, SUBJECT)).resolves.toBe(true);
  });

  it("keeps digests enabled when evaluation throws", async () => {
    // `wrangler dev --local` binds this always-remote binding as an object
    // whose every call throws, which is the normal local state this mirrors.
    const env = envWithFlags(async () => {
      throw new Error("Binding FLAGS needs to be run remotely");
    });
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(true);
  });

  it("keeps digests enabled when the flag does not resolve", async () => {
    const env = envWithFlags(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
      errorCode: "FLAG_NOT_FOUND",
    }));
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(true);
  });

  it("treats anything but an explicit false as enabled", async () => {
    const env = envWithFlags(async (flagKey) => ({
      flagKey,
      // A malformed value from a corrupted or mistyped variation must not
      // silently stop delivery — only an explicit `false` may.
      value: "not-a-boolean" as unknown as boolean,
      variant: "on",
      reason: "STATIC",
    }));
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(true);
  });

  it("turns digests off on an explicit false variation", async () => {
    const env = envWithFlags(async (flagKey) => ({
      flagKey,
      value: false,
      variant: "off",
      reason: "TARGETING_MATCH",
    }));
    await expect(resolveDigestsEnabled(env, SUBJECT)).resolves.toBe(false);
  });

  it("evaluates the one digests-enabled key with the person and workspace as identity", async () => {
    const getBooleanDetails = vi.fn<DetailsStub>(async (flagKey, defaultValue) => ({
      flagKey,
      value: defaultValue,
      reason: "DEFAULT",
    }));
    const env = envWithFlags(getBooleanDetails);

    await resolveDigestsEnabled(env, SUBJECT);

    // The default handed to Flagship is `true`, not `false` — the opposite of
    // every client-visible flag — which is what makes an unresolved flag serve
    // enabled rather than disabled.
    expect(getBooleanDetails).toHaveBeenCalledWith(
      DIGESTS_ENABLED_FLAG_KEY,
      true,
      {
        region: "global",
        appEnv: "production",
        userId: SUBJECT.userId,
        workspaceId: SUBJECT.workspaceId,
      },
    );
  });
});
