import { describe, expect, it } from "vitest";

import { renderCorePluginSystemMessage } from "./core-plugin";

const none = { currentTime: false, elicitation: false, connectorConnection: false, connectorList: false, resourceAccess: false };

describe("core plugin system message", () => {
  it("tells a loop that can show a card to offer a missing connector", () => {
    const message = renderCorePluginSystemMessage({ ...none, connectorConnection: true, connectorList: true });
    expect(message).toContain("Call list_connectors only to choose a source the person has not named");
    expect(message).toContain("Offer a missing connector only when it would clearly help");
    expect(message).toContain("otherwise by saying where in Settings to add it");
  });

  it("tells a loop whose card refuses only to read the list", () => {
    const message = renderCorePluginSystemMessage({ ...none, connectorList: true });
    expect(message).toContain("Call list_connectors");
    expect(message).not.toContain("show_connector_connection");
  });
});
