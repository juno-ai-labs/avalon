import { describe, expect, it } from "vitest";

import { hasAvalonToolProse, toolActivityName } from "./tool-activity";

const drive = { pluginId: "plugin_google_2", displayName: "Google Drive · Work" };
const github = { pluginId: "plugin_github_1", displayName: "GitHub" };

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

  it("covers the sub-agent and discovery tools under their real wire names", () => {
    // `run_subagent` is installed on the workstream plugin, so the name that
    // reaches a row is prefixed; the discovery tools are injected unprefixed.
    expect(toolActivityName({ toolName: "workstream_run_subagent", status: "completed" }))
      .toBe("Ran a focused sub-agent");
    expect(toolActivityName({ toolName: "list_plugins", status: "completed" }))
      .toBe("Checked available plugins");
    expect(toolActivityName({ toolName: "search_plugins", status: "started" }))
      .toBe("Searching connected plugins");
    expect(toolActivityName({ toolName: "load_plugin", status: "completed" }))
      .toBe("Loaded a plugin");
    expect(hasAvalonToolProse("run_subagent")).toBe(false);
    expect(hasAvalonToolProse("workstream_run_subagent")).toBe(true);
  });

  it("names a connector row after the action, not just the connector", () => {
    expect(toolActivityName({ toolName: "google_2_drive_search", status: "completed", plugin: drive }))
      .toBe("Searched Google Drive · Work");
    expect(toolActivityName({ toolName: "google_2_drive_search", status: "started", plugin: drive }))
      .toBe("Searching Google Drive · Work");
    expect(toolActivityName({ toolName: "google_2_drive_download", status: "completed", plugin: drive }))
      .toBe("Downloaded from Google Drive · Work");
    expect(toolActivityName({ toolName: "google_2_docs_append", status: "completed", plugin: drive }))
      .toBe("Appended to Google Drive · Work");
  });

  it("does not describe a connector write as a read", () => {
    expect(toolActivityName({ toolName: "github_1_issues_create", status: "completed", plugin: github }))
      .toBe("Created in GitHub");
    expect(toolActivityName({ toolName: "github_1_issues_create", status: "started", plugin: github }))
      .toBe("Creating in GitHub");
    expect(toolActivityName({
      toolName: "google_2_gmail_send",
      status: "completed",
      plugin: drive,
    })).toBe("Sent through Google Drive · Work");
  });

  it("falls back to the connector alone when the action is unrecognized", () => {
    expect(toolActivityName({ toolName: "github_1_graphql_passthrough", status: "completed", plugin: github }))
      .toBe("Reviewed GitHub");
    expect(toolActivityName({ toolName: "github_1_graphql_passthrough", status: "started", plugin: github }))
      .toBe("Reviewing GitHub");
  });

  it("keeps Avalon prose even when a connector is somehow attributed", () => {
    expect(toolActivityName({ toolName: "web_search", status: "completed", plugin: github }))
      .toBe("Searched the public web");
  });

  it("never words a failed row as success", () => {
    expect(toolActivityName({ toolName: "web_search", status: "failed" }))
      .toBe("Could not search the public web");
    expect(toolActivityName({ toolName: "workstream_create_artifact", status: "failed" }))
      .toBe("Could not create an artifact");
    // One wording for reads and writes alike: the call never reached the provider.
    expect(toolActivityName({ toolName: "github_1_issues_create", status: "failed", plugin: github }))
      .toBe("Could not reach GitHub");
    expect(toolActivityName({ toolName: "memory_prune", status: "failed" }))
      .toBe("Memory prune failed");
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
      plugin: { pluginId: "plugin_custom", displayName: "   " },
    })).toBe("Custom thing");
  });
});
