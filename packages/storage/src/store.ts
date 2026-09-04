import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  DuplicateFanboxRelationshipError,
  StaleMonthError,
  SupporterNotFoundError,
  UnsupportedSchemaVersionError,
} from "./errors.js";
import {
  applyVersionOneMigration,
  configureDatabase,
  configureFileJournalMode,
  CURRENT_SCHEMA_VERSION,
  readUserVersion,
} from "./migrations.js";
import type {
  CreateSupporterInput,
  LocalStore,
  MonthlyStateRecord,
  MonthlyStateTransition,
  OpenLocalStoreOptions,
  StoreClock,
  SupporterProfilePatch,
  SupporterRecord,
} from "./types.js";
import {
  assertNonBlankString,
  assertValidCreateSupporterInput,
  assertValidMonthKey,
  assertValidSupporterId,
  assertValidSupporterProfilePatch,
  assertValidTransitionCallback,
  timestampFromClock,
  validateTransitionResult,
} from "./validation.js";

type SupporterRow = {
  id: string;
  fanbox_relationship_id: string;
  display_name: string;
  current_level: number;
  supporting: number;
  latest_month_key: string | null;
  created_at: string;
  updated_at: string;
};

type MonthlyStateRow = {
  supporter_id: string;
  month_key: string;
  level: number;
  monthly_plus_one_used: number;
  lottery_participation_occurred: number;
  created_at: string;
  updated_at: string;
};

function toSupporterRecord(row: SupporterRow): SupporterRecord {
  return Object.freeze({
    id: row.id,
    fanboxRelationshipId: row.fanbox_relationship_id,
    displayName: row.display_name,
    currentLevel: row.current_level,
    supporting: row.supporting === 1,
    latestMonthKey: row.latest_month_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toMonthlyStateRecord(row: MonthlyStateRow): MonthlyStateRecord {
  return Object.freeze({
    supporterId: row.supporter_id,
    monthKey: row.month_key,
    level: row.level,
    monthlyPlusOneUsed: row.monthly_plus_one_used === 1,
    lotteryParticipationOccurred: row.lottery_participation_occurred === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function isUniqueConstraintError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }

  return error.code === "SQLITE_CONSTRAINT_UNIQUE";
}

function defaultClock(): Date {
  return new Date();
}

function resolveClock(options: OpenLocalStoreOptions | undefined): StoreClock {
  if (options === undefined) {
    return defaultClock;
  }

  if (typeof options !== "object" || options === null) {
    throw new TypeError("openLocalStore options must be an object");
  }

  if (options.clock === undefined) {
    return defaultClock;
  }

  if (typeof options.clock !== "function") {
    throw new TypeError("clock must be a function");
  }

  return options.clock;
}

class LocalStoreImplementation implements LocalStore {
  private readonly database: Database.Database;
  private readonly clock: StoreClock;

  constructor(database: Database.Database, clock: StoreClock) {
    this.database = database;
    this.clock = clock;
  }

  close(): void {
    if (this.database.open) {
      this.database.close();
    }
  }

  createSupporter(input: CreateSupporterInput): SupporterRecord {
    assertValidCreateSupporterInput(input);

    if (this.getSupporterByRelationshipId(input.fanboxRelationshipId) !== null) {
      throw new DuplicateFanboxRelationshipError(input.fanboxRelationshipId);
    }

    const id = randomUUID();
    const timestamp = timestampFromClock(this.clock);
    try {
      this.database
        .prepare(
          `INSERT INTO supporters (
             id,
             fanbox_relationship_id,
             display_name,
             current_level,
             supporting,
             latest_month_key,
             created_at,
             updated_at
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`,
        )
        .run(
          id,
          input.fanboxRelationshipId,
          input.displayName,
          input.initialLevel === undefined ? 0 : input.initialLevel,
          input.supporting ? 1 : 0,
          timestamp,
          timestamp,
        );
    } catch (error: unknown) {
      if (
        isUniqueConstraintError(error) &&
        this.getSupporterByRelationshipId(input.fanboxRelationshipId) !== null
      ) {
        throw new DuplicateFanboxRelationshipError(input.fanboxRelationshipId);
      }

      throw error;
    }

    const supporter = this.getSupporterById(id);
    if (supporter === null) {
      throw new Error("created supporter could not be loaded");
    }

    return supporter;
  }

  getSupporterById(id: string): SupporterRecord | null {
    assertValidSupporterId(id);
    const row = this.database
      .prepare("SELECT * FROM supporters WHERE id = ?")
      .get(id) as SupporterRow | undefined;

    return row === undefined ? null : toSupporterRecord(row);
  }

  getSupporterByRelationshipId(
    fanboxRelationshipId: string,
  ): SupporterRecord | null {
    assertNonBlankString(fanboxRelationshipId, "fanboxRelationshipId");
    const row = this.database
      .prepare("SELECT * FROM supporters WHERE fanbox_relationship_id = ?")
      .get(fanboxRelationshipId) as SupporterRow | undefined;

    return row === undefined ? null : toSupporterRecord(row);
  }

  updateSupporterProfile(
    id: string,
    patch: SupporterProfilePatch,
  ): SupporterRecord {
    assertValidSupporterId(id);
    assertValidSupporterProfilePatch(patch);

    const fields: string[] = [];
    const values: Array<string | number> = [];
    if ("displayName" in patch) {
      fields.push("display_name = ?");
      values.push(patch.displayName as string);
    }
    if ("supporting" in patch) {
      fields.push("supporting = ?");
      values.push(patch.supporting ? 1 : 0);
    }

    const timestamp = timestampFromClock(this.clock);
    values.push(timestamp, id);
    const result = this.database
      .prepare(
        `UPDATE supporters
         SET ${fields.join(", ")}, updated_at = ?
         WHERE id = ?`,
      )
      .run(...values);

    if (result.changes === 0) {
      throw new SupporterNotFoundError(id);
    }

    const supporter = this.getSupporterById(id);
    if (supporter === null) {
      throw new Error("updated supporter could not be loaded");
    }

    return supporter;
  }

  getMonthlyState(
    supporterId: string,
    monthKey: string,
  ): MonthlyStateRecord | null {
    assertValidSupporterId(supporterId);
    assertValidMonthKey(monthKey);

    const row = this.database
      .prepare(
        `SELECT *
         FROM supporter_month_states
         WHERE supporter_id = ? AND month_key = ?`,
      )
      .get(supporterId, monthKey) as MonthlyStateRow | undefined;

    return row === undefined ? null : toMonthlyStateRecord(row);
  }

  transitionMonthlyState(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
  ): MonthlyStateRecord {
    assertValidSupporterId(supporterId);
    assertValidMonthKey(monthKey);
    assertValidTransitionCallback(transition);

    const timestamp = timestampFromClock(this.clock);
    const runTransition = this.database.transaction(
      (): MonthlyStateRecord => {
        const supporterRow = this.database
          .prepare("SELECT * FROM supporters WHERE id = ?")
          .get(supporterId) as SupporterRow | undefined;

        if (supporterRow === undefined) {
          throw new SupporterNotFoundError(supporterId);
        }

        let stateRow: MonthlyStateRow;
        if (supporterRow.latest_month_key === null) {
          this.database
            .prepare(
              `INSERT INTO supporter_month_states (
                 supporter_id,
                 month_key,
                 level,
                 monthly_plus_one_used,
                 lottery_participation_occurred,
                 created_at,
                 updated_at
               ) VALUES (?, ?, ?, 0, 0, ?, ?)`,
            )
            .run(
              supporterId,
              monthKey,
              supporterRow.current_level,
              timestamp,
              timestamp,
            );
          this.database
            .prepare(
              `UPDATE supporters
               SET latest_month_key = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(monthKey, timestamp, supporterId);

          stateRow = {
            supporter_id: supporterId,
            month_key: monthKey,
            level: supporterRow.current_level,
            monthly_plus_one_used: 0,
            lottery_participation_occurred: 0,
            created_at: timestamp,
            updated_at: timestamp,
          };
        } else if (monthKey < supporterRow.latest_month_key) {
          throw new StaleMonthError(monthKey, supporterRow.latest_month_key);
        } else if (monthKey === supporterRow.latest_month_key) {
          const loadedStateRow = this.database
            .prepare(
              `SELECT *
               FROM supporter_month_states
               WHERE supporter_id = ? AND month_key = ?`,
            )
            .get(supporterId, monthKey) as MonthlyStateRow | undefined;

          if (loadedStateRow === undefined) {
            throw new Error("latest supporter month state could not be loaded");
          }

          stateRow = loadedStateRow;
        } else {
          this.database
            .prepare(
              `INSERT INTO supporter_month_states (
                 supporter_id,
                 month_key,
                 level,
                 monthly_plus_one_used,
                 lottery_participation_occurred,
                 created_at,
                 updated_at
               ) VALUES (?, ?, ?, 0, 0, ?, ?)`,
            )
            .run(
              supporterId,
              monthKey,
              supporterRow.current_level,
              timestamp,
              timestamp,
            );
          this.database
            .prepare(
              `UPDATE supporters
               SET latest_month_key = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(monthKey, timestamp, supporterId);

          stateRow = {
            supporter_id: supporterId,
            month_key: monthKey,
            level: supporterRow.current_level,
            monthly_plus_one_used: 0,
            lottery_participation_occurred: 0,
            created_at: timestamp,
            updated_at: timestamp,
          };
        }

        const snapshot = Object.freeze({
          level: stateRow.level,
          monthlyPlusOneUsed: stateRow.monthly_plus_one_used === 1,
          lotteryParticipationOccurred:
            stateRow.lottery_participation_occurred === 1,
        });
        const result = validateTransitionResult(transition(snapshot));

        if (snapshot.monthlyPlusOneUsed && !result.monthlyPlusOneUsed) {
          throw new RangeError("monthlyPlusOneUsed cannot change from true to false");
        }
        if (
          snapshot.lotteryParticipationOccurred &&
          !result.lotteryParticipationOccurred
        ) {
          throw new RangeError(
            "lotteryParticipationOccurred cannot change from true to false",
          );
        }

        this.database
          .prepare(
            `UPDATE supporter_month_states
             SET level = ?,
                 monthly_plus_one_used = ?,
                 lottery_participation_occurred = ?,
                 updated_at = ?
             WHERE supporter_id = ? AND month_key = ?`,
          )
          .run(
            result.level,
            result.monthlyPlusOneUsed ? 1 : 0,
            result.lotteryParticipationOccurred ? 1 : 0,
            timestamp,
            supporterId,
            monthKey,
          );
        this.database
          .prepare(
            `UPDATE supporters
             SET current_level = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(result.level, timestamp, supporterId);

        const persistedRow = this.database
          .prepare(
            `SELECT *
             FROM supporter_month_states
             WHERE supporter_id = ? AND month_key = ?`,
          )
          .get(supporterId, monthKey) as MonthlyStateRow | undefined;
        if (persistedRow === undefined) {
          throw new Error("persisted supporter month state could not be loaded");
        }

        return toMonthlyStateRecord(persistedRow);
      },
    );

    return runTransition();
  }
}

export function openLocalStore(
  databasePath: string,
  options?: OpenLocalStoreOptions,
): LocalStore {
  assertNonBlankString(databasePath, "databasePath");
  const clock = resolveClock(options);
  timestampFromClock(clock);

  const database = new Database(databasePath);
  try {
    configureDatabase(database);
    const userVersion = readUserVersion(database);
    if (userVersion > CURRENT_SCHEMA_VERSION) {
      throw new UnsupportedSchemaVersionError(
        userVersion,
        CURRENT_SCHEMA_VERSION,
      );
    }
    configureFileJournalMode(database, databasePath);
    if (userVersion === 0) {
      applyVersionOneMigration(database);
    }

    return new LocalStoreImplementation(database, clock);
  } catch (error: unknown) {
    if (database.open) {
      database.close();
    }
    throw error;
  }
}
