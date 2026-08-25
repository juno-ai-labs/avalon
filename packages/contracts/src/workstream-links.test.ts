import { describe, expect, it } from "vitest";
import {
  isWorkstreamId,
  parseWorkstreamLink,
  parseWorkstreamLinkPath,
  workstreamCanonicalUrl,
  workstreamDeepLink,
} from "./workstream-links";

const WORKSTREAM_ID = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";
const WEB_BASE_URL = "https://rallywith.ai";
const LEGACY_WEB_BASE_URL = "https://with-avalon.com";

describe("canonical work-stream links", () => {
  it("mints an HTTPS link that carries the id in the path", () => {
    expect(workstreamCanonicalUrl(WEB_BASE_URL, WORKSTREAM_ID))
      .toBe(`${WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}`);
  });

  it("keeps the id out of a fragment so a server reading the shared URL can see it", () => {
    const url = new URL(workstreamCanonicalUrl(WEB_BASE_URL, WORKSTREAM_ID));

    expect(url.hash).toBe("");
    expect(url.search).toBe("");
    expect(url.pathname).toContain(WORKSTREAM_ID);
  });

  it("mints against a local web base without hardcoding production", () => {
    expect(workstreamCanonicalUrl("http://127.0.0.1:5174", WORKSTREAM_ID))
      .toBe(`http://127.0.0.1:5174/app/workstreams/${WORKSTREAM_ID}`);
  });

  it("resolves to the deep link the desktop client registers", () => {
    expect(workstreamDeepLink(WORKSTREAM_ID)).toBe(`rallywithai://workstreams/${WORKSTREAM_ID}`);
  });

  it("never mints the superseded scheme", () => {
    // Parsing accepts `avalon:` and always will until shipped builds are gone,
    // which makes minting the wrong one invisible to every other test here:
    // the link would still round-trip. This asserts the writing side alone.
    expect(workstreamDeepLink(WORKSTREAM_ID).startsWith("avalon:")).toBe(false);
  });

  it("refuses to mint a link for anything that is not a work-stream UUID", () => {
    expect(() => workstreamCanonicalUrl(WEB_BASE_URL, "../../settings")).toThrow();
    expect(() => workstreamDeepLink("019fec70")).toThrow();
    expect(isWorkstreamId(WORKSTREAM_ID)).toBe(true);
    expect(isWorkstreamId(`${WORKSTREAM_ID}/extra`)).toBe(false);
  });
});

describe("reading a shared work-stream link", () => {
  it("reads the canonical link", () => {
    expect(parseWorkstreamLink(`${WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}`, { webBaseUrl: WEB_BASE_URL }))
      .toBe(WORKSTREAM_ID);
  });

  it("reads a canonical link that picked up a trailing slash", () => {
    expect(parseWorkstreamLink(`${WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}/`, { webBaseUrl: WEB_BASE_URL }))
      .toBe(WORKSTREAM_ID);
  });

  it("reads the deep link a user copied before the canonical link existed", () => {
    expect(parseWorkstreamLink(`rallywithai://workstreams/${WORKSTREAM_ID}`, { webBaseUrl: WEB_BASE_URL }))
      .toBe(WORKSTREAM_ID);
  });

  it("reads a deep link minted in the scheme used before the rename", () => {
    // Shipped desktop builds registered `avalon:`, and the links they minted
    // are in inboxes and Slack history that nobody can reissue.
    expect(parseWorkstreamLink(`avalon://workstreams/${WORKSTREAM_ID}`, { webBaseUrl: WEB_BASE_URL }))
      .toBe(WORKSTREAM_ID);
  });

  it("ignores a canonical link on the domain the site is migrating off", () => {
    // Both domains serve the site, but a caller reads links for one origin at a
    // time: the Worker passes its own `PUBLIC_WEB_BASE_URL`. An Avalon-hosted
    // link is read by passing that base, not by widening this one.
    expect(parseWorkstreamLink(`${LEGACY_WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: WEB_BASE_URL,
    })).toBeNull();
    expect(parseWorkstreamLink(`${LEGACY_WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: LEGACY_WEB_BASE_URL,
    })).toBe(WORKSTREAM_ID);
  });

  it("reads the legacy handoff still sitting in Slack history", () => {
    const legacy = `${WEB_BASE_URL}/open#${new URLSearchParams({
      target: `avalon://workstreams/${WORKSTREAM_ID}`,
    }).toString()}`;

    expect(parseWorkstreamLink(legacy, { webBaseUrl: WEB_BASE_URL })).toBe(WORKSTREAM_ID);
  });

  it("ignores a look-alike host that borrows the canonical path", () => {
    expect(parseWorkstreamLink(`https://rallywith.ai.evil.example/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: WEB_BASE_URL,
    })).toBeNull();
  });

  it("ignores a legacy handoff whose target points somewhere else", () => {
    const settings = `${WEB_BASE_URL}/open#${new URLSearchParams({
      target: "avalon://settings/connections",
    }).toString()}`;

    expect(parseWorkstreamLink(settings, { webBaseUrl: WEB_BASE_URL })).toBeNull();
  });

  it("ignores other Avalon pages, other deep links, and malformed input", () => {
    for (const candidate of [
      `${WEB_BASE_URL}/app/workstreams/not-a-uuid`,
      `${WEB_BASE_URL}/app/workstreams/`,
      `${WEB_BASE_URL}/invite`,
      `avalon://automations/new`,
      `avalon://workstreams/${WORKSTREAM_ID}?token=leak`,
      "not a url",
    ]) {
      expect(parseWorkstreamLink(candidate, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    }
  });

  it("reads an id straight from a path for the site's own handoff page", () => {
    expect(parseWorkstreamLinkPath(`/app/workstreams/${WORKSTREAM_ID}`)).toBe(WORKSTREAM_ID);
    expect(parseWorkstreamLinkPath("/app/workstreams/")).toBeNull();
    expect(parseWorkstreamLinkPath("/open")).toBeNull();
  });
});
