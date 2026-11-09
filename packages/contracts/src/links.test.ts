import "../../../tests/isolated-region";
import { parseDesktopDeepLinkIntent } from "./desktop-deep-link-intent";
import { describe, expect, it } from "vitest";
import {
  canvasCanonicalUrl,
  canvasDeepLink,
  isRetiredLinkPath,
  linkCanonicalUrl,
  linkDeepLink,
  parseLinkPathTarget,
  parseLinkTarget,
  parseOrganizationShellTarget,
  sidekickCanonicalUrl,
  sidekickDeepLink,
} from "./links";
import { uuidFromBase58, uuidToBase58 } from "./uuid-base58";

const WORKSPACE_ID = "00000000-0000-7000-8000-000000000009";
const CANVAS_ID = "019fec70-fba0-7b0e-9f7a-3dd1ef56520f";
const ARTIFACT_ID = "00000000-0000-7000-8000-000000000099";
const SIDEKICK_ID = "00000000-0000-7000-8000-0000000000a9";
const ENCODED_WORKSPACE_ID = "1111117Hxt1fAWDjN7Te";
const ENCODED_CANVAS_ID = "CduMrko5vpzwph2okTVLJ";
const ENCODED_SIDEKICK_ID = "1111117Hxt1fAWDjN7WQ";
const WEB_BASE_URL = "https://rallywith.ai";
const LEGACY_WEB_BASE_URL = "https://with-avalon.com";
const ORGANIZATION = { region: "enterprise" as const, workspaceId: WORKSPACE_ID };
const CANVAS = { ...ORGANIZATION, canvasId: CANVAS_ID };
const SIDEKICK = { ...ORGANIZATION, sidekickId: SIDEKICK_ID };

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

describe("Canvas links", () => {
  it("mints the canonical URL and deep link, and reads both back", () => {
    const url = canvasCanonicalUrl(WEB_BASE_URL, CANVAS);
    expect(url).toBe(`https://rallywith.ai/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/`);
    expect(parseLinkTarget(url, { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "canvas", ...CANVAS });
    const deepLink = canvasDeepLink(CANVAS);
    expect(deepLink).toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/canvases/${ENCODED_CANVAS_ID}`);
    expect(parseLinkTarget(deepLink, { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "canvas", ...CANVAS });
    expect(parseDesktopDeepLinkIntent(deepLink)).toEqual({ kind: "canvas", canvasId: CANVAS_ID, target: ORGANIZATION });
  });

  it("carries the artifact a Canvas opens onto through every form", () => {
    const target = { ...CANVAS, artifactId: ARTIFACT_ID };
    const url = canvasCanonicalUrl(WEB_BASE_URL, target);
    expect(url).toBe(`https://rallywith.ai/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/a/${uuidToBase58(ARTIFACT_ID)}/`);
    expect(parseLinkPathTarget(new URL(url).pathname)).toEqual({ kind: "canvas", ...target });
    const deepLink = canvasDeepLink(target);
    expect(deepLink).toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/canvases/${ENCODED_CANVAS_ID}/artifacts/${uuidToBase58(ARTIFACT_ID)}`);
    expect(parseLinkTarget(deepLink, { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "canvas", ...target });
    expect(parseDesktopDeepLinkIntent(deepLink)).toEqual({ kind: "canvas", canvasId: CANVAS_ID, artifactId: ARTIFACT_ID, target: ORGANIZATION });
  });

  it("carries the message a Canvas opens at through every form", () => {
    const turnId = "00000000-0000-7000-8000-0000000000b1";
    const target = { ...CANVAS, turnId, sequence: 42 };
    const url = canvasCanonicalUrl(WEB_BASE_URL, target);
    expect(url).toBe(`https://rallywith.ai/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/?turn=${turnId}&sequence=42`);
    expect(parseLinkTarget(url, { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "canvas", ...target });
    const deepLink = canvasDeepLink(target);
    expect(deepLink).toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/canvases/${ENCODED_CANVAS_ID}?turn=${turnId}&sequence=42`);
    expect(parseLinkTarget(deepLink, { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "canvas", ...target });
    expect(parseDesktopDeepLinkIntent(deepLink)).toEqual({ kind: "canvas", canvasId: CANVAS_ID, turnId, sequence: 42, target: ORGANIZATION });
    const shell = `${WEB_BASE_URL}/app/workspaces/enterprise/${WORKSPACE_ID}#/canvases/${CANVAS_ID}?turn=${turnId}&sequence=42`;
    expect(parseOrganizationShellTarget(shell, { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "canvas", ...target });
    // Half a position, a second key, an artifact beside it or a bad sequence reads as no link.
    for (const query of [`?turn=${turnId}`, `?sequence=42`, `?turn=${turnId}&sequence=0`, `?turn=${turnId}&sequence=4.2`,
      `?turn=nope&sequence=42`, `?turn=${turnId}&sequence=42&extra=1`]) {
      expect(parseLinkTarget(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/${query}`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
      expect(parseDesktopDeepLinkIntent(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/canvases/${ENCODED_CANVAS_ID}${query}`)).toBeNull();
    }
    expect(parseLinkTarget(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/a/${uuidToBase58(ARTIFACT_ID)}/?turn=${turnId}&sequence=42`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    expect(parseLinkTarget(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/sk/${ENCODED_SIDEKICK_ID}/?turn=${turnId}&sequence=42`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    expect(() => canvasCanonicalUrl(WEB_BASE_URL, { ...CANVAS, turnId })).toThrow();
    expect(() => canvasDeepLink({ ...CANVAS, artifactId: ARTIFACT_ID, turnId, sequence: 1 })).toThrow();
  });

  it("reads a path with or without its trailing slash, and nothing longer or undecodable", () => {
    const base = `/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}`;
    expect(parseLinkPathTarget(base)).toEqual({ kind: "canvas", ...CANVAS });
    expect(parseLinkPathTarget(`${base}/`)).toEqual({ kind: "canvas", ...CANVAS });
    expect(parseLinkPathTarget(`${base}/a/`)).toBeNull();
    expect(parseLinkPathTarget(`${base}/b/${ENCODED_SIDEKICK_ID}`)).toBeNull();
    expect(parseLinkPathTarget(`/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${CANVAS_ID}/`)).toBeNull();
    expect(parseLinkPathTarget(`/app/enterprise/${WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/`)).toBeNull();
    expect(parseDesktopDeepLinkIntent(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/canvases/${ENCODED_CANVAS_ID}/breakouts/${ENCODED_SIDEKICK_ID}`)).toBeNull();
    expect(parseDesktopDeepLinkIntent(`rallywithai://canvases/${ENCODED_CANVAS_ID}`)).toBeNull();
  });

  it("refuses to mint for anything that is not a Canvas UUID", () => {
    expect(() => canvasCanonicalUrl(WEB_BASE_URL, { ...CANVAS, canvasId: "not-a-canvas" })).toThrow();
    expect(() => canvasDeepLink({ ...CANVAS, artifactId: "not-an-artifact" })).toThrow();
    expect(() => canvasCanonicalUrl(WEB_BASE_URL, { ...CANVAS, workspaceId: "not-an-organization" })).toThrow();
  });

  it("mints against a local web base without hardcoding production", () => {
    expect(canvasCanonicalUrl("http://localhost:4174", CANVAS))
      .toBe(`http://localhost:4174/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/`);
  });
});

describe("Sidekick links", () => {
  it("mints the canonical URL and deep link, and reads both back", () => {
    const url = sidekickCanonicalUrl(WEB_BASE_URL, SIDEKICK);
    expect(url).toBe(`https://rallywith.ai/app/enterprise/${ENCODED_WORKSPACE_ID}/sk/${ENCODED_SIDEKICK_ID}/`);
    expect(parseLinkTarget(url, { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "sidekick", ...SIDEKICK });
    expect(sidekickDeepLink(SIDEKICK)).toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/sidekicks/${ENCODED_SIDEKICK_ID}`);
    expect(parseLinkTarget(sidekickDeepLink(SIDEKICK), { webBaseUrl: WEB_BASE_URL })).toEqual({ kind: "sidekick", ...SIDEKICK });
    expect(parseDesktopDeepLinkIntent(sidekickDeepLink(SIDEKICK))).toEqual({ kind: "sidekick", sidekickId: SIDEKICK_ID, target: ORGANIZATION });
    expect(parseLinkPathTarget(`/app/enterprise/${ENCODED_WORKSPACE_ID}/sk/${ENCODED_SIDEKICK_ID}/a/${ENCODED_CANVAS_ID}/`)).toBeNull();
    expect(parseDesktopDeepLinkIntent(`rallywithai://sidekicks/${ENCODED_SIDEKICK_ID}`)).toBeNull();
    expect(() => sidekickCanonicalUrl(WEB_BASE_URL, { ...SIDEKICK, sidekickId: "not-a-sidekick" })).toThrow();
  });

  it("dispatches on the target's kind", () => {
    expect(linkCanonicalUrl(WEB_BASE_URL, { kind: "sidekick", ...SIDEKICK })).toBe(sidekickCanonicalUrl(WEB_BASE_URL, SIDEKICK));
    expect(linkCanonicalUrl(WEB_BASE_URL, { kind: "canvas", ...CANVAS })).toBe(canvasCanonicalUrl(WEB_BASE_URL, CANVAS));
    expect(linkDeepLink({ kind: "canvas", ...CANVAS })).toBe(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/canvases/${ENCODED_CANVAS_ID}`);
  });
});

describe("reading a shared link", () => {
  const canvasPath = `/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/`;

  it("reads a canonical link only on an origin the caller names", () => {
    expect(parseLinkTarget(`${LEGACY_WEB_BASE_URL}${canvasPath}`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    expect(parseLinkTarget(`${LEGACY_WEB_BASE_URL}${canvasPath}`, { webBaseUrl: [WEB_BASE_URL, LEGACY_WEB_BASE_URL] }))
      .toEqual({ kind: "canvas", ...CANVAS });
    expect(parseLinkTarget(`https://evil.example${canvasPath}`, { webBaseUrl: [WEB_BASE_URL, LEGACY_WEB_BASE_URL] })).toBeNull();
    expect(parseLinkTarget(`https://rallywith.ai.evil.example${canvasPath}`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    expect(parseLinkTarget(`${WEB_BASE_URL}${canvasPath}`, { webBaseUrl: [] })).toBeNull();
  });

  it("refuses a canonical link carrying a query or a fragment, and malformed input", () => {
    expect(parseLinkTarget(`${WEB_BASE_URL}${canvasPath}?token=leak`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    expect(parseLinkTarget(`${WEB_BASE_URL}${canvasPath}#x`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    expect(parseLinkTarget(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/canvases/${ENCODED_CANVAS_ID}?extra=1`, { webBaseUrl: WEB_BASE_URL })).toBeNull();
    expect(parseLinkTarget("not a url", { webBaseUrl: WEB_BASE_URL })).toBeNull();
  });

  it("no longer reads the Space, Breakout and Organization-less Thread forms", () => {
    const encoded = ENCODED_CANVAS_ID;
    for (const retired of [
      `${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${encoded}/`,
      `${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${encoded}/c/${encoded}/b/${encoded}`,
      `${WEB_BASE_URL}/app/workspaces/enterprise/${WORKSPACE_ID}/workstreams/${CANVAS_ID}/substreams/${ARTIFACT_ID}`,
      `${WEB_BASE_URL}/app/workstreams/${CANVAS_ID}`,
      `${WEB_BASE_URL}/open#${new URLSearchParams({ target: `avalon://workstreams/${CANVAS_ID}` })}`,
      `rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/spaces/${encoded}/channels/${encoded}/breakouts/${encoded}`,
      `rallywithai://workstreams/${CANVAS_ID}`,
    ]) {
      expect(parseLinkTarget(retired, { webBaseUrl: WEB_BASE_URL })).toBeNull();
      expect(parseDesktopDeepLinkIntent(retired)).toBeNull();
    }
  });

  it("reads a Thread link as the Canvas of the Thread's id, which a converted Thread kept", () => {
    const space = ENCODED_WORKSPACE_ID;
    const canvas = { kind: "canvas", ...CANVAS };
    for (const thread of [
      `${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${space}/c/${ENCODED_CANVAS_ID}`,
      `${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${space}/c/${ENCODED_CANVAS_ID}/`,
      `${WEB_BASE_URL}/app/workspaces/enterprise/${WORKSPACE_ID}/workstreams/${CANVAS_ID}`,
      `rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/spaces/${space}/channels/${ENCODED_CANVAS_ID}`,
    ]) expect(parseLinkTarget(thread, { webBaseUrl: WEB_BASE_URL })).toEqual(canvas);
    const onArtifact = { ...canvas, artifactId: ARTIFACT_ID };
    expect(parseLinkTarget(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${space}/c/${ENCODED_CANVAS_ID}/a/${uuidToBase58(ARTIFACT_ID)}`,
      { webBaseUrl: WEB_BASE_URL })).toEqual(onArtifact);
    expect(parseLinkTarget(`rallywithai://workspace/enterprise/${ENCODED_WORKSPACE_ID}/spaces/${space}/channels/${ENCODED_CANVAS_ID}/artifacts/${uuidToBase58(ARTIFACT_ID)}`,
      { webBaseUrl: WEB_BASE_URL })).toEqual(onArtifact);
    // It mints the Canvas's own forms, so the handoff page and the desktop open the Canvas.
    expect(linkCanonicalUrl(WEB_BASE_URL, parseLinkPathTarget(`/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${space}/c/${ENCODED_CANVAS_ID}`)!))
      .toBe(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/cv/${ENCODED_CANVAS_ID}/`);
    // A malformed Space segment or Thread id is no Thread link.
    expect(parseLinkPathTarget(`/app/enterprise/${ENCODED_WORKSPACE_ID}/s/not-base58/c/${ENCODED_CANVAS_ID}`)).toBeNull();
    expect(parseLinkPathTarget(`/app/workspaces/enterprise/${WORKSPACE_ID}/workstreams/not-a-uuid`)).toBeNull();
    // Thread links carried no message query.
    expect(parseLinkTarget(`${WEB_BASE_URL}/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${space}/c/${ENCODED_CANVAS_ID}?x=1`,
      { webBaseUrl: WEB_BASE_URL })).toBeNull();
  });

  it("recognizes a retired form's shape, and not a current or unrelated path", () => {
    expect(isRetiredLinkPath(`/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_CANVAS_ID}/`)).toBe(true);
    expect(isRetiredLinkPath(`/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_CANVAS_ID}/c/${ENCODED_CANVAS_ID}/b/${ENCODED_CANVAS_ID}`)).toBe(true);
    expect(isRetiredLinkPath(`/app/enterprise/${ENCODED_WORKSPACE_ID}/i/${ENCODED_CANVAS_ID}/c/${ENCODED_CANVAS_ID}`)).toBe(true);
    expect(isRetiredLinkPath(`/app/workspaces/enterprise/${WORKSPACE_ID}/workstreams/${CANVAS_ID}/substreams/${ARTIFACT_ID}`)).toBe(true);
    expect(isRetiredLinkPath(`/app/enterprise/${ENCODED_WORKSPACE_ID}/s/not-base58/c/${ENCODED_CANVAS_ID}`)).toBe(true);
    // A Thread link reads as its Canvas, so it is not retired.
    expect(isRetiredLinkPath(`/app/enterprise/${ENCODED_WORKSPACE_ID}/s/${ENCODED_WORKSPACE_ID}/c/${ENCODED_CANVAS_ID}`)).toBe(false);
    expect(isRetiredLinkPath(`/app/workspaces/enterprise/${WORKSPACE_ID}/workstreams/${CANVAS_ID}`)).toBe(false);
    expect(isRetiredLinkPath(`/app/workstreams/${CANVAS_ID}`)).toBe(true);
    expect(isRetiredLinkPath(canvasPath)).toBe(false);
    expect(isRetiredLinkPath(`/app/enterprise/${ENCODED_WORKSPACE_ID}/sk/${ENCODED_SIDEKICK_ID}/`)).toBe(false);
    expect(isRetiredLinkPath("/app/")).toBe(false);
    // The web app's own Organization shell, which an invitation to a Thread links to.
    expect(isRetiredLinkPath(`/app/workspaces/enterprise/${WORKSPACE_ID}`)).toBe(false);
    expect(isRetiredLinkPath(`/app/workspaces/enterprise/${WORKSPACE_ID}/`)).toBe(false);
    expect(isRetiredLinkPath("/help/")).toBe(false);
  });
});
