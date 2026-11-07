import { describe, expect, it } from "vitest";

import { toolResultMessage } from "@juno-ai/bind/plugins";
import { readStructuredFailure } from "@rally/contracts";
import { hasAvalonToolProse, toolActivityName } from "./tool-activity";

const drive = { pluginId: "plugin_google_2", displayName: "Google Drive · Work" };
const github = { pluginId: "plugin_github_1", displayName: "GitHub" };

describe("tool activity names", () => {
  it("names browser work from its call title throughout the lifecycle", () => {
    for (const status of ["started", "completed"] as const) {
      expect(toolActivityName({ toolName: "browser_js", status, arguments: { title: "Find conversation data" } }))
        .toBe("Find conversation data");
    }
    expect(toolActivityName({ toolName: "browser_js", status: "failed", arguments: { title: "Read messages" } }))
      .toBe("Could not complete: Read messages");
    expect(toolActivityName({ toolName: "browser_js", status: "completed", arguments: { title: "  " } }))
      .toBe("Used the browser");
  });
  it("gives Avalon-owned tools their own prose in both lifecycle states", () => {
    expect(toolActivityName({ toolName: "web_search", status: "started" }))
      .toBe("Searching the public web");
    expect(toolActivityName({ toolName: "web_search", status: "completed" }))
      .toBe("Searched the public web");
    expect(toolActivityName({ toolName: "list_resources", status: "completed" }))
      .toBe("Listed attached resources");
    expect(hasAvalonToolProse("workstream_read")).toBe(false);
    expect(toolActivityName({ toolName: "search_resource", status: "started" }))
      .toBe("Searching an attached resource");
    expect(toolActivityName({ toolName: "view_resource", status: "completed" }))
      .toBe("Viewed attached images");
    expect(toolActivityName({ toolName: "summarize_resource", status: "completed" }))
      .toBe("Summarized an attached resource");
    expect(toolActivityName({ toolName: "table_insert_rows", status: "started" }))
      .toBe("Adding durable table rows");
  });

  it("covers the sub-agent and discovery tools under their real wire names", () => {
    // `rally:workstream` now advertises `run_subagent` unprefixed, and rows
    // written before that still hold `workstream_run_subagent`. The discovery
    // tools were always injected unprefixed.
    expect(toolActivityName({ toolName: "run_subagent", status: "completed" }))
      .toBe("Ran a focused sub-agent");
    expect(toolActivityName({ toolName: "workstream_run_subagent", status: "completed" }))
      .toBe("Ran a focused sub-agent");
    expect(toolActivityName({ toolName: "list_plugins", status: "completed" }))
      .toBe("Checked available plugins");
    expect(toolActivityName({ toolName: "search_plugins", status: "started" }))
      .toBe("Searching connected plugins");
    expect(toolActivityName({ toolName: "load_plugin", status: "completed" }))
      .toBe("Loaded a plugin");
    expect(hasAvalonToolProse("run_subagent")).toBe(true);
    expect(hasAvalonToolProse("workstream_run_subagent")).toBe(true);
    // A name neither spelling produces still has none.
    expect(hasAvalonToolProse("workstream_read")).toBe(false);
    expect(hasAvalonToolProse("subagent_run")).toBe(false);
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
    // connected account, so these are keyed on the whole action path — and this
    // one takes its verb from the name instead of the object map.
    expect(toolActivityName({
      toolName: "slack_1_read_user_profile",
      status: "completed",
      plugin: { pluginId: "plugin_slack_1", displayName: "Slack" },
    })).toBe("Read Slack");
  });

  it("finds the verb wherever a connector puts it in the name", () => {
    const slack = { pluginId: "plugin_slack_1", displayName: "Slack" };
    const google = { pluginId: "plugin_google_2", displayName: "Google" };

    // Verb first, which is how five of the seven connectors name a tool.
    expect(toolActivityName({ toolName: "slack_1_send_message", status: "completed", plugin: slack }))
      .toBe("Sent through Slack");
    expect(toolActivityName({ toolName: "slack_1_search_messages", status: "completed", plugin: slack }))
      .toBe("Searched Slack");
    // Verb in the middle, behind an area prefix. This is the shape that hid
    // longest: the name neither starts nor ends with its verb.
    expect(toolActivityName({ toolName: "google_2_calendar_create_event", status: "completed", plugin: google }))
      .toBe("Created in Google");
    expect(toolActivityName({ toolName: "google_2_sheets_update_values", status: "completed", plugin: google }))
      .toBe("Updated in Google");
    // Both segments are verbs; the trailing one is the better label.
    expect(toolActivityName({ toolName: "slack_1_create_comment", status: "completed", plugin: slack }))
      .toBe("Commented in Slack");
    // Nothing in the name is a verb, so the generic row is still reachable.
    expect(toolActivityName({ toolName: "slack_1_channel_topic", status: "completed", plugin: slack }))
      .toBe("Reviewed Slack");
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
    expect(toolActivityName({ toolName: "read_resource", status: "failed" }))
      .toBe("Could not read an attached resource");
    // One wording for reads and writes alike: the call never reached the provider.
    expect(toolActivityName({ toolName: "github_1_issues_create", status: "failed", plugin: github }))
      .toBe("Could not reach GitHub");
    expect(toolActivityName({ toolName: "memory_prune", status: "failed" }))
      .toBe("Memory prune failed");
  });

  it("words a core tool the same under its current and its retired wire name", () => {
    // `rally:core` dropped its `core_` wire prefix; every row written before
    // that still stores the prefixed name and is worded from it on every read.
    expect(toolActivityName({ toolName: "current_time", status: "completed" }))
      .toBe("Checked the current time");
    expect(toolActivityName({ toolName: "core_current_time", status: "completed" }))
      .toBe("Checked the current time");
    expect(toolActivityName({ toolName: "request_elicitation", status: "started" }))
      .toBe("Asking for a decision");
    expect(toolActivityName({ toolName: "core_request_elicitation", status: "started" }))
      .toBe("Asking for a decision");
    expect(toolActivityName({ toolName: "show_connector_connection", status: "completed" }))
      .toBe("Prepared a connector");
    expect(toolActivityName({ toolName: "core_show_connector_connection", status: "completed" }))
      .toBe("Prepared a connector");
    expect(toolActivityName({ toolName: "get_connector_connection_state", status: "failed" }))
      .toBe("Could not check a connector's connection");
    expect(toolActivityName({ toolName: "core_get_connector_connection_state", status: "failed" }))
      .toBe("Could not check a connector's connection");
  });

  it("words a Terminal row the same under its current and its retired wire name", () => {
    // `rally:terminal` dropped its `terminal_` prefix too, and had no prose at
    // all before that: every row rendered the humanized wire name.
    expect(toolActivityName({ toolName: "run_command", status: "started" }))
      .toBe("Running a command");
    expect(toolActivityName({ toolName: "terminal_run_command", status: "started" }))
      .toBe("Running a command");
    expect(toolActivityName({ toolName: "publish_resource", status: "completed" }))
      .toBe("Published an artifact");
    expect(toolActivityName({ toolName: "terminal_publish_resource", status: "completed" }))
      .toBe("Published an artifact");
    expect(toolActivityName({ toolName: "checkout_repository", status: "failed" }))
      .toBe("Could not check out a repository");
    expect(toolActivityName({ toolName: "terminal_checkout_repository", status: "failed" }))
      .toBe("Could not check out a repository");
  });

  it("words the image view as looking, not as reading a file", () => {
    expect(toolActivityName({ toolName: "view_image", status: "started" })).toBe("Looking at an image");
    expect(toolActivityName({ toolName: "view_image", status: "completed" })).toBe("Looked at an image");
    expect(toolActivityName({ toolName: "view_image", status: "failed" })).toBe("Could not look at an image");
  });

  it("words a work stream row the same under its current and its retired wire name", () => {
    for (const [current, retired] of [
      ["list_resources", "workstream_list_resources"],
      ["read_resource", "workstream_read_resource"],
      ["schedule_wakeup", "workstream_schedule_wakeup"],
      ["run_subagent", "workstream_run_subagent"],
    ]) {
      for (const status of ["started", "completed", "failed"] as const) {
        expect(toolActivityName({ toolName: retired!, status }))
          .toBe(toolActivityName({ toolName: current!, status }));
      }
    }
  });

  it("words the Sidekick, agent and generation rows under both spellings", () => {
    expect(toolActivityName({ toolName: "post_result", status: "completed" }))
      .toBe("Posted the result to the conversation");
    expect(toolActivityName({ toolName: "sidekick_post_result", status: "completed" }))
      .toBe("Posted the result to the conversation");
    expect(toolActivityName({ toolName: "conversation_post", status: "completed" }))
      .toBe("Posted to a conversation");
    expect(toolActivityName({ toolName: "conversation_merge", status: "completed" }))
      .toBe("Merged the result");
    expect(toolActivityName({ toolName: "conversation_search", status: "started" }))
      .toBe("Searching conversations");
    // `send_message` is the agent tool whose bare name still does not say who it
    // reaches, so the row says it for it.
    expect(toolActivityName({ toolName: "send_message", status: "completed" }))
      .toBe("Messaged a teammate");
    expect(toolActivityName({ toolName: "agents_send_message", status: "completed" }))
      .toBe("Messaged a teammate");
    // `reply_to_message` was `reply`, so its rows carry `agents_reply` rather
    // than the `agents_`-plus-current-name the other tools' rows carry.
    expect(toolActivityName({ toolName: "reply_to_message", status: "started" }))
      .toBe("Replying to a teammate");
    expect(toolActivityName({ toolName: "agents_reply", status: "started" }))
      .toBe("Replying to a teammate");
    expect(toolActivityName({ toolName: "generate_image", status: "completed" }))
      .toBe("Generated an image");
    expect(toolActivityName({ toolName: "multimodal_generation_generate_image", status: "completed" }))
      .toBe("Generated an image");
    expect(toolActivityName({ toolName: "generate_audio", status: "failed" }))
      .toBe("Could not generate a voice recording");
  });

  it("keeps wording rows a retired tool already wrote", () => {
    // `workstream_create_artifact` no longer exists, but the rows it wrote do,
    // and they are worded from the stored name every time they are read.
    expect(toolActivityName({ toolName: "workstream_create_artifact", status: "completed" }))
      .toBe("Created an artifact");
    expect(toolActivityName({ toolName: "workstream_create_artifact", status: "failed" }))
      .toBe("Could not create an artifact");
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
