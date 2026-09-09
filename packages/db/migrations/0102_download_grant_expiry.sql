-- NULL preserves single-use grants. A deadline allows repeat downloads until
-- that instant; all deadlines are normalized UTC ISO timestamps by the issuer.
ALTER TABLE download_grants ADD COLUMN expires_at TEXT;
