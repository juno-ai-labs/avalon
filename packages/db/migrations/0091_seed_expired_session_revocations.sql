-- Close the expiry sweep's opening backlog, and give its query an index.
--
-- `reapExpiredSessions` selects sessions that are past `expires_at` with
-- `revoked_at IS NULL`, publishes a revocation for each, and marks what it
-- announced. Nothing in this repository has ever deleted from `sessions`, and a
-- refresh token lives 30 days, so every session that has ever expired is still
-- sitting here unrevoked. Without this migration the sweep's first run after
-- deploy starts draining that entire history at 200 rows per five minutes,
-- publishing a full workspace fan-out for each one — and every one of them is a
-- session that died weeks ago and holds no socket at all.
--
-- Marking them here is honest rather than merely cheap: a session past its
-- expiry is revoked by any reading of the word, and this states that fact once
-- instead of paying a queue walk to rediscover it. `revoked_at` takes the
-- expiry time, not the migration time, so the row still records when access
-- actually ended. After this, the sweep only ever sees sessions that expired
-- since its last run.
-- `strftime`, not `CURRENT_TIMESTAMP`: these columns hold what
-- `new Date().toISOString()` writes, and CURRENT_TIMESTAMP renders
-- `YYYY-MM-DD HH:MM:SS`. Compared as text a space sorts before `T`, so
-- CURRENT_TIMESTAMP would silently exclude every row expiring later the same
-- day while appearing to work for older ones.
UPDATE sessions
   SET revoked_at = expires_at
 WHERE revoked_at IS NULL
   AND expires_at <= strftime('%Y-%m-%dT%H:%M:%fZ', 'now');

-- The sweep's own query. `sessions_user_idx(user_id, expires_at)` cannot serve
-- `WHERE revoked_at IS NULL AND expires_at <= ? ORDER BY expires_at`, so
-- without this it is a full scan of `sessions` every five minutes, in every
-- region, forever. Partial on `revoked_at IS NULL` because that is the only
-- half the sweep reads, and it is the half that stays small once the backlog
-- above is gone.
CREATE INDEX IF NOT EXISTS sessions_unrevoked_expiry_idx
    ON sessions(expires_at)
 WHERE revoked_at IS NULL;
