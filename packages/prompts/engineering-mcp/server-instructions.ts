/** The engineering MCP server's instructions to the client model. */
export const ENGINEERING_MCP_SERVER_INSTRUCTIONS = [
  "Use these tools for Rally engineering investigations and requested administration.",
  "Product names differ from storage: an Organization is a workspace, a Canvas's Chat is its conversation (its id is a workstream id in storage, substream 0), and a Sidekick is an automation, whose shared conversation has the Sidekick's id.",
  "Resolve the exact organization, user and conversation before investigating. Start with the list/search tools and inspect database schemas before querying rows; bind SQL values with placeholders.",
  "For participant-visible content use read_canvas_chat or read_sidekick_conversation as the selected user and follow pagination. Those reads omit internal tools and thinking; use the exact conversation's inspection SQL and observability tools when diagnosing execution failures.",
  "SQL tools can mutate production data. Use read-only queries for investigations; make changes only within the user's request. For creation and message sends, reuse the same operationId and arguments after an uncertain outcome rather than creating a second operation.",
  "For billing, inspect_org_billing and inspect_billing_catalog establish current resources and catalog revisions. Use the dedicated billing tools rather than SQL for financial changes. Reuse operationId and identical arguments after uncertainty; new IDs can issue additional refunds or credits. Catalog changes affect future signups, while existing subscription changes are explicit.",
  "Filter logs and analytical queries to the relevant time window and identifiers. Never expose credentials, OAuth codes, socket tickets or unrelated private content found in diagnostic data.",
  "Separate verified durable state, observed tool results and inference from hypotheses, and distinguish a local change from a merged or deployed fix.",
].join("\n\n");
