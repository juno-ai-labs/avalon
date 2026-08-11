import { describe, expect, it } from "vitest";
import {
  AvalonUrlSchema,
  HttpsUrlSchema,
  HttpOrAvalonUrlSchema,
  HttpUrlSchema,
  httpUrlSchema,
} from "./url-schemas";

describe("explicit URL contracts", () => {
  it("accepts only web schemes for ordinary external URLs", () => {
    expect(HttpUrlSchema.parse("http://127.0.0.1:8787/path")).toContain("127.0.0.1");
    expect(HttpUrlSchema.parse("https://with-avalon.com/path")).toContain("with-avalon.com");
    expect(HttpUrlSchema.safeParse("javascript:alert(1)").success).toBe(false);
    expect(HttpUrlSchema.safeParse("data:text/plain,test").success).toBe(false);
  });

  it("distinguishes HTTPS provider URLs and Avalon deep links", () => {
    expect(HttpsUrlSchema.safeParse("https://api.linear.app/graphql").success).toBe(true);
    expect(HttpsUrlSchema.safeParse("http://api.linear.app/graphql").success).toBe(false);
    expect(AvalonUrlSchema.safeParse("avalon://workstreams/123").success).toBe(true);
    expect(HttpOrAvalonUrlSchema.safeParse("avalon://auth/complete").success).toBe(true);
  });

  it("applies length bounds without weakening the scheme contract", () => {
    expect(httpUrlSchema(30).safeParse("https://example.com/short").success).toBe(true);
    expect(httpUrlSchema(20).safeParse("https://example.com/too-long").success).toBe(false);
    expect(httpUrlSchema(100).safeParse("file:///tmp/test").success).toBe(false);
  });
});
