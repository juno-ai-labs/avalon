import {
  CONNECTOR_CONNECTION_CARD_WIRE_NAME,
  CONNECTOR_CONNECTION_STATE_WIRE_NAME,
  LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME,
  LEGACY_CONNECTOR_CONNECTION_STATE_WIRE_NAME,
} from "@rally/contracts";

/**
 * Transcript rows name what a tool did, not which wire symbol was called. Every
 * chat surface renders the same row component, so every surface has to get its
 * prose from here rather than falling back to a raw tool name.
 */

export type ToolActivityStatus = "started" | "completed" | "failed";

type ToolProse = { started: string; settled: string; failed: string };

// Shared by a tool's current wire name and the prefixed one it used to carry.
const CURRENT_TIME_PROSE: ToolProse = {
  started: "Checking the current time",
  settled: "Checked the current time",
  failed: "Could not check the current time",
};
const REQUEST_ELICITATION_PROSE: ToolProse = {
  started: "Asking for a decision",
  settled: "Asked for a decision",
  failed: "Could not ask for a decision",
};
const CONNECTOR_CONNECTION_STATE_PROSE: ToolProse = {
  started: "Checking a connector's connection",
  settled: "Checked a connector's connection",
  failed: "Could not check a connector's connection",
};
const CONNECTOR_CONNECTION_CARD_PROSE: ToolProse = {
  started: "Preparing a connector",
  settled: "Prepared a connector",
  failed: "Could not prepare a connector",
};

// `rally:sidekick-result` is gone; `conversation_post` replaced it. Its rows
// already in transcripts keep their wording until those rows are removed.
const SIDEKICK_POST_RESULT_PROSE: ToolProse = {
  started: "Posting the result to the work stream",
  settled: "Posted the result to the work stream",
  failed: "Could not post the result to the work stream",
};

/** `rally:conversations`, whose wire names carry the `conversation_` prefix. */
const CONVERSATION_PROSE: Record<string, ToolProse> = {
  conversation_list: {
    started: "Looking for conversations",
    settled: "Looked for conversations",
    failed: "Could not look for conversations",
  },
  conversation_list_next: {
    started: "Looking for more conversations",
    settled: "Looked for more conversations",
    failed: "Could not look for more conversations",
  },
  conversation_read: {
    started: "Reading a conversation",
    settled: "Read a conversation",
    failed: "Could not read a conversation",
  },
  conversation_read_next: {
    started: "Reading earlier messages",
    settled: "Read earlier messages",
    failed: "Could not read earlier messages",
  },
  conversation_search: {
    started: "Searching conversations",
    settled: "Searched conversations",
    failed: "Could not search conversations",
  },
  conversation_post: {
    started: "Posting to a conversation",
    settled: "Posted to a conversation",
    failed: "Could not post to a conversation",
  },
  conversation_merge: {
    started: "Merging the result",
    settled: "Merged the result",
    failed: "Could not merge the result",
  },
  conversation_attach: {
    started: "Attaching a conversation",
    settled: "Attached a conversation",
    failed: "Could not attach a conversation",
  },
};

const AGENT_PROSE: Record<string, ToolProse> = {
  sidekicks_list: {
    started: "Looking for Sidekicks",
    settled: "Looked for Sidekicks",
    failed: "Could not look for Sidekicks",
  },
  create_sidekick: {
    started: "Creating a Sidekick",
    settled: "Created a Sidekick",
    failed: "Could not create a Sidekick",
  },
  start_agent: {
    started: "Delegating to a background agent",
    settled: "Delegated to a background agent",
    failed: "Could not delegate to a background agent",
  },
  list_agents: {
    started: "Looking for teammates",
    settled: "Looked for teammates",
    failed: "Could not look for teammates",
  },
  // These name the addressee, because the bare tool names do not: a row reading
  // "Sent a message" beside a Slack icon would be the wrong account.
  send_message: {
    started: "Messaging a teammate",
    settled: "Messaged a teammate",
    failed: "Could not message a teammate",
  },
  reply_to_message: {
    started: "Replying to a teammate",
    settled: "Replied to a teammate",
    failed: "Could not reply to a teammate",
  },
  stop_agent: {
    started: "Stopping a background agent",
    settled: "Stopped a background agent",
    failed: "Could not stop a background agent",
  },
};

const WORKSTREAM_PROSE: Record<string, ToolProse> = {
  read_resource: {
    started: "Reading an attached resource",
    settled: "Read an attached resource",
    failed: "Could not read an attached resource",
  },
  list_resources: {
    started: "Listing attached resources",
    settled: "Listed attached resources",
    failed: "Could not list attached resources",
  },
  describe_artifact_data: {
    started: "Looking at what the site has collected",
    settled: "Looked at what the site has collected",
    failed: "Could not read what the site has collected",
  },
  query_artifact_data: {
    started: "Reading the site's data",
    settled: "Read the site's data",
    failed: "Could not read the site's data",
  },
  search_resource: {
    started: "Searching an attached resource",
    settled: "Searched an attached resource",
    failed: "Could not search an attached resource",
  },
  view_resource: {
    started: "Viewing attached images",
    settled: "Viewed attached images",
    failed: "Could not view attached images",
  },
  summarize_resource: {
    started: "Summarizing an attached resource",
    settled: "Summarized an attached resource",
    failed: "Could not summarize an attached resource",
  },
  schedule_wakeup: {
    started: "Scheduling a wake-up",
    settled: "Scheduled a wake-up",
    failed: "Could not schedule a wake-up",
  },
  list_wakeups: {
    started: "Checking scheduled wake-ups",
    settled: "Checked scheduled wake-ups",
    failed: "Could not check scheduled wake-ups",
  },
  cancel_wakeup: {
    started: "Cancelling a wake-up",
    settled: "Cancelled a wake-up",
    failed: "Could not cancel a wake-up",
  },
  run_subagent: {
    started: "Running a focused sub-agent",
    settled: "Ran a focused sub-agent",
    failed: "Could not run a focused sub-agent",
  },
};

const MULTIMODAL_GENERATION_PROSE: Record<string, ToolProse> = {
  generate_image: {
    started: "Generating an image",
    settled: "Generated an image",
    failed: "Could not generate an image",
  },
  edit_image: {
    started: "Editing an image",
    settled: "Edited an image",
    failed: "Could not edit an image",
  },
  generate_audio: {
    started: "Generating a voice recording",
    settled: "Generated a voice recording",
    failed: "Could not generate a voice recording",
  },
};

const TERMINAL_PROSE: Record<string, ToolProse> = {
  read_file: {
    started: "Reading a file",
    settled: "Read a file",
    failed: "Could not read a file",
  },
  view_image: {
    started: "Looking at an image",
    settled: "Looked at an image",
    failed: "Could not look at an image",
  },
  edit_file: {
    started: "Editing a file",
    settled: "Edited a file",
    failed: "Could not edit a file",
  },
  write_file: {
    started: "Writing a file",
    settled: "Wrote a file",
    failed: "Could not write a file",
  },
  apply_patch: {
    started: "Applying a patch",
    settled: "Applied a patch",
    failed: "Could not apply a patch",
  },
  run_command: {
    started: "Running a command",
    settled: "Ran a command",
    failed: "Could not run a command",
  },
  checkout_repository: {
    started: "Checking out a repository",
    settled: "Checked out a repository",
    failed: "Could not check out a repository",
  },
  import_resource: {
    started: "Copying an attachment into the sandbox",
    settled: "Copied an attachment into the sandbox",
    failed: "Could not copy an attachment into the sandbox",
  },
  publish_resource: {
    started: "Publishing an artifact",
    settled: "Published an artifact",
    failed: "Could not publish an artifact",
  },
  publish_branch_and_pr: {
    started: "Opening a pull request",
    settled: "Opened a pull request",
    failed: "Could not open a pull request",
  },
};

/**
 * Wire names Avalon owns. Connector tools are deliberately absent: there are as
 * many of them as there are authorized connections, and they are named after
 * the connector that owns them instead.
 *
 * A row keeps its own wording when it fails. The label is the prominent text on
 * a row — and on an attributed row the summary beneath it is hidden — so
 * success-tense prose next to a failure icon would be the only thing most
 * readers see.
 */
const AVALON_TOOL_PROSE: Record<string, ToolProse> = {
  web_search: {
    started: "Searching the public web",
    settled: "Searched the public web",
    failed: "Could not search the public web",
  },
  web_fetch: {
    started: "Reading a public web page",
    settled: "Read a public web page",
    failed: "Could not read a public web page",
  },
  current_time: CURRENT_TIME_PROSE,
  request_elicitation: REQUEST_ELICITATION_PROSE,
  [CONNECTOR_CONNECTION_STATE_WIRE_NAME]: CONNECTOR_CONNECTION_STATE_PROSE,
  [CONNECTOR_CONNECTION_CARD_WIRE_NAME]: CONNECTOR_CONNECTION_CARD_PROSE,
  // Rally's browser and the conversation import: the import window lists
  // these as its steps, so they read as what happened to the page.
  browser_js: { started: "Using the browser", settled: "Used the browser", failed: "Could not use the browser" },
  browser_js_reset: { started: "Resetting the browser session", settled: "Reset the browser session", failed: "Could not reset the browser session" },
  browser_evaluate: { started: "Reading the page", settled: "Read the page", failed: "Could not read the page" },
  browser_snapshot: { started: "Reading the page outline", settled: "Read the page outline", failed: "Could not read the page outline" },
  browser_screenshot: { started: "Looking at the page", settled: "Looked at the page", failed: "Could not look at the page" },
  browser_click: { started: "Clicking on the page", settled: "Clicked on the page", failed: "Could not click on the page" },
  browser_scroll: { started: "Scrolling the page", settled: "Scrolled the page", failed: "Could not scroll the page" },
  browser_type: { started: "Typing on the page", settled: "Typed on the page", failed: "Could not type on the page" },
  browser_press_key: { started: "Pressing a key", settled: "Pressed a key", failed: "Could not press a key" },
  browser_navigate: { started: "Opening a page", settled: "Opened a page", failed: "Could not open a page" },
  browser_load: { started: "Downloading a file", settled: "Downloaded a file", failed: "Could not download a file" },
  browser_network_list: { started: "Checking what the page loaded", settled: "Checked what the page loaded", failed: "Could not check what the page loaded" },
  browser_network_read: { started: "Reading data the page loaded", settled: "Read data the page loaded", failed: "Could not read data the page loaded" },
  import_finish: { started: "Saving the conversation to Rally", settled: "Saved the conversation to Rally", failed: "Could not save the conversation to Rally" },
  import_fail: { started: "Stopping the import run", settled: "Stopped the import run", failed: "Could not stop the import run" },
  load_skill: { started: "Loading instructions", settled: "Loaded instructions", failed: "Could not load instructions" },
  read_skill_resource: { started: "Reading instructions", settled: "Read instructions", failed: "Could not read instructions" },
  memory_recall: {
    started: "Recalling what Rally remembers",
    settled: "Recalled what Rally remembers",
    failed: "Could not recall memory",
  },
  memory_remember: {
    started: "Remembering a fact",
    settled: "Remembered a fact",
    failed: "Could not remember the fact",
  },
  memory_forget: {
    started: "Forgetting a fact",
    settled: "Forgot a fact",
    failed: "Could not forget the fact",
  },
  table_search: {
    started: "Searching durable tables",
    settled: "Searched durable tables",
    failed: "Could not search durable tables",
  },
  table_describe: {
    started: "Describing a durable table",
    settled: "Described a durable table",
    failed: "Could not describe a durable table",
  },
  table_query: {
    started: "Querying a durable table",
    settled: "Queried a durable table",
    failed: "Could not query a durable table",
  },
  table_create: {
    started: "Creating a durable table",
    settled: "Created a durable table",
    failed: "Could not create a durable table",
  },
  table_insert_rows: {
    started: "Adding durable table rows",
    settled: "Added durable table rows",
    failed: "Could not add durable table rows",
  },
  table_update_rows: {
    started: "Updating durable table rows",
    settled: "Updated durable table rows",
    failed: "Could not update durable table rows",
  },
  table_invalidate_rows: {
    started: "Clearing durable table rows",
    settled: "Cleared durable table rows",
    failed: "Could not clear durable table rows",
  },
  list_plugins: {
    started: "Checking available plugins",
    settled: "Checked available plugins",
    failed: "Could not check available plugins",
  },
  search_plugins: {
    started: "Searching connected plugins",
    settled: "Searched connected plugins",
    failed: "Could not search connected plugins",
  },
  load_plugin: {
    started: "Loading a plugin",
    settled: "Loaded a plugin",
    failed: "Could not load a plugin",
  },

  // Retired tools. A row is worded from its stored `tool_name` every time it is
  // read, so an entry deleted with its tool takes the wording of every row that
  // tool ever wrote with it — they fall through to the humanized wire name,
  // which is the raw-name fallback this module exists to prevent. Entries here
  // outlive their tools and are removed only when the rows are.
  workstream_create_artifact: {
    started: "Creating an artifact",
    settled: "Created an artifact",
    failed: "Could not create an artifact",
  },

  // Retired wire names, for the same reason. `rally:core` advertised its tools
  // under a `core_` prefix until the always-active plugins stopped carrying
  // one; the tools are unchanged, so these read identically to their current
  // names above and are removed only when the rows that hold them are.
  core_current_time: CURRENT_TIME_PROSE,
  core_request_elicitation: REQUEST_ELICITATION_PROSE,
  [LEGACY_CONNECTOR_CONNECTION_STATE_WIRE_NAME]: CONNECTOR_CONNECTION_STATE_PROSE,
  [LEGACY_CONNECTOR_CONNECTION_CARD_WIRE_NAME]: CONNECTOR_CONNECTION_CARD_PROSE,

  // `rally:terminal` under both spellings, for the same reason it dropped its
  // own `terminal_` prefix. These had no entry at all and were rendering as
  // the humanized wire name — "Terminal run command" — which is the raw-symbol
  // fallback this module exists to prevent; without the retired spellings the
  // prefix would simply disappear from every row already written, leaving old
  // and new rows for one action reading differently in the same feed.
  ...TERMINAL_PROSE,
  ...Object.fromEntries(Object.entries(TERMINAL_PROSE)
    .map(([toolName, prose]) => [`terminal_${toolName}`, prose])),

  // `rally:multimodal-generation`, on the same terms: no entry before, and the
  // retired spelling kept so rows already written keep their wording.
  ...MULTIMODAL_GENERATION_PROSE,
  ...Object.fromEntries(Object.entries(MULTIMODAL_GENERATION_PROSE)
    .map(([toolName, prose]) => [`multimodal_generation_${toolName}`, prose])),

  // `rally:workstream` had prose already; it dropped its `workstream_` prefix,
  // so the same wording is registered under both spellings.
  ...WORKSTREAM_PROSE,
  ...Object.fromEntries(Object.entries(WORKSTREAM_PROSE)
    .map(([toolName, prose]) => [`workstream_${toolName}`, prose])),

  // `rally:sidekick-result` and `avalon:agents`, which also dropped their
  // prefixes. Both spellings, for the rows each already wrote.
  ...AGENT_PROSE,
  ...Object.fromEntries(Object.entries(AGENT_PROSE)
    .map(([toolName, prose]) => [`agents_${toolName}`, prose])),
  // `reply_to_message` was called `reply`, so the rows it wrote say
  // `agents_reply` — not the `agents_reply_to_message` the line above derives.
  agents_reply: AGENT_PROSE.reply_to_message!,
  post_result: SIDEKICK_POST_RESULT_PROSE,
  sidekick_post_result: SIDEKICK_POST_RESULT_PROSE,
  ...CONVERSATION_PROSE,
};

/**
 * The action a connector tool performs, taken from whichever end of its wire
 * name carries the verb (`..._drive_search` → `search`, `..._send_message` →
 * `send`). Naming every connector row "Reviewed <connector>" would label writes
 * as reads and give every call on one connection the same label.
 *
 * The whole name has to be searched because connectors do not agree on word
 * order: Slack, Linear, Notion, X, and Granola put the verb first; Google and
 * GitHub put it last, except where an area prefix pushes it into the middle
 * (`calendar_create_event`). Reading only the last segment left 63 of 75
 * connector tools — `send_message`, `create_issue`, `create_page`, and
 * `calendar_create_event` among them — rendering as "Reviewed <connector>",
 * which shows a write to another person as though the run had merely looked at
 * something.
 */
const CONNECTOR_ACTION_PROSE: Record<string, { started: string; settled: string; preposition?: string }> = {
  search: { started: "Searching", settled: "Searched" },
  find: { started: "Searching", settled: "Searched" },
  query: { started: "Querying", settled: "Queried" },
  list: { started: "Listing", settled: "Listed" },
  read: { started: "Reading", settled: "Read" },
  get: { started: "Fetching", settled: "Fetched", preposition: "from" },
  retrieve: { started: "Fetching", settled: "Fetched", preposition: "from" },
  fetch: { started: "Fetching", settled: "Fetched", preposition: "from" },
  download: { started: "Downloading", settled: "Downloaded", preposition: "from" },
  export: { started: "Exporting", settled: "Exported", preposition: "from" },
  create: { started: "Creating", settled: "Created", preposition: "in" },
  add: { started: "Adding", settled: "Added", preposition: "to" },
  append: { started: "Appending", settled: "Appended", preposition: "to" },
  update: { started: "Updating", settled: "Updated", preposition: "in" },
  upsert: { started: "Updating", settled: "Updated", preposition: "in" },
  replace: { started: "Replacing text in", settled: "Replaced text in" },
  delete: { started: "Deleting", settled: "Deleted", preposition: "in" },
  archive: { started: "Archiving", settled: "Archived", preposition: "in" },
  send: { started: "Sending", settled: "Sent", preposition: "through" },
  post: { started: "Posting", settled: "Posted", preposition: "to" },
  reply: { started: "Replying", settled: "Replied", preposition: "in" },
  comment: { started: "Commenting", settled: "Commented", preposition: "in" },
};

/**
 * Tools whose name ends in their object rather than their verb, keyed by the
 * whole action path.
 *
 * A segment key cannot express these: `gmail.read_profile` and Slack's
 * `read_user_profile` both end in `profile`, so a shared entry for one labels
 * the other — reading a colleague's Slack profile as "the connected account".
 * The map above is verbs, which collide harmlessly because they mean the same
 * thing wherever they appear; anything named for its object has to carry the
 * surface it belongs to.
 *
 * Reach for this only where the verb reading is actually wrong — `create_draft`
 * rendering as a review of a message the run had in fact written. A merely
 * vague reading is not enough: every entry here is one more thing to keep in
 * step with a connector by hand, and an action path carries no connector
 * namespace of its own unless the tool name happens to start with an area
 * segment, so a bare path like `read_user_profile` would claim that name for
 * every connector at once.
 */
const CONNECTOR_TOOL_PROSE: Record<string, { started: string; settled: string; preposition?: string }> = {
  gmail_find_contacts: { started: "Looking up contacts in", settled: "Looked up contacts in" },
  gmail_read_profile: { started: "Checking the connected account on", settled: "Checked the connected account on" },
  gmail_create_draft: { started: "Drafting in", settled: "Drafted in" },
};

/**
 * A connector tool's wire name is `<connection prefix>_<action path>`, and the
 * prefix is derived from the model plugin id, so the action is recoverable
 * without a registry lookup on the read path.
 */
function connectorActionPath(toolName: string, pluginId: string): string {
  const prefix = pluginId.replace(/^plugin_/u, "").slice(0, 48);
  return prefix && toolName.startsWith(`${prefix}_`) ? toolName.slice(prefix.length + 1) : toolName;
}

/**
 * The verb of a connector action: the last segment of its name that is one.
 *
 * Every segment has to be considered, because the verb sits in a different
 * place in each convention — `drive_search` ends with it, `send_message` starts
 * with it, and `calendar_create_event` and `pull_requests_create_review` bury
 * it in the middle behind an area prefix. Reading one fixed position is what
 * left 63 of 75 connector tools rendering as "Reviewed <connector>", including
 * `calendar.create_event` and `pull_requests.create_review` on the two
 * connectors whose naming looked compliant.
 *
 * Last match wins so a name ending in its object keeps the more specific
 * reading: `create_comment` is "Commented in" rather than "Created in". That
 * only reaches the singular object segments the verb map happens to carry —
 * GitHub's `issue_comments.create` matches on `create` and reads "Created in",
 * so the same act is worded two ways across connectors. Adding plural object
 * keys would even that out and break something worse: `list_comments` would
 * then match `comments` and label a read as a comment written. The
 * inconsistency is cosmetic; mislabelling a read as a write is not.
 */
function connectorActionKey(toolName: string, pluginId: string): string {
  const segments = connectorActionPath(toolName, pluginId).split("_").filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = segments[index]!;
    if (Object.hasOwn(CONNECTOR_ACTION_PROSE, segment)) return segment;
  }
  return "";
}

/** Whether a wire name has Avalon prose, used to guard against drift. */
export function hasAvalonToolProse(toolName: string): boolean {
  return Object.hasOwn(AVALON_TOOL_PROSE, toolName);
}

/**
 * A wire name is the last resort, and it should still read as a phrase rather
 * than a symbol — an unrecognized `memory_prune` becomes "Memory prune".
 */
function humanizeWireToolName(toolName: string): string {
  const words = toolName.replace(/[_-]+/gu, " ").trim();
  if (!words) return "Ran a tool";
  return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
}

/**
 * The label for one transcript row. A tool Avalon owns gets its own prose; a
 * connector tool is named after the connector that owns it, matching the icon
 * beside it.
 */
export function toolActivityName(input: {
  toolName: string;
  status: ToolActivityStatus;
  arguments?: unknown;
  plugin?: { pluginId: string; displayName: string } | null;
}): string {
  if (input.toolName === "browser_js" && input.arguments && typeof input.arguments === "object"
    && "title" in input.arguments && typeof input.arguments.title === "string") {
    const title = input.arguments.title.replace(/\s+/gu, " ").trim();
    if (title) return (input.status === "failed" ? `Could not complete: ${title}` : title).slice(0, 200);
  }
  const prose = AVALON_TOOL_PROSE[input.toolName];
  if (prose) {
    if (input.status === "started") return prose.started;
    return input.status === "failed" ? prose.failed : prose.settled;
  }
  const owner = input.plugin?.displayName.trim();
  if (owner) {
    // One wording for both modes on failure: the call did not reach the
    // provider, so saying what it would have done there would overstate it.
    if (input.status === "failed") return `Could not reach ${owner}`;
    const pluginId = input.plugin?.pluginId ?? "";
    const action = CONNECTOR_TOOL_PROSE[connectorActionPath(input.toolName, pluginId)]
      ?? CONNECTOR_ACTION_PROSE[connectorActionKey(input.toolName, pluginId)];
    if (!action) return input.status === "started" ? `Reviewing ${owner}` : `Reviewed ${owner}`;
    const verb = input.status === "started" ? action.started : action.settled;
    return action.preposition ? `${verb} ${action.preposition} ${owner}` : `${verb} ${owner}`;
  }
  const humanized = humanizeWireToolName(input.toolName);
  return input.status === "failed" ? `${humanized} failed` : humanized;
}
