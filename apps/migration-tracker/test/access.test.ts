/// <reference types="@cloudflare/vitest-pool-workers/types" />

import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { readAccessConfiguration, verifyAccessRequest } from "../src/access";

const TEAM_DOMAIN = "avalon.cloudflareaccess.com";
const AUDIENCE = "test-audience";

const CONFIGURATION = {
  teamDomain: TEAM_DOMAIN,
  applicationAudience: AUDIENCE,
  allowedEmailDomains: ["with-avalon.com"],
};

let signingKey: CryptoKey;
let keySet: JWTVerifyGetKey;
let wrongKeySet: JWTVerifyGetKey;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256", { extractable: true });
  const other = await generateKeyPair("RS256", { extractable: true });
  signingKey = pair.privateKey;
  keySet = (() => Promise.resolve(pair.publicKey)) as unknown as JWTVerifyGetKey;
  wrongKeySet = (() => Promise.resolve(other.publicKey)) as unknown as JWTVerifyGetKey;
});

async function assertion(claims: {
  email?: string;
  issuer?: string;
  audience?: string;
}): Promise<string> {
  let token = new SignJWT(claims.email === undefined ? {} : { email: claims.email })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuedAt()
    .setExpirationTime("1h")
    .setSubject("access-subject")
    .setIssuer(claims.issuer ?? `https://${TEAM_DOMAIN}`);
  token = token.setAudience(claims.audience ?? AUDIENCE);
  return token.sign(signingKey);
}

function request(headers: Record<string, string> = {}): Request {
  return new Request("https://migrations.internal.with-avalon.com/", { headers });
}

describe("readAccessConfiguration", () => {
  it("reads a complete configuration", () => {
    expect(readAccessConfiguration({
      ACCESS_TEAM_DOMAIN: " Avalon.cloudflareaccess.com ",
      ACCESS_APPLICATION_AUD: AUDIENCE,
      ACCESS_ALLOWED_EMAIL_DOMAINS: "with-avalon.com, With-Avalon.dev ",
    })).toEqual({
      teamDomain: TEAM_DOMAIN,
      applicationAudience: AUDIENCE,
      allowedEmailDomains: ["with-avalon.com", "with-avalon.dev"],
    });
  });

  it("refuses an incomplete or non-Access configuration", () => {
    expect(readAccessConfiguration({})).toBeNull();
    expect(readAccessConfiguration({
      ACCESS_TEAM_DOMAIN: TEAM_DOMAIN,
      ACCESS_APPLICATION_AUD: AUDIENCE,
      ACCESS_ALLOWED_EMAIL_DOMAINS: "",
    })).toBeNull();
    expect(readAccessConfiguration({
      ACCESS_TEAM_DOMAIN: "https://avalon.cloudflareaccess.com/x",
      ACCESS_APPLICATION_AUD: AUDIENCE,
      ACCESS_ALLOWED_EMAIL_DOMAINS: "with-avalon.com",
    })).toBeNull();
    expect(readAccessConfiguration({
      ACCESS_TEAM_DOMAIN: "attacker.example.com",
      ACCESS_APPLICATION_AUD: AUDIENCE,
      ACCESS_ALLOWED_EMAIL_DOMAINS: "with-avalon.com",
    })).toBeNull();
  });
});

describe("verifyAccessRequest", () => {
  it("admits a signed assertion from an allowed domain", async () => {
    const token = await assertion({ email: "Operator@With-Avalon.com" });
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      CONFIGURATION,
      { keySet },
    );

    expect(result).toEqual({
      ok: true,
      principal: {
        email: "operator@with-avalon.com",
        subject: "access-subject",
        audience: AUDIENCE,
      },
    });
  });

  it("accepts the assertion from the CF_Authorization cookie", async () => {
    const token = await assertion({ email: "operator@with-avalon.com" });
    const result = await verifyAccessRequest(
      request({ cookie: `other=1; CF_Authorization=${token}` }),
      CONFIGURATION,
      { keySet },
    );

    expect(result.ok).toBe(true);
  });

  it("refuses every request while Access is unconfigured", async () => {
    const token = await assertion({ email: "operator@with-avalon.com" });
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      null,
      { keySet },
    );

    expect(result).toEqual({ ok: false, reason: "access_not_configured" });
  });

  it("refuses a request with no assertion at all", async () => {
    const result = await verifyAccessRequest(request(), CONFIGURATION, { keySet });
    expect(result).toEqual({ ok: false, reason: "access_assertion_missing" });
  });

  it("refuses an assertion signed by another key", async () => {
    const token = await assertion({ email: "operator@with-avalon.com" });
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      CONFIGURATION,
      { keySet: wrongKeySet },
    );

    expect(result).toEqual({ ok: false, reason: "access_assertion_invalid" });
  });

  it("refuses an assertion minted for another team or application", async () => {
    const wrongIssuer = await assertion({
      email: "operator@with-avalon.com",
      issuer: "https://attacker.cloudflareaccess.com",
    });
    const wrongAudience = await assertion({
      email: "operator@with-avalon.com",
      audience: "another-application",
    });

    expect(await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": wrongIssuer }),
      CONFIGURATION,
      { keySet },
    )).toEqual({ ok: false, reason: "access_assertion_invalid" });
    expect(await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": wrongAudience }),
      CONFIGURATION,
      { keySet },
    )).toEqual({ ok: false, reason: "access_assertion_invalid" });
  });

  it("refuses a verified assertion whose email domain is not allowed", async () => {
    const token = await assertion({ email: "operator@example.com" });
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      CONFIGURATION,
      { keySet },
    );

    expect(result).toEqual({ ok: false, reason: "access_email_domain_forbidden" });
  });

  it("takes the domain from the last @, so a crafted local part cannot pass", async () => {
    const token = await assertion({ email: "attacker@with-avalon.com@example.com" });
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      CONFIGURATION,
      { keySet },
    );

    expect(result).toEqual({ ok: false, reason: "access_email_domain_forbidden" });
  });

  it("refuses a verified assertion that carries no email", async () => {
    const token = await assertion({});
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      CONFIGURATION,
      { keySet },
    );

    expect(result).toEqual({ ok: false, reason: "access_email_missing" });
  });
});
