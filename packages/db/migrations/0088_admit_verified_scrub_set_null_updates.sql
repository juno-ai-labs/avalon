-- 0087 let the verified scrub's `ON DELETE CASCADE` reach fenced children. It
-- did not cover the other half of what a foreign key does on delete: a
-- `SET NULL` reference makes SQLite issue an UPDATE against the child, and the
-- update fences admit no phase past draining. Deleting a workspace's
-- `connector_connections`, `resources`, `activities`, `work_opportunities`, or
-- `opportunity_provenance_nodes` therefore still aborted the scrub with
-- `workspace_do_authoritative`, again at activation and again after every route
-- had imported and verified.
--
-- Exactly the eight tables a `SET NULL` can reach from a scrubbed parent are
-- relaxed here, each with the parent that reaches it named. Inserts stay
-- refused from the moment import begins, and every fence still refuses updates
-- once the region is open, so D1 remains unable to become a second writable
-- authority. A future foreign key added with `ON DELETE SET NULL` onto a fenced
-- table has to appear here too, or it will stop activation.


-- Reached by ON DELETE SET NULL from activities.
DROP TRIGGER automation_runs_reject_workspace_do_update;
CREATE TRIGGER automation_runs_reject_workspace_do_update BEFORE UPDATE ON automation_runs
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

-- Reached by ON DELETE SET NULL from connector_connections.
DROP TRIGGER connector_oauth_attempts_reject_workspace_do_update;
CREATE TRIGGER connector_oauth_attempts_reject_workspace_do_update BEFORE UPDATE ON connector_oauth_attempts
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

-- Reached by ON DELETE SET NULL from connector_connections.
DROP TRIGGER resources_reject_workspace_do_update;
CREATE TRIGGER resources_reject_workspace_do_update BEFORE UPDATE ON resources
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

-- Reached by ON DELETE SET NULL from resources.
DROP TRIGGER sandbox_tasks_reject_do_authority_update;
CREATE TRIGGER sandbox_tasks_reject_do_authority_update
BEFORE UPDATE ON sandbox_tasks
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

-- Reached by ON DELETE SET NULL from connector_connections.
DROP TRIGGER tool_invocations_reject_do_authority_update;
CREATE TRIGGER tool_invocations_reject_do_authority_update
BEFORE UPDATE ON tool_invocations
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

-- Reached by ON DELETE SET NULL from opportunity_provenance_nodes.
DROP TRIGGER work_opportunity_user_links_reject_do_authority_update;
CREATE TRIGGER work_opportunity_user_links_reject_do_authority_update BEFORE UPDATE ON work_opportunity_user_links
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN SELECT RAISE(ABORT, 'workspace_do_authoritative'); END;

-- Reached by ON DELETE SET NULL from resources.
DROP TRIGGER workstream_sandboxes_reject_do_authority_update;
CREATE TRIGGER workstream_sandboxes_reject_do_authority_update
BEFORE UPDATE ON workstream_sandboxes
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;

-- Reached by ON DELETE SET NULL from automation_subscriptions and work_opportunities.
DROP TRIGGER workstreams_reject_post_cutover_update;
CREATE TRIGGER workstreams_reject_post_cutover_update
BEFORE UPDATE ON workstreams
WHEN (SELECT phase FROM workstream_authority_control WHERE id = 1) NOT IN ('legacy_open', 'maintenance_draining', 'maintenance_verified')
BEGIN
  SELECT RAISE(ABORT, 'workstream_do_authoritative');
END;
