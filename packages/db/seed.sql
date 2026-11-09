-- Development-only seed. Production startup never executes this file.
INSERT OR IGNORE INTO users
  (id, google_subject, email, name, avatar_url, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000001', 'dev-adam', 'adam@avalon.local', 'Adam', NULL, '2026-07-31T18:00:00.000Z', '2026-07-31T18:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000003', 'dev-samantha', 'samantha@avalon.local', 'Samantha Lee', NULL, '2026-07-31T18:00:00.000Z', '2026-07-31T18:00:00.000Z');

INSERT OR IGNORE INTO workspaces
  (id, name, slug, region, created_by_user_id, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000002', 'Avalon Studio', 'avalon-studio', 'global', '00000000-0000-7000-8000-000000000001', '2026-07-31T18:00:00.000Z', '2026-07-31T18:00:00.000Z');

INSERT OR IGNORE INTO workspace_members
  (workspace_id, user_id, role, status, joined_at)
VALUES
  ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000001', 'owner', 'active', '2026-07-31T18:00:00.000Z'),
  ('00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003', 'member', 'active', '2026-07-31T18:00:00.000Z');

-- No conversation is seeded here. The two Canvases and the Sidekick in
-- seed-product.json are made by the Worker's own creation paths when
-- `pnpm db:open-authority` posts that file to POST /dev/seed-product, and
-- those paths write the D1 anchors (`workstreams`, routes) themselves, after
-- the authority is open. A row here would anchor a conversation no object
-- holds, which is what failed the seed with `workstream_not_found` once the
-- Thread server code was gone.
