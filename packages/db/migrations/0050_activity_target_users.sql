ALTER TABLE activities
  ADD COLUMN target_user_ids_json TEXT NOT NULL DEFAULT '[]';
