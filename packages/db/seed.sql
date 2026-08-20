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

-- The regional control-plane index rows for the seeded work streams. Their
-- product content — transcripts, runs, tool events, resources, connections,
-- automations — lives in seed-product.json and is written into the Durable
-- Objects by `pnpm db:open-authority`, because the objects are the product
-- authority and the legacy D1 product tables are on their way out.
INSERT OR IGNORE INTO workstreams
  (id, workspace_id, title, objective, description_source, origin_type, created_by_user_id, harness_status, next_sequence_number, last_activity_at, created_at, updated_at)
VALUES
  ('00000000-0000-7000-8000-000000000020', '00000000-0000-7000-8000-000000000002', 'Prepare the Acme client follow-up', 'Turn the client call into a clear follow-up with owners and next steps.', 'authored', 'ad_hoc', '00000000-0000-7000-8000-000000000001', 'needs_input', 4, '2026-07-31T19:45:00.000Z', '2026-07-31T19:30:00.000Z', '2026-07-31T19:45:00.000Z'),
  ('00000000-0000-7000-8000-000000000021', '00000000-0000-7000-8000-000000000002', 'Investigate ENG-142', 'Find the cause of intermittent invoice retry failures.', 'authored', 'ad_hoc', '00000000-0000-7000-8000-000000000001', 'running', 3, '2026-07-31T19:40:00.000Z', '2026-07-31T19:20:00.000Z', '2026-07-31T19:40:00.000Z');
