CREATE TABLE portal_supporters_entry_count_new (
  supporter_id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(supporter_id)) > 0),
  current_entry_count INTEGER NOT NULL CHECK (
    typeof(current_entry_count) = 'integer' AND current_entry_count >= 1
  ),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE portal_history_entry_count_new (
  supporter_id TEXT NOT NULL,
  entry_id TEXT NOT NULL CHECK (length(trim(entry_id)) > 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  month_key TEXT NOT NULL CHECK (
    month_key GLOB '[0-9][0-9][0-9][0-9]-0[1-9]' OR
    month_key GLOB '[0-9][0-9][0-9][0-9]-1[0-2]'
  ),
  entry_count INTEGER NOT NULL CHECK (
    typeof(entry_count) = 'integer' AND entry_count >= 1
  ),
  reason TEXT NOT NULL CHECK (
    reason IN (
      '当選',
      '抽選結果による口数増加',
      '抽選不参加による口数増加',
      '旧管理方式による履歴'
    )
  ),
  occurred_at TEXT NULL,
  recorded_at TEXT NOT NULL CHECK (length(trim(recorded_at)) > 0),
  PRIMARY KEY (supporter_id, entry_id),
  UNIQUE (supporter_id, position),
  FOREIGN KEY (supporter_id)
    REFERENCES portal_supporters_entry_count_new(supporter_id)
    ON DELETE CASCADE,
  CHECK (
    (
      reason IN ('当選', '抽選結果による口数増加') AND
      occurred_at IS NOT NULL
    ) OR (
      reason IN ('抽選不参加による口数増加', '旧管理方式による履歴') AND
      occurred_at IS NULL
    )
  )
) STRICT;

DROP INDEX portal_history_supporter_position_idx;

CREATE INDEX portal_history_supporter_position_idx
  ON portal_history_entry_count_new (supporter_id, position);

CREATE TABLE portal_access_tokens_entry_count_new (
  supporter_id TEXT NOT NULL PRIMARY KEY
    REFERENCES portal_supporters_entry_count_new(supporter_id)
    ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  )
) STRICT;

INSERT INTO portal_supporters_entry_count_new (
  supporter_id,
  current_entry_count,
  verified_at,
  created_at,
  updated_at
)
SELECT
  supporter_id,
  current_level + 1,
  verified_at,
  created_at,
  updated_at
FROM portal_supporters;

INSERT INTO portal_history_entry_count_new (
  supporter_id,
  entry_id,
  position,
  month_key,
  entry_count,
  reason,
  occurred_at,
  recorded_at
)
SELECT
  supporter_id,
  entry_id,
  position,
  month_key,
  level + 1,
  CASE reason
    WHEN '抽選結果によるレベルアップ' THEN '抽選結果による口数増加'
    WHEN '抽選不参加によるレベルアップ' THEN '抽選不参加による口数増加'
    ELSE reason
  END,
  occurred_at,
  recorded_at
FROM portal_history;

INSERT INTO portal_access_tokens_entry_count_new (
  supporter_id,
  token_hash
)
SELECT supporter_id, token_hash
FROM portal_access_tokens;

DROP TABLE portal_access_tokens;
DROP TABLE portal_history;
DROP TABLE portal_supporters;

ALTER TABLE portal_supporters_entry_count_new RENAME TO portal_supporters;
ALTER TABLE portal_history_entry_count_new RENAME TO portal_history;
ALTER TABLE portal_access_tokens_entry_count_new RENAME TO portal_access_tokens;
