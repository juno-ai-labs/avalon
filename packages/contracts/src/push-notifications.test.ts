import "../../../tests/isolated-region";
import { describe, expect, it } from "vitest";
import { APNS_TOPICS, isWebPushServiceUrl, RegisterPushDeviceRequestSchema } from "./push-notifications";

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
    })).toMatchObject({ apnsEnvironment: "sandbox" });
    expect(RegisterPushDeviceRequestSchema.parse({
      platform: "ios",
      transport: "apns",
      topic: APNS_TOPICS.ios,
      apnsEnvironment: "production",
      token,
      appVersion: "1.0.0",
    })).toMatchObject({ topic: "ai.rallywith.ios" });
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

describe("the web subscription variant", () => {
  const web = {
    platform: "web",
    transport: "webpush",
    endpoint: "https://fcm.googleapis.com/fcm/send/abc",
    keys: { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(22) },
    appVersion: "web",
  };

  it("accepts a subscription on each known push service", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) expect(RegisterPushDeviceRequestSchema.safeParse({ ...web, endpoint }).success).toBe(true);
  });

  it("rejects an endpoint on any other host, with userinfo, or on another port", () => {
    for (const endpoint of [
      "https://internal.example.test/push",
      "https://fcm.googleapis.com.example.test/fcm/send/abc",
      "https://notify.windows.com.example.test/w",
      "https://user:pass@fcm.googleapis.com/fcm/send/abc",
      "https://fcm.googleapis.com:8443/fcm/send/abc",
      "http://fcm.googleapis.com/fcm/send/abc",
    ]) expect(RegisterPushDeviceRequestSchema.safeParse({ ...web, endpoint }).success).toBe(false);
    expect(isWebPushServiceUrl("not a url")).toBe(false);
  });

  it("rejects keys that are not a P-256 point and a 16-byte secret", () => {
    for (const keys of [
      { p256dh: `A${"A".repeat(86)}`, auth: "A".repeat(22) },
      { p256dh: `B${"A".repeat(85)}`, auth: "A".repeat(22) },
      { p256dh: `B${"A".repeat(86)}`, auth: "A".repeat(21) },
      { p256dh: `B${"A".repeat(86)}`, auth: `${"A".repeat(21)}=` },
    ]) expect(RegisterPushDeviceRequestSchema.safeParse({ ...web, keys }).success).toBe(false);
  });
});
