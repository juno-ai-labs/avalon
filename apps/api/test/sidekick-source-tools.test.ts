import { describe, expect, it } from "vitest";

import { sidekickSourceRequestCard } from "../src/services/sidekick-source-tools";

const SIDEKICK = "00000000-0000-7000-8000-00000000aa01";
const REQUEST = "00000000-0000-7000-8000-00000000aa02";
const asked = {
  sidekickId: SIDEKICK,
  requests: [{
    requestId: REQUEST, sidekickId: SIDEKICK, sidekickName: "Deals",
    person: { userId: "00000000-0000-7000-8000-00000000aa03", displayName: "Jane Doe" },
    connectorType: "google", eventTypes: ["email.received"], condition: "The email is about a pre-seed round.",
    state: "pending", requestedByName: "Adam", yours: false, createdAt: 1, decidedAt: null,
  }],
};

describe("what an ask for sources leaves in the transcript", () => {
  it("is the request ids alone: never the asker's view of who was asked or for what", () => {
    expect(sidekickSourceRequestCard({ pluginId: "rally:sidekicks", canonicalToolName: "request_source", output: asked }))
      .toEqual({ sidekickId: SIDEKICK, requests: [{ requestId: REQUEST }] });
    // A recovered receipt names the tool by its wire name.
    expect(sidekickSourceRequestCard({ pluginId: "rally:sidekicks", canonicalToolName: "sidekick_request_source", output: asked }))
      .toEqual({ sidekickId: SIDEKICK, requests: [{ requestId: REQUEST }] });
  });

  it("is nothing for any other tool, another plugin's tool of that name, or an output that names no request", () => {
    expect(sidekickSourceRequestCard({ pluginId: "rally:sidekicks", canonicalToolName: "sources_list", output: asked })).toBeNull();
    expect(sidekickSourceRequestCard({ pluginId: "plugin_custom", canonicalToolName: "request_source", output: asked })).toBeNull();
    expect(sidekickSourceRequestCard({ pluginId: "rally:sidekicks", canonicalToolName: "request_source", output: { sidekickId: SIDEKICK, requests: [] } }))
      .toBeNull();
    expect(sidekickSourceRequestCard({ pluginId: "rally:sidekicks", canonicalToolName: "request_source", output: "Asked one person" })).toBeNull();
  });
});
