import { describe, expect, it } from "vitest";

import { isAllowedMcpRedirectUri } from "./mcp-oauth";

describe("an MCP client's redirect", () => {
  it.each([
    "https://claude.ai/api/mcp/auth_callback",
    "https://chatgpt.com/connector_platform_oauth_redirect",
    "http://127.0.0.1:33418/callback",
    "http://localhost:6274/oauth/callback",
    "http://[::1]:8080/cb",
  ])("admits %s", (uri) => {
    expect(isAllowedMcpRedirectUri(uri)).toBe(true);
  });

  it.each([
    "https://claude.ai@evil.com/cb",
    "https://claude.ai.evil.com/cb",
    "http://claude.ai/cb",
    "https://claude.ai:8443/cb",
    "http://localhost.evil.com/cb",
    "https://claude.ai/cb#fragment",
    "javascript:alert(1)",
    "not a url",
  ])("refuses %s", (uri) => {
    expect(isAllowedMcpRedirectUri(uri)).toBe(false);
  });
});
