import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 4;

const CANONICAL_MONTH_CHECK = `
  length(%COLUMN%) = 7
  AND substr(%COLUMN%, 1, 4) NOT GLOB '*[^0-9]*'
  AND substr(%COLUMN%, 5, 1) = '-'
  AND substr(%COLUMN%, 6, 2) IN ('01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12')
`;

const SUPPORTERS_MONTH_CHECK = CANONICAL_MONTH_CHECK.replaceAll(
  "%COLUMN%",
  "latest_month_key",
);
const MONTH_STATES_MONTH_CHECK = CANONICAL_MONTH_CHECK.replaceAll(
  "%COLUMN%",
  "month_key",
);

const VERSION_ONE_SCHEMA = `
CREATE TABLE supporters (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  fanbox_relationship_id TEXT NOT NULL UNIQUE CHECK (length(trim(fanbox_relationship_id)) > 0),
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) > 0),
  current_level INTEGER NOT NULL CHECK (typeof(current_level) = 'integer' AND current_level >= 0),
  supporting INTEGER NOT NULL CHECK (supporting IN (0, 1)),
  latest_month_key TEXT NULL CHECK (
    latest_month_key IS NULL OR (${SUPPORTERS_MONTH_CHECK})
  ),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE supporter_month_states (
  supporter_id TEXT NOT NULL REFERENCES supporters(id),
  month_key TEXT NOT NULL CHECK (${MONTH_STATES_MONTH_CHECK}),
  level INTEGER NOT NULL CHECK (typeof(level) = 'integer' AND level >= 0),
  monthly_plus_one_used INTEGER NOT NULL CHECK (monthly_plus_one_used IN (0, 1)),
  lottery_participation_occurred INTEGER NOT NULL CHECK (lottery_participation_occurred IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (supporter_id, month_key)
) STRICT;
`;

const VERSION_TWO_SCHEMA = `
CREATE TABLE level_operations (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE CHECK (length(id) > 0),
  supporter_id TEXT NOT NULL REFERENCES supporters(id),
  month_key TEXT NOT NULL CHECK (${MONTH_STATES_MONTH_CHECK}),
  kind TEXT NOT NULL CHECK (
    kind IN ('lottery_loss', 'lottery_win', 'month_end', 'initial_import')
  ),
  before_level INTEGER NOT NULL CHECK (
    typeof(before_level) = 'integer' AND before_level >= 0
  ),
  after_level INTEGER NOT NULL CHECK (
    typeof(after_level) = 'integer' AND after_level >= 0
  ),
  occurred_at TEXT NULL,
  supporting_at_month_end INTEGER NULL,
  created_at TEXT NOT NULL,
  CHECK (
    (kind IN ('lottery_loss', 'lottery_win')
      AND occurred_at IS NOT NULL
      AND supporting_at_month_end IS NULL)
    OR (kind = 'month_end'
      AND occurred_at IS NULL
      AND supporting_at_month_end IN (0, 1))
    OR (kind = 'initial_import'
      AND occurred_at IS NULL
      AND supporting_at_month_end IS NULL)
  )
) STRICT;

CREATE INDEX level_operations_supporter_sequence_idx
  ON level_operations (supporter_id, sequence);
`;

const VERSION_THREE_SCHEMA = `
CREATE TABLE supporter_portal_access (
  supporter_id TEXT NOT NULL PRIMARY KEY
    REFERENCES supporters(id)
    ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE CHECK (
    length(token_hash) = 64
    AND token_hash NOT GLOB '*[^0-9a-f]*'
  ),
  issued_at TEXT NOT NULL,
  provisioned_at TEXT NULL,
  sent_at TEXT NULL,
  CHECK (sent_at IS NULL OR provisioned_at IS NOT NULL)
) STRICT;
`;

const VERSION_FOUR_SCHEMA = `
CREATE TABLE fanbox_supporter_imports (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  imported_at TEXT NOT NULL,
  present_supporter_count INTEGER NOT NULL CHECK (
    typeof(present_supporter_count) = 'integer' AND present_supporter_count >= 0
  )
) STRICT;
`;

type SqliteDatabase = Database.Database;

export function configureDatabase(
  database: SqliteDatabase,
): void {
  database.pragma("foreign_keys = ON");
  database.pragma("synchronous = FULL");
  database.pragma("busy_timeout = 5000");
}

export function configureFileJournalMode(
  database: SqliteDatabase,
  databasePath: string,
): void {
  if (databasePath !== ":memory:") {
    database.pragma("journal_mode = WAL");
  }
}

export function readUserVersion(database: SqliteDatabase): number {
  return database.pragma("user_version", { simple: true }) as number;
}

export function applyVersionOneMigration(database: SqliteDatabase): void {
  const migrate = database.transaction((): void => {
    database.exec(VERSION_ONE_SCHEMA);
    database.pragma("user_version = 1");
  });

  migrate();
}

export function applyVersionTwoMigration(database: SqliteDatabase): void {
  const migrate = database.transaction((): void => {
    database.exec(VERSION_TWO_SCHEMA);
    database.pragma("user_version = 2");
  });

  migrate();
}

export function applyVersionThreeMigration(database: SqliteDatabase): void {
  const migrate = database.transaction((): void => {
    database.exec(VERSION_THREE_SCHEMA);
    database.pragma("user_version = 3");
  });

  migrate();
}

export function applyVersionFourMigration(database: SqliteDatabase): void {
  const migrate = database.transaction((): void => {
    database.exec(VERSION_FOUR_SCHEMA);
    database.pragma("user_version = 4");
  });

  migrate();
}
