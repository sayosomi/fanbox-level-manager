CREATE TABLE portal_supporters (
  supporter_id TEXT NOT NULL PRIMARY KEY CHECK (length(trim(supporter_id)) > 0),
  current_level INTEGER NOT NULL CHECK (current_level >= 0),
  verified_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE portal_history (
  supporter_id TEXT NOT NULL,
  entry_id TEXT NOT NULL CHECK (length(trim(entry_id)) > 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  month_key TEXT NOT NULL CHECK (
    month_key GLOB '[0-9][0-9][0-9][0-9]-0[1-9]' OR
    month_key GLOB '[0-9][0-9][0-9][0-9]-1[0-2]'
  ),
  level INTEGER NOT NULL CHECK (level >= 0),
  reason TEXT NOT NULL CHECK (
    reason IN (
      '当選',
      '抽選結果によるレベルアップ',
      '抽選不参加によるレベルアップ',
      '旧管理方式による履歴'
    )
  ),
  occurred_at TEXT NULL,
  recorded_at TEXT NOT NULL CHECK (length(trim(recorded_at)) > 0),
  PRIMARY KEY (supporter_id, entry_id),
  UNIQUE (supporter_id, position),
  FOREIGN KEY (supporter_id)
    REFERENCES portal_supporters(supporter_id)
    ON DELETE CASCADE,
  CHECK (
    (
      reason IN ('当選', '抽選結果によるレベルアップ') AND
      occurred_at IS NOT NULL
    ) OR (
      reason IN ('抽選不参加によるレベルアップ', '旧管理方式による履歴') AND
      occurred_at IS NULL
    )
  )
) STRICT;

CREATE INDEX portal_history_supporter_position_idx
  ON portal_history (supporter_id, position);
