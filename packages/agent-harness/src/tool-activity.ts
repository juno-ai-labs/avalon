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
  run_subagent: {
    started: "Running a focused sub-agent",
    settled: "Ran a focused sub-agent",
    failed: "Could not run a focused sub-agent",
  },
};

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
  pluginDisplayName?: string | null;
}): string {
  const prose = AVALON_TOOL_PROSE[input.toolName];
  if (prose) {
    if (input.status === "started") return prose.started;
    return input.status === "failed" ? prose.failed : prose.settled;
  }
  const owner = input.pluginDisplayName?.trim();
  if (owner) {
    if (input.status === "started") return `Reviewing ${owner}`;
    return input.status === "failed" ? `Could not reach ${owner}` : `Reviewed ${owner}`;
  }
  const humanized = humanizeWireToolName(input.toolName);
  return input.status === "failed" ? `${humanized} failed` : humanized;
}
