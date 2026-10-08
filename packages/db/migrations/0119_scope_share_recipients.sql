-- Migration-first: the Worker that reads this table ships after it, and the
-- Worker before it never names it.
--
-- Where a share addressed to a mailbox waits. The share itself, and the grants
-- it becomes, live in the Organization object that hosts the Channel; this
-- row only says which Channel to ask, so that signing in as the address can
-- claim the share without a link or an acceptance step.
--
-- Written once the object has recorded the share, and deleted by the object
-- once nothing for that address is left pending there. Shares pending before
-- this table existed are indexed by WorkspaceDO migration 93.
CREATE TABLE scope_share_recipients (
  email TEXT NOT NULL COLLATE NOCASE,
  workspace_id TEXT NOT NULL,
  parent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (email, workspace_id, parent_id)
) STRICT;
