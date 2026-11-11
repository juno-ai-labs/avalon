-- Organization presentation setting. Existing Organizations start hidden;
-- application creation paths explicitly seed the deployment default for new ones.
ALTER TABLE workspaces ADD COLUMN model_selector_visible INTEGER NOT NULL DEFAULT 0
  CHECK (model_selector_visible IN (0, 1));
