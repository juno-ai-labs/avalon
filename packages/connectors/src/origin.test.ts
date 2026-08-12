import { describe, expect, it, vi } from "vitest";

import {
  authorizedConnection,
  connectorOriginFromActivity,
  connectorOriginUrl,
  describeConnectorOrigin,
  ConnectorError,
  type AuthorizedConnectorConnection,
  type ConnectorAdapter,
  type ConnectorOriginSource,
} from "./types";

/**
 * The connector half of a work-stream origin: any connector can say where the
 * thing it produced lives, and the base derives that for free from an activity
 * so a connector only writes code for the places an activity cannot describe.
 * See `docs/workstream-origin-attachments.md`.
 */
describe("connector origins", () => {
  it("derives an origin from any connector's activity, with no adapter code", async () => {
    expect(await describeConnectorOrigin(adapter(), {
      kind: "activity",
      activity: {
        resourceType: "linear_issue",
        providerResourceId: "ISS-42",
        title: "Assigned ISS-42",
        metadata: { url: "https://linear.app/avalon/issue/ISS-42" },
      },
    })).toEqual({
      resourceType: "linear_issue",
      providerResourceId: "ISS-42",
      title: "Assigned ISS-42",
      canonicalUrl: "https://linear.app/avalon/issue/ISS-42",
      metadata: { url: "https://linear.app/avalon/issue/ISS-42" },
    });
  });

  it("declines an activity that names no provider object to point at", () => {
    expect(connectorOriginFromActivity({
      resourceType: "slack_message",
      providerResourceId: null,
      title: "Someone reacted",
    })).toBeNull();
  });

  it("takes whichever link key the provider happens to use", () => {
    expect(connectorOriginUrl({ htmlUrl: "https://github.com/a/b/pull/1" }))
      .toBe("https://github.com/a/b/pull/1");
    expect(connectorOriginUrl({ url: "not-a-link" })).toBeNull();
    expect(connectorOriginUrl(undefined)).toBeNull();
  });

  it("has nothing to say about a session kind the connector does not implement", async () => {
    expect(await describeConnectorOrigin(adapter(), {
      kind: "agent_session",
      session: { anything: true },
    })).toBeNull();
  });

  it("prefers the connector's own description over the derived one", async () => {
    // A connector whose activity names a message may want the thread it is in,
    // which is the place a person would go back to.
    const origin = await describeConnectorOrigin(
      adapter({
        describe: (locator) => locator.kind === "activity"
          ? { resourceType: "test_thread", providerResourceId: "C1:1.1", title: "Thread" }
          : null,
      }),
      {
        kind: "activity",
        activity: { resourceType: "test_message", providerResourceId: "C1:2.2", title: "Message" },
      },
    );

    expect(origin).toMatchObject({ resourceType: "test_thread", providerResourceId: "C1:1.1" });
  });

  it("refuses a described resource type the connector never declared", async () => {
    // The manifest is the connector's own enumeration of what it produces, so a
    // type absent from it is a typo rather than a new capability — and a typo
    // here silently forks the resource identity for every work stream after it.
    await expect(describeConnectorOrigin(
      adapter({
        describe: () => ({ resourceType: "test_thred", providerResourceId: "C1:1.1", title: "Thread" }),
      }),
      { kind: "agent_session", session: {} },
    )).rejects.toBeInstanceOf(ConnectorError);
  });

  it("does not hold a derived type against the manifest", async () => {
    // It came out of this connector's own normalization, so the connector has
    // already vouched for it; rejecting it would drop attachments over a
    // manifest that had drifted rather than over a real mistake.
    expect(await describeConnectorOrigin(adapter(), {
      kind: "activity",
      activity: { resourceType: "test_undeclared", providerResourceId: "X1", title: "Something" },
    })).toMatchObject({ resourceType: "test_undeclared" });
  });

  it("lets a connector fetch the URL only the provider can give", async () => {
    const resolveCanonicalUrl = vi.fn(async () => "https://example.slack.com/archives/C1/p11");

    expect(await describeConnectorOrigin(
      adapter({
        describe: () => ({ resourceType: "test_thread", providerResourceId: "C1:1.1", title: "Thread" }),
        resolveCanonicalUrl,
      }),
      { kind: "agent_session", session: {} },
      { connection: connection(), signal: AbortSignal.timeout(1_000) },
    )).toMatchObject({ canonicalUrl: "https://example.slack.com/archives/C1/p11" });
    expect(resolveCanonicalUrl).toHaveBeenCalledOnce();
  });

  it("does not pay for a provider call when the description already has a link", async () => {
    const resolveCanonicalUrl = vi.fn(async () => "https://example.com/other");

    await describeConnectorOrigin(
      adapter({
        describe: () => ({
          resourceType: "test_thread",
          providerResourceId: "C1:1.1",
          title: "Thread",
          canonicalUrl: "https://example.com/known",
        }),
        resolveCanonicalUrl,
      }),
      { kind: "agent_session", session: {} },
      { connection: connection(), signal: AbortSignal.timeout(1_000) },
    );

    expect(resolveCanonicalUrl).not.toHaveBeenCalled();
  });

  it("keeps the origin when the provider will not give up the URL", async () => {
    // An origin that records *which* thread but cannot link to it is still the
    // only record of where the work stream came from; losing it to a timeout
    // would be the worse trade.
    expect(await describeConnectorOrigin(
      adapter({
        describe: () => ({ resourceType: "test_thread", providerResourceId: "C1:1.1", title: "Thread" }),
        resolveCanonicalUrl: async () => {
          throw new ConnectorError("provider_error", "Slack is unavailable");
        },
      }),
      { kind: "agent_session", session: {} },
      { connection: connection(), signal: AbortSignal.timeout(1_000) },
    )).toMatchObject({ providerResourceId: "C1:1.1", canonicalUrl: null });
  });

  it("skips the provider call when the caller holds no authorized connection", async () => {
    const resolveCanonicalUrl = vi.fn(async () => "https://example.com/link");

    expect(await describeConnectorOrigin(
      adapter({
        describe: () => ({ resourceType: "test_thread", providerResourceId: "C1:1.1", title: "Thread" }),
        resolveCanonicalUrl,
      }),
      { kind: "agent_session", session: {} },
    )).toMatchObject({ canonicalUrl: null });
    expect(resolveCanonicalUrl).not.toHaveBeenCalled();
  });
});

function adapter(origin?: ConnectorOriginSource): Pick<ConnectorAdapter, "manifest" | "origin"> {
  return {
    manifest: {
      type: "test",
      resourceTypes: ["test_thread", "test_message"],
    } as ConnectorAdapter["manifest"],
    ...(origin ? { origin } : {}),
  };
}

function connection(): AuthorizedConnectorConnection {
  return authorizedConnection({
    id: "connection-1",
    workspaceId: "workspace-1",
    scope: "workspace",
    ownerUserId: null,
    grantedScopes: [],
    credentials: { botAccessToken: "xoxb-token" },
    cursor: {},
    config: {},
  });
}
