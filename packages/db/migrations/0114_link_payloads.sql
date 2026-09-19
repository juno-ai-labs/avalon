-- What an emailed link carries instead of its own contents: one opaque token,
-- and a row holding the JSON it stands for. The token's prefix is its type, and
-- the type decides which schema the payload has to satisfy, so a token minted
-- for one kind of link cannot be read as another.
--
-- Only the digest is stored. A copy of this table is a list of what exists, not
-- a set of working links.
CREATE TABLE link_payloads (
  token_hash TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- Null where the thing the link addresses has no expiry of its own. Rows are
  -- pointers: an expired or missing one refuses the link, and the authority the
  -- payload names still decides everything else.
  --
  -- Rows carrying a deadline are swept by later writes. A null one is not, and
  -- nothing else can reach it either: the row is keyed by a digest of a token
  -- that is never stored, so only the caller that minted it can delete it, and
  -- only while it still holds the token. Reclaiming the rest would mean
  -- deleting on `created_at` age, which is a retention number the team sets.
  expires_at TEXT
);
CREATE INDEX link_payloads_expiry ON link_payloads(expires_at);
