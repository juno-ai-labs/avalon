import { describe, expect, it } from "vitest";

import { toolResultMessage } from "@juno-ai/bind/plugins";
import { readStructuredFailure } from "@avalon/contracts";
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
    // Named for its object rather than its verb, and still not the generic row.
    expect(toolActivityName({ toolName: "google_2_gmail_find_contacts", status: "started", plugin: drive }))
      .toBe("Looking up contacts in Google Drive · Work");
    expect(toolActivityName({ toolName: "google_2_gmail_read_profile", status: "completed", plugin: drive }))
      .toBe("Checked the connected account on Google Drive · Work");
    // Composing a draft is a write; the generic row read as a review of it.
    expect(toolActivityName({ toolName: "google_2_gmail_create_draft", status: "completed", plugin: drive }))
      .toBe("Drafted in Google Drive · Work");
    // Slack's `read_user_profile` ends in `profile` too. A leaf-keyed entry for
    // the Gmail tool would label somebody else's Slack profile as the
    // connected account, so these are keyed on the whole action path.
    expect(toolActivityName({
      toolName: "slack_1_read_user_profile",
      status: "completed",
      plugin: { pluginId: "plugin_slack_1", displayName: "Slack" },
    })).toBe("Reviewed Slack");
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

  it("puts a failed tool's structured remediation somewhere the model actually reads", () => {
    // `toolResultMessage` serializes only the failure variant's declared
    // fields, so extra keys spread onto the result object are dropped without a
    // type error. `data` is the declared slot, and asserting on the encoded
    // message rather than the object is what distinguishes the two.
    const structured = readStructuredFailure(
      Object.assign(new Error("Wrong id family"), {
        code: "invalid_payload",
        details: { reason: "wrong_id_family", field: "messageId" },
      }),
    );
    const encoded = toolResultMessage("call-1", {
      success: false,
      kind: "external",
      error: "Wrong id family",
      ...(structured ? { data: structured } : {}),
    });
    const content = JSON.parse(String(encoded.content)) as Record<string, unknown>;
    expect(content).toMatchObject({
      success: false,
      data: { code: "invalid_payload", details: { reason: "wrong_id_family", field: "messageId" } },
    });
  });
});
