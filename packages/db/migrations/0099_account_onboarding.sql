-- Identity preferences are authoritative in Global and narrowly projected to
-- regional user rows. Existing accounts never become new by absence of state.
ALTER TABLE users ADD COLUMN onboarding_eligible INTEGER NOT NULL DEFAULT 1 CHECK (onboarding_eligible IN (0, 1));
ALTER TABLE users ADD COLUMN onboarding_introduced INTEGER NOT NULL DEFAULT 0 CHECK (onboarding_introduced IN (0, 1));
ALTER TABLE users ADD COLUMN onboarding_revision INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN presentation_json TEXT;
UPDATE users SET onboarding_eligible = 0, onboarding_introduced = 1;
