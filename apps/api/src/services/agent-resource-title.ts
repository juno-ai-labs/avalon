/**
 * The title an agent's republish leaves on a resource, as a SET expression
 * that takes the agent's title twice (null when it named none).
 *
 * A person can rename an artifact, and an agent republishing it usually
 * passes the display name it chose the first time. Applying that would undo
 * the rename with no notice, so the agent's title is taken only when it
 * differs from the last title an agent or an upload set (the latest
 * `created`, `published` or `replaced` version): a name it chose afresh.
 */
export const AGENT_RESOURCE_TITLE_SQL = `CASE
    WHEN ? IS NULL OR ? = (
      SELECT version.title FROM resource_versions version
       WHERE version.resource_id = resources.id
         AND version.cause IN ('created', 'published', 'replaced')
       ORDER BY version.version DESC LIMIT 1)
    THEN resources.title
    ELSE ? END`;
