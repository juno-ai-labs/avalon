import { describe, expect, it } from "vitest";
import { ConnectorConnectionCardCatalog } from "@rally/contracts";

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
    // Two independent facts, because reading the split back off the same
    // catalog the sentence is built from asserts nothing: a wrong scope would
    // move the id in the description and in the expectation together.
    //
    // The first is the product's, stated here: these connectors offer no
    // workspace connection card, and adding one to the other side is a product
    // decision that should fail a test rather than rewrite one silently.
    const connectorIds = schema.properties?.connectorId?.description ?? "";
    expect(connectorIds).toBe(
      "Connector to check or show."
      + " Personal only: google-mail-calendar, ashby, fireflies, granola."
      + " Personal or workspace: google-drive-workspace, github, linear, slack, notion.",
    );
    // The second is that the sentence keeps naming every id the catalog holds,
    // so a connector added there cannot be quietly missing from what the model
    // is told it may ask for.
    for (const id of Object.keys(ConnectorConnectionCardCatalog)) {
      expect(connectorIds, id).toContain(id);
    }
    expect(schema.properties?.scope?.description)
      .toBe("Use personal for the current user's account. Use workspace only for an id described as personal or workspace.");
    expect(AVALON_SHOW_CONNECTOR_CONNECTION_TOOL_DEFINITION.inputSchema).toEqual(schema);
  });
});
