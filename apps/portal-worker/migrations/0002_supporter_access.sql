CREATE TABLE portal_access_tokens (
  supporter_id TEXT NOT NULL PRIMARY KEY
    REFERENCES portal_supporters(supporter_id)
    ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;
