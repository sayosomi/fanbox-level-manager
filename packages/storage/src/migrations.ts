import type Database from "better-sqlite3";

export const CURRENT_SCHEMA_VERSION = 1;

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
    database.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
  });

  migrate();
}
