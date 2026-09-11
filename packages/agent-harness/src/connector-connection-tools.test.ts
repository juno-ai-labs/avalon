import { describe, expect, it } from "vitest";

import {
  AVALON_GET_CONNECTOR_CONNECTION_STATE_TOOL_DEFINITION,
  AVALON_SHOW_CONNECTOR_CONNECTION_TOOL_DEFINITION,
} from "./index";

describe("connector connection tool guidance", () => {
  it("gives the model explicit names, parameters, states, and tool order", () => {
    const check = AVALON_GET_CONNECTOR_CONNECTION_STATE_TOOL_DEFINITION;
    const show = AVALON_SHOW_CONNECTOR_CONNECTION_TOOL_DEFINITION;

    expect(check.name).toBe("get_connector_connection_state");
    expect(show.name).toBe("show_connector_connection");
    expect(check.description).toContain("Call this first.");
    expect(check.description).toContain("connected, reconnect_required, not_connected, or unavailable");
    expect(check.description).toContain("core_show_connector_connection with the same connectorId and scope");
    expect(show.description).toContain("Call only after core_get_connector_connection_state returns");
    expect(show.description).toContain("Use the same connectorId and scope.");
    expect(show.description).toContain("do not claim the connector is connected");
  });

  it("describes both shared parameters in direct product language", () => {
    const schema = AVALON_GET_CONNECTOR_CONNECTION_STATE_TOOL_DEFINITION.inputSchema as {
      additionalProperties?: unknown;
      properties?: Record<string, { description?: string }>;
      required?: string[];
    };

    expect(schema.required).toEqual(["connectorId", "scope"]);
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties?.connectorId?.description)
      .toContain("Personal only: google-mail-calendar, granola.");
    expect(schema.properties?.scope?.description)
      .toBe("Use personal for the current user's account. Use workspace only for an id described as personal or workspace.");
    expect(AVALON_SHOW_CONNECTOR_CONNECTION_TOOL_DEFINITION.inputSchema).toEqual(schema);
  });
});
