import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import { APNS_TOPICS, RegisterPushDeviceRequestSchema } from "./push-notifications";

const token = "ab".repeat(32);

describe("RegisterPushDeviceRequestSchema", () => {
  it("accepts a production Mac and a sandbox or production iPhone", () => {
    expect(RegisterPushDeviceRequestSchema.parse({
      platform: "macos",
      transport: "apns",
      topic: APNS_TOPICS.macos,
      apnsEnvironment: "production",
      token,
      appVersion: "1.0.0",
    }).platform).toBe("macos");
    expect(RegisterPushDeviceRequestSchema.parse({
      platform: "ios",
      transport: "apns",
      topic: APNS_TOPICS.ios,
      apnsEnvironment: "sandbox",
      token,
      appVersion: "1.0.0",
    }).apnsEnvironment).toBe("sandbox");
    expect(RegisterPushDeviceRequestSchema.parse({
      platform: "ios",
      transport: "apns",
      topic: APNS_TOPICS.ios,
      apnsEnvironment: "production",
      token,
      appVersion: "1.0.0",
    }).topic).toBe("ai.rallywith.ios");
  });

  it("rejects a Mac sandbox token and a mismatched iOS topic", () => {
    expect(RegisterPushDeviceRequestSchema.safeParse({
      platform: "macos",
      transport: "apns",
      topic: APNS_TOPICS.macos,
      apnsEnvironment: "sandbox",
      token,
      appVersion: "1",
    }).success).toBe(false);
    expect(RegisterPushDeviceRequestSchema.safeParse({
      platform: "ios",
      transport: "apns",
      topic: APNS_TOPICS.macos,
      apnsEnvironment: "production",
      token,
      appVersion: "1",
    }).success).toBe(false);
  });
});
