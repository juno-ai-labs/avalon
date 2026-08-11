/**
 * Transcript rows name what a tool did, not which wire symbol was called. Every
 * chat surface renders the same row component, so every surface has to get its
 * prose from here rather than falling back to a raw tool name.
 */

export type ToolActivityStatus = "started" | "completed" | "failed";

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
const AVALON_TOOL_PROSE: Record<string, { started: string; settled: string; failed: string }> = {
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
  core_current_time: {
    started: "Checking the current time",
    settled: "Checked the current time",
    failed: "Could not check the current time",
  },
  core_request_elicitation: {
    started: "Asking for a decision",
    settled: "Asked for a decision",
    failed: "Could not ask for a decision",
  },
  workstream_read: {
    started: "Reading the work stream",
    settled: "Read the work stream",
    failed: "Could not read the work stream",
  },
  workstream_read_resource: {
    started: "Reading an attached resource",
    settled: "Read an attached resource",
    failed: "Could not read an attached resource",
  },
  workstream_create_artifact: {
    started: "Creating an artifact",
    settled: "Created an artifact",
    failed: "Could not create an artifact",
  },
  memory_search: {
    started: "Searching memory",
    settled: "Searched memory",
    failed: "Could not search memory",
  },
  memory_add: {
    started: "Saving to memory",
    settled: "Saved to memory",
    failed: "Could not save to memory",
  },
  memory_update: {
    started: "Updating memory",
    settled: "Updated memory",
    failed: "Could not update memory",
  },
  memory_invalidate: {
    started: "Clearing a memory entry",
    settled: "Cleared a memory entry",
    failed: "Could not clear a memory entry",
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
  workstream_schedule_wakeup: {
    started: "Scheduling a wake-up",
    settled: "Scheduled a wake-up",
    failed: "Could not schedule a wake-up",
  },
  workstream_list_wakeups: {
    started: "Checking scheduled wake-ups",
    settled: "Checked scheduled wake-ups",
    failed: "Could not check scheduled wake-ups",
  },
  workstream_cancel_wakeup: {
    started: "Cancelling a wake-up",
    settled: "Cancelled a wake-up",
    failed: "Could not cancel a wake-up",
  },
  workstream_run_subagent: {
    started: "Running a focused sub-agent",
    settled: "Ran a focused sub-agent",
    failed: "Could not run a focused sub-agent",
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
};

/**
 * The action a connector tool performs, taken from the last segment of its wire
 * name (`..._drive_search` → `search`). Naming every connector row "Reviewed
 * <connector>" would label writes as reads and give every call on one
 * connection the same label.
 */
const CONNECTOR_ACTION_PROSE: Record<string, { started: string; settled: string; preposition?: string }> = {
  search: { started: "Searching", settled: "Searched" },
  query: { started: "Querying", settled: "Queried" },
  list: { started: "Listing", settled: "Listed" },
  read: { started: "Reading", settled: "Read" },
  get: { started: "Fetching", settled: "Fetched", preposition: "from" },
  fetch: { started: "Fetching", settled: "Fetched", preposition: "from" },
  download: { started: "Downloading", settled: "Downloaded", preposition: "from" },
  create: { started: "Creating", settled: "Created", preposition: "in" },
  add: { started: "Adding", settled: "Added", preposition: "to" },
  append: { started: "Appending", settled: "Appended", preposition: "to" },
  update: { started: "Updating", settled: "Updated", preposition: "in" },
  upsert: { started: "Updating", settled: "Updated", preposition: "in" },
  delete: { started: "Deleting", settled: "Deleted", preposition: "in" },
  archive: { started: "Archiving", settled: "Archived", preposition: "in" },
  send: { started: "Sending", settled: "Sent", preposition: "through" },
  post: { started: "Posting", settled: "Posted", preposition: "to" },
  reply: { started: "Replying", settled: "Replied", preposition: "in" },
  comment: { started: "Commenting", settled: "Commented", preposition: "in" },
  // The key is a tool's last name segment, which is usually its verb but not
  // always. `gmail.find_contacts` ends in its object, and leaving it to the
  // generic fallback would label a contact lookup with the same "Reviewed
  // <connector>" row every other unrecognized call gets.
  contacts: { started: "Looking up contacts in", settled: "Looked up contacts in" },
};

/**
 * A connector tool's wire name is `<connection prefix>_<action path>`, and the
 * prefix is derived from the model plugin id, so the action is recoverable
 * without a registry lookup on the read path.
 */
function connectorActionKey(toolName: string, pluginId: string): string {
  const prefix = pluginId.replace(/^plugin_/u, "").slice(0, 48);
  const leaf = prefix && toolName.startsWith(`${prefix}_`)
    ? toolName.slice(prefix.length + 1)
    : toolName;
  const segments = leaf.split("_").filter(Boolean);
  return segments[segments.length - 1] ?? "";
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
  plugin?: { pluginId: string; displayName: string } | null;
}): string {
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
    const action = CONNECTOR_ACTION_PROSE[connectorActionKey(input.toolName, input.plugin?.pluginId ?? "")];
    if (!action) return input.status === "started" ? `Reviewing ${owner}` : `Reviewed ${owner}`;
    const verb = input.status === "started" ? action.started : action.settled;
    return action.preposition ? `${verb} ${action.preposition} ${owner}` : `${verb} ${owner}`;
  }
  const humanized = humanizeWireToolName(input.toolName);
  return input.status === "failed" ? `${humanized} failed` : humanized;
}
