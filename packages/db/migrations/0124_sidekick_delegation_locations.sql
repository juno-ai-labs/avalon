-- Routing references only. WorkspaceDO remains the consent authority.
-- Retain these when membership ends so a signed-in person can withdraw.
CREATE TABLE sidekick_delegation_locations (
  user_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  region TEXT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);
