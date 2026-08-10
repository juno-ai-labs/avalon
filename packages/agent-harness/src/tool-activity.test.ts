import { describe, expect, it } from "vitest";

import { toolActivityName } from "./tool-activity";

describe("tool activity names", () => {
  it("gives Avalon-owned tools their own prose in both lifecycle states", () => {
    expect(toolActivityName({ toolName: "web_search", status: "started" }))
      .toBe("Searching the public web");
    expect(toolActivityName({ toolName: "web_search", status: "completed" }))
      .toBe("Searched the public web");
    expect(toolActivityName({ toolName: "workstream_read", status: "completed" }))
      .toBe("Read the work stream");
    expect(toolActivityName({ toolName: "table_insert_rows", status: "started" }))
      .toBe("Adding durable table rows");
  });

  it("names a connector tool after the connector that owns it", () => {
    expect(toolActivityName({
      toolName: "google_2_drive_search",
      status: "completed",
      pluginDisplayName: "Google Drive · Work",
    })).toBe("Reviewed Google Drive · Work");
    expect(toolActivityName({
      toolName: "github_1_pulls_list",
      status: "started",
      pluginDisplayName: "GitHub",
    })).toBe("Reviewing GitHub");
  });

  it("keeps Avalon prose even when a connector is somehow attributed", () => {
    expect(toolActivityName({
      toolName: "web_search",
      status: "completed",
      pluginDisplayName: "GitHub",
    })).toBe("Searched the public web");
  });

  it("reads an unrecognized unattributed tool as a phrase rather than a symbol", () => {
    expect(toolActivityName({ toolName: "memory_prune", status: "completed" }))
      .toBe("Memory prune");
    expect(toolActivityName({ toolName: "", status: "completed" })).toBe("Ran a tool");
  });

  it("treats a blank connector name as no attribution", () => {
    expect(toolActivityName({
      toolName: "custom_thing",
      status: "completed",
      pluginDisplayName: "   ",
    })).toBe("Custom thing");
  });
});
