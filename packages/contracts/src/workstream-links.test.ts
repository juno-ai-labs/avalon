import "../../../tests/isolated-region";
import { parseDesktopDeepLinkIntent } from "./desktop-deep-link-intent";
import { describe, expect, it } from "vitest";
import {
  isWorkstreamId,
  parseSpaceLinkPathTarget,
  parseWorkstreamLink,
  parseWorkstreamLinkTarget,
  parseWorkstreamLinkPath,
  workstreamCanonicalUrl,
  workstreamDeepLink,
  spaceCanonicalUrl,
  spaceDeepLink,
} from "./workstream-links";
import { uuidFromBase58, uuidToBase58 } from "./uuid-base58";

const WORKSTREAM_ID = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";
const WORKSPACE_ID = "00000000-0000-7000-8000-000000000009";
const SPACE_ID = "00000000-0000-7000-8000-0000000000a9";
const CHILD_ID = "00000000-0000-7000-8000-000000000099";
const ENCODED_WORKSPACE_ID = "1111117Hxt1fAWDjN7Te";
const ENCODED_SPACE_ID = "1111117Hxt1fAWDjN7WQ";
const ENCODED_WORKSTREAM_ID = "CduMrko5vpzwph2okTVLJ";
const WEB_BASE_URL = "https://rallywith.ai";
const LEGACY_WEB_BASE_URL = "https://with-avalon.com";
const TARGET = { region: "enterprise" as const, workspaceId: WORKSPACE_ID, spaceId: SPACE_ID, workstreamId: WORKSTREAM_ID };

describe("Base58 UUID segments", () => {
  it("preserves leading zero bytes and rejects noncanonical or overflowing segments", () => {
    expect(uuidToBase58(WORKSPACE_ID)).toBe(ENCODED_WORKSPACE_ID);
    expect(uuidFromBase58(ENCODED_WORKSPACE_ID)).toBe(WORKSPACE_ID);
    expect(uuidFromBase58("1")).toBeNull();
    expect(uuidFromBase58(`1${ENCODED_WORKSPACE_ID}`)).toBeNull();
    expect(uuidFromBase58("0OIl")).toBeNull();
    expect(uuidFromBase58("z".repeat(23))).toBeNull();
  });
});

describe("canonical work-stream links", () => {
  it("preserves the private child through HTTPS and desktop handoff", () => {
    const target = { ...TARGET, substreamId: CHILD_ID };
    expect(parseWorkstreamLinkTarget(workstreamCanonicalUrl(WEB_BASE_URL, target), { webBaseUrl: WEB_BASE_URL })).toEqual(target);
    expect(parseWorkstreamLinkTarget(workstreamDeepLink(target), { webBaseUrl: WEB_BASE_URL })).toEqual(target);
    expect(parseDesktopDeepLinkIntent(workstreamDeepLink(target))).toMatchObject({ kind: "workstream", spaceId: target.spaceId, workstreamId: target.workstreamId, substreamId: target.substreamId });
  });

  it("mints one workspace-addressed canonical and desktop shape", () => {
    expect(workstreamCanonicalUrl(WEB_BASE_URL, TARGET))
      .toBe(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_SPACE_ID}/c/${ENCODED_WORKSTREAM_ID}`);
    expect(workstreamDeepLink(TARGET))
      .toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/spaces/${ENCODED_SPACE_ID}/channels/${ENCODED_WORKSTREAM_ID}`);
  });

  it("does not read the superseded long canonical segment names", () => {
    expect(parseSpaceLinkPathTarget(`/app/enterprise/${ENCODED_WORKSPACE_ID}/space/${ENCODED_SPACE_ID}/`)).toBeNull();
    expect(parseWorkstreamLinkTarget(
      `${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/space/${ENCODED_SPACE_ID}/channel/${ENCODED_WORKSTREAM_ID}`,
      { webBaseUrl: WEB_BASE_URL },
    )).toBeNull();
  });

  it("mints an HTTPS link that carries the id in the path", () => {
    expect(workstreamCanonicalUrl(WEB_BASE_URL, TARGET))
      .toBe(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_SPACE_ID}/c/${ENCODED_WORKSTREAM_ID}`);
  });

  it("keeps the id out of a fragment so a server reading the shared URL can see it", () => {
    const url = new URL(workstreamCanonicalUrl(WEB_BASE_URL, TARGET));

    expect(url.hash).toBe("");
    expect(url.search).toBe("");
    expect(url.pathname).toContain(ENCODED_WORKSTREAM_ID);
  });

  it("mints against a local web base without hardcoding production", () => {
    expect(workstreamCanonicalUrl("http://127.0.0.1:5174", TARGET))
      .toBe(`http://127.0.0.1:5174/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_SPACE_ID}/c/${ENCODED_WORKSTREAM_ID}`);
  });

  it("resolves to the deep link the desktop client registers", () => {
    expect(workstreamDeepLink(TARGET))
      .toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/spaces/${ENCODED_SPACE_ID}/channels/${ENCODED_WORKSTREAM_ID}`);
  });

  it("never mints the superseded scheme", () => {
    // Parsing accepts `avalon:` and always will until shipped builds are gone,
    // which makes minting the wrong one invisible to every other test here:
    // the link would still round-trip. This asserts the writing side alone.
    expect(workstreamDeepLink(TARGET).startsWith("avalon:")).toBe(false);
  });

  it("refuses to mint a link for anything that is not a work-stream UUID", () => {
    expect(() => workstreamCanonicalUrl(WEB_BASE_URL, { ...TARGET, workstreamId: "../../settings" })).toThrow();
    expect(() => workstreamDeepLink({ ...TARGET, workstreamId: "019fec70" })).toThrow();
    expect(() => workstreamCanonicalUrl(WEB_BASE_URL, { ...TARGET, workspaceId: "not-a-workspace" })).toThrow();
    expect(() => workstreamCanonicalUrl(WEB_BASE_URL, { ...TARGET, spaceId: "not-a-space" })).toThrow();
    expect(isWorkstreamId(WORKSTREAM_ID)).toBe(true);
    expect(isWorkstreamId(`${WORKSTREAM_ID}/extra`)).toBe(false);
  });

  it("mints and reads a Space dashboard URL", () => {
    const space = { region: TARGET.region, workspaceId: WORKSPACE_ID, spaceId: SPACE_ID };
    expect(spaceCanonicalUrl(WEB_BASE_URL, space))
      .toBe(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_SPACE_ID}/`);
    expect(parseSpaceLinkPathTarget(new URL(spaceCanonicalUrl(WEB_BASE_URL, space)).pathname)).toEqual(space);
    expect(parseSpaceLinkPathTarget(`/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_SPACE_ID}/c/${ENCODED_WORKSTREAM_ID}`)).toBeNull();
    expect(parseSpaceLinkPathTarget(`/app/enterprise/${WORKSPACE_ID}/s/${ENCODED_SPACE_ID}/`)).toBeNull();
    expect(spaceDeepLink(space))
      .toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/spaces/${ENCODED_SPACE_ID}`);
  });
});

describe("reading a shared work-stream link", () => {
  it("reads a workspace-addressed canonical link", () => {
    expect(parseWorkstreamLink(
      `${WEB_BASE_URL}/app/workspaces/enterprise/${WORKSPACE_ID}/workstreams/${WORKSTREAM_ID}`,
      { webBaseUrl: WEB_BASE_URL },
    )).toBe(WORKSTREAM_ID);
    expect(parseWorkstreamLinkTarget(
      `${WEB_BASE_URL}/app/workspaces/enterprise/${WORKSPACE_ID}/workstreams/${WORKSTREAM_ID}`,
      { webBaseUrl: WEB_BASE_URL },
    )).toEqual({ region: TARGET.region, workspaceId: WORKSPACE_ID, workstreamId: WORKSTREAM_ID });
  });

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

  it("ignores a canonical link on another origin unless the caller named it", () => {
    // A caller that serves one origin per request reads one origin. The default
    // stays narrow so a look-alike host cannot borrow the treatment.
    expect(parseWorkstreamLink(`${LEGACY_WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: WEB_BASE_URL,
    })).toBeNull();
    expect(parseWorkstreamLink(`${LEGACY_WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: LEGACY_WEB_BASE_URL,
    })).toBe(WORKSTREAM_ID);
  });

  it("reads links on every origin a caller names", () => {
    // Slack registers both site domains for unfurling and delivers link_shared
    // for either, without knowing which one a link in channel history was
    // minted on. A caller handed URLs by a third party does not get to pick the
    // domain, so it names both — and every already-shared Avalon link would
    // otherwise be delivered and silently dropped.
    const accepted = [WEB_BASE_URL, LEGACY_WEB_BASE_URL];

    for (const base of accepted) {
      expect(parseWorkstreamLink(`${base}/app/workstreams/${WORKSTREAM_ID}`, {
        webBaseUrl: accepted,
      })).toBe(WORKSTREAM_ID);
    }
    // Widening to a set must not widen to anything else.
    expect(parseWorkstreamLink(`https://evil.example/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: accepted,
    })).toBeNull();
    expect(parseWorkstreamLink(`${WEB_BASE_URL}.evil.example/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: accepted,
    })).toBeNull();
    expect(parseWorkstreamLink(`${WEB_BASE_URL}/app/workstreams/${WORKSTREAM_ID}`, {
      webBaseUrl: [],
    })).toBeNull();
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
      `rallywithai://workstreams/${WORKSTREAM_ID}?region=enterprise`,
      `rallywithai://workstreams/${WORKSTREAM_ID}?region=enterprise&workspace=${WORKSPACE_ID}&extra=value`,
      `rallywithai://workspace/enterprise/${WORKSPACE_ID}/workstreams/${WORKSTREAM_ID}?extra=value`,
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
