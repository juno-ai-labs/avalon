/**
 * The capability set a personal Slack connection asks for.
 *
 * Extracted from the connector catalog in `workspace-settings.tsx` because two
 * surfaces now start the same authorization: the **Connect only for me** button, and
 * the Slack account link, which continues straight into it so that one click in
 * Slack both links the identity and connects personal Slack. Two copies of this
 * list would drift, and the drift is invisible — a member would silently get a
 * narrower grant depending on which button they happened to press.
 */
export const SLACK_PERSONAL_CAPABILITIES = [
  'slack.personal.mcp',
] as const;
