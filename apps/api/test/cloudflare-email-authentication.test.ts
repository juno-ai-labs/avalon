import { describe, expect, it } from "vitest";
import { cloudflareSenderAuthenticated } from "../src/services/cloudflare-inbound-email";

describe("Cloudflare's receiving-server authentication verdict", () => {
  it.each([
    ["mx.cloudflare.net; spf=pass; dkim=pass; dmarc=pass header.from=example.com", true],
    ["mx.cloudflare.net; dmarc=pass (p=none dis=none) header.from=example.com", true],
    ["attacker.example; dmarc=pass", false],
    ["mx.cloudflare.net; spf=pass; dkim=pass; dmarc=fail", false],
    ["mx.cloudflare.net; dmarc=fail (forged; dmarc=pass)", false],
    ['mx.cloudflare.net; dmarc=fail reason="forged; dmarc=pass"', false],
    ["mx.cloudflare.net; dmarc=fail, attacker.example; dmarc=pass", false],
    ["mx.cloudflare.net; dmarc=pass_invalid", false],
    ["mx.cloudflare.net; dmarc=pass (unterminated", false],
  ])("reads %s as authenticated=%s", (value, expected) => {
    expect(cloudflareSenderAuthenticated(new Headers({ "Authentication-Results": value }))).toBe(expected);
  });

  it("does not borrow a passing verdict from a later header", () => {
    const headers = new Headers();
    headers.append("Authentication-Results", "mx.cloudflare.net; dmarc=fail");
    headers.append("Authentication-Results", "attacker.example; dmarc=pass");
    expect(cloudflareSenderAuthenticated(headers)).toBe(false);
    expect(cloudflareSenderAuthenticated(new Headers())).toBe(false);
  });
});
