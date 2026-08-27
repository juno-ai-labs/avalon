import { describe, expect, it } from "vitest";
import {
  DesktopDeepLinkUrlSchema,
  HttpsUrlSchema,
  HttpOrDesktopDeepLinkUrlSchema,
  HttpUrlSchema,
  WebSocketUrlSchema,
  httpUrlSchema,
} from "./url-schemas";

describe("explicit URL contracts", () => {
  it("accepts only web schemes for ordinary external URLs", () => {
    expect(HttpUrlSchema.parse("http://127.0.0.1:8787/path")).toContain("127.0.0.1");
    expect(HttpUrlSchema.parse("https://rallywith.ai/path")).toContain("rallywith.ai");
    expect(HttpUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(HttpUrlSchema.safeParse("data:text/plain,test").success).toBe(false);
  });

  it("distinguishes HTTPS provider URLs and desktop deep links", () => {
    expect(HttpsUrlSchema.safeParse("https://api.linear.app/graphql").success).toBe(true);
    expect(HttpsUrlSchema.safeParse("http://api.linear.app/graphql").success).toBe(false);
    expect(DesktopDeepLinkUrlSchema.safeParse("rallywithai://workstreams/123").success).toBe(true);
    expect(HttpOrDesktopDeepLinkUrlSchema.safeParse("rallywithai://auth/complete").success).toBe(true);
    expect(DesktopDeepLinkUrlSchema.safeParse("mailto:someone@rallywith.ai").success).toBe(false);
  });

  it("accepts only WebSocket schemes for socket URLs", () => {
    expect(WebSocketUrlSchema.safeParse("ws://127.0.0.1:8787/socket").success).toBe(true);
    expect(WebSocketUrlSchema.safeParse("wss://api.rallywith.ai/socket").success).toBe(true);
    expect(WebSocketUrlSchema.safeParse("https://api.rallywith.ai/socket").success).toBe(false);
  });

  it("still accepts the deep-link scheme shipped desktop builds registered", () => {
    // A build older than the rename answers to `avalon:` and nothing else, and
    // the links it minted are still in inboxes. Refusing them here would reject
    // an authentication return from every client that has not updated.
    expect(DesktopDeepLinkUrlSchema.safeParse("avalon://workstreams/123").success).toBe(true);
    expect(HttpOrDesktopDeepLinkUrlSchema.safeParse("avalon://auth/complete").success).toBe(true);
  });

  it("applies length bounds without weakening the scheme contract", () => {
    expect(httpUrlSchema(30).safeParse("https://example.com/short").success).toBe(true);
    expect(httpUrlSchema(20).safeParse("https://example.com/too-long").success).toBe(false);
    expect(httpUrlSchema(100).safeParse("file:///tmp/test").success).toBe(false);
  });
});
