
import { SignJWT, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { beforeAll, describe, expect, it } from "vitest";
import { readAccessConfiguration, verifyAccessRequest } from "../src/access";

const TEAM_DOMAIN = "rally.cloudflareaccess.com";
const AUDIENCE = "test-audience";

const CONFIGURATION = {
  teamDomain: TEAM_DOMAIN,
  applicationAudience: AUDIENCE,
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
  return new Request("https://mcp.internal.rallywith.ai/", { headers });
}

describe("readAccessConfiguration", () => {
  it("reads a complete configuration", () => {
    expect(readAccessConfiguration({
      ACCESS_TEAM_DOMAIN: " Rally.cloudflareaccess.com ",
      ACCESS_APPLICATION_AUD: AUDIENCE,
    })).toEqual({
      teamDomain: TEAM_DOMAIN,
      applicationAudience: AUDIENCE,
    });
  });

  it("refuses an incomplete or non-Access configuration", () => {
    expect(readAccessConfiguration({})).toBeNull();
    expect(readAccessConfiguration({ ACCESS_TEAM_DOMAIN: TEAM_DOMAIN })).toBeNull();
    expect(readAccessConfiguration({ ACCESS_APPLICATION_AUD: AUDIENCE })).toBeNull();
    expect(readAccessConfiguration({
      ACCESS_TEAM_DOMAIN: "https://rally.cloudflareaccess.com/x",
      ACCESS_APPLICATION_AUD: AUDIENCE,
    })).toBeNull();
    expect(readAccessConfiguration({
      ACCESS_TEAM_DOMAIN: "attacker.example.com",
      ACCESS_APPLICATION_AUD: AUDIENCE,
    })).toBeNull();
  });
});

describe("verifyAccessRequest", () => {
  it("admits a signed assertion and reports who it belongs to", async () => {
    const token = await assertion({ email: "Operator@Juno-Labs.com" });
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      CONFIGURATION,
      { keySet },
    );

    expect(result).toEqual({
      ok: true,
      principal: {
        email: "operator@juno-labs.com",
        subject: "access-subject",
        audience: AUDIENCE,
      },
    });
  });

  it("accepts the assertion from the CF_Authorization cookie", async () => {
    const token = await assertion({ email: "operator@juno-labs.com" });
    const result = await verifyAccessRequest(
      request({ cookie: `other=1; CF_Authorization=${token}` }),
      CONFIGURATION,
      { keySet },
    );

    expect(result.ok).toBe(true);
  });

  it("refuses every request while Access is unconfigured", async () => {
    const token = await assertion({ email: "operator@juno-labs.com" });
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
    const token = await assertion({ email: "operator@juno-labs.com" });
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": token }),
      CONFIGURATION,
      { keySet: wrongKeySet },
    );

    expect(result).toEqual({ ok: false, reason: "access_assertion_invalid" });
  });

  it("refuses an assertion minted for another team or application", async () => {
    const wrongIssuer = await assertion({
      email: "operator@juno-labs.com",
      issuer: "https://attacker.cloudflareaccess.com",
    });
    const wrongAudience = await assertion({
      email: "operator@juno-labs.com",
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

  /**
   * Who may read the site is the Access application's policy, and this Worker
   * does not hold a second copy of it. An assertion minted for *this*
   * application is admitted whatever address it carries — if that address
   * should not have been let in, the policy is what to change.
   */
  it("admits any address the application's own policy let through", async () => {
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": await assertion({ email: "contractor@example.com" }) }),
      CONFIGURATION,
      { keySet },
    );

    expect(result).toEqual({
      ok: true,
      principal: { email: "contractor@example.com", subject: "access-subject", audience: AUDIENCE },
    });
  });

  it("admits a verified assertion that carries no email at all", async () => {
    const result = await verifyAccessRequest(
      request({ "cf-access-jwt-assertion": await assertion({}) }),
      CONFIGURATION,
      { keySet },
    );

    expect(result).toEqual({
      ok: true,
      principal: { email: null, subject: "access-subject", audience: AUDIENCE },
    });
  });
});
