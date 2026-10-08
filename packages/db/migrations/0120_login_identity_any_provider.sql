-- Migration-first: the Worker before it writes only 'google' and 'email', which
-- the new check still admits.
--
-- A sign-in method is a provider name and that provider's subject. The provider
-- list was fixed at 'google' and 'email'; it becomes a name of the same shape
-- the API validates, so adding Apple or GitHub sign-in is code alone. Nothing
-- references this table, so it is rebuilt in place.
CREATE TABLE user_login_identities_next (
  provider TEXT NOT NULL CHECK (
    length(provider) BETWEEN 1 AND 32
    AND provider GLOB '[a-z]*'
    AND provider NOT GLOB '*[^a-z0-9_-]*'
  ),
  subject TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (provider, subject)
) STRICT;

INSERT INTO user_login_identities_next (provider, subject, user_id, verified_at)
SELECT provider, subject, user_id, verified_at FROM user_login_identities;

DROP TABLE user_login_identities;

ALTER TABLE user_login_identities_next RENAME TO user_login_identities;

CREATE INDEX user_login_identities_user_idx ON user_login_identities(user_id);
