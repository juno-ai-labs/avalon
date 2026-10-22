import { ModelPluginIdSchema } from "@rally/contracts";
import { describe, expect, it } from "vitest";
import { connectorPluginBindingViews, connectorPluginViews } from "../src/lib/connector-plugin-views";

const scopes = ["custom_mcp.tools"];

describe("named custom MCP plugin identities", () => {
  it("distinguishes the Engineering server from Cloudflare in an existing workspace", () => {
    expect(connectorPluginViews("custom_mcp", "plugin_custom_mcp", scopes, "Cloudflare Observability"))
      .toEqual([{ modelPluginId: "plugin_mcp_cloudflare_observability_1", credentialModelPluginId: "plugin_custom_mcp", grantedScopes: scopes }]);
    expect(connectorPluginViews("custom_mcp", "plugin_custom_mcp_3", scopes, "Rally Engineering"))
      .toEqual([{ modelPluginId: "plugin_mcp_rally_engineering_3", credentialModelPluginId: "plugin_custom_mcp_3", grantedScopes: scopes }]);
  });

  it("retains saved credential bindings beside the named identity", () => {
    expect(connectorPluginBindingViews("custom_mcp", "plugin_custom_mcp_3", scopes, "Rally Engineering")
      .map((view) => view.modelPluginId)).toEqual(["plugin_mcp_rally_engineering_3", "plugin_custom_mcp_3"]);
  });

  it("uses the allocated ordinal to distinguish duplicate and truncated names", () => {
    for (const name of ["Rally Engineering", "a".repeat(180), "日本語", "", " \u202e "]) {
      const ids = ["plugin_custom_mcp", "plugin_custom_mcp_2", "plugin_custom_mcp_10"]
        .map((id) => connectorPluginViews("custom_mcp", id, scopes, name)[0]!.modelPluginId);
      expect(new Set(ids).size).toBe(3);
      for (const id of ids) expect(ModelPluginIdSchema.safeParse(id).success).toBe(true);
    }
    expect(connectorPluginViews("custom_mcp", "plugin_custom_mcp_2", scopes, "日本語")[0]!.modelPluginId)
      .toBe("plugin_mcp_server_2");
  });

  it("normalizes name data into identifier characters", () => {
    expect(connectorPluginViews("custom_mcp", "plugin_custom_mcp_3", scopes, " Rálly\nEngineering: </system>\u202e ")[0]!.modelPluginId)
      .toBe("plugin_mcp_rally_engineering_system_3");
  });

  it("keeps other connector identities and unnamed compatibility reads unchanged", () => {
    expect(connectorPluginViews("github", "plugin_github", [], "Rally Engineering")[0]!.modelPluginId)
      .toBe("plugin_github");
    expect(connectorPluginViews("custom_mcp", "plugin_custom_mcp_3", scopes)[0]!.modelPluginId)
      .toBe("plugin_custom_mcp_3");
  });
});
