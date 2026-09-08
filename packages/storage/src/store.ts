import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  DuplicateFanboxRelationshipError,
  PortalAccessNotIssuedError,
  PortalAccessNotProvisionedError,
  PortalTokenHashConflictError,
  StaleMonthError,
  StalePortalAccessError,
  SupporterNotFoundError,
  UnsupportedSchemaVersionError,
} from "./errors.js";
import {
  applyVersionOneMigration,
  applyVersionTwoMigration,
  applyVersionThreeMigration,
  applyVersionFourMigration,
  configureDatabase,
  configureFileJournalMode,
  CURRENT_SCHEMA_VERSION,
  readUserVersion,
} from "./migrations.js";
import type {
  ApplyFanboxSupporterImportInput,
  CreateMigratedSupporterInput,
  CreateMigratedSupporterResult,
  CreateSupporterInput,
  FanboxSupporterImportRecord,
  LevelOperationRecord,
  LevelTransitionOperationInput,
  LocalStore,
  MonthlyStateRecord,
  MonthlyTransitionWithOperationBatchItem,
  MonthlyStateTransition,
  MonthlyTransitionWithOperationResult,
  OpenLocalStoreOptions,
  StoreClock,
  SupporterProfilePatch,
  SupporterPortalAccessRecord,
  SupporterRecord,
} from "./types.js";
import {
  assertNonBlankString,
  assertValidApplyFanboxSupporterImportInput,
  assertValidCreateMigratedSupporterInput,
  assertValidCreateSupporterInput,
  assertValidMonthKey,
  assertValidMonthlyTransitionWithOperationBatch,
  assertValidSupporterId,
  assertValidSupporterProfilePatch,
  assertValidTransitionCallback,
  normalizeLevelTransitionOperation,
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

type LevelOperationRow = {
  sequence: number;
  id: string;
  supporter_id: string;
  month_key: string;
  kind: LevelOperationRecord["kind"];
  before_level: number;
  after_level: number;
  occurred_at: string | null;
  supporting_at_month_end: number | null;
  created_at: string;
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

type SupporterPortalAccessRow = {
  supporter_id: string;
  token_hash: string;
  issued_at: string;
  provisioned_at: string | null;
  sent_at: string | null;
};

type FanboxSupporterImportRow = {
  sequence: number;
  imported_at: string;
  present_supporter_count: number;
};

type SupporterInsertValues = Readonly<{
  id: string;
  fanboxRelationshipId: string;
  displayName: string;
  currentLevel: number;
  supporting: boolean;
  timestamp: string;
}>;

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

function toLevelOperationRecord(row: LevelOperationRow): LevelOperationRecord {
  return Object.freeze({
    id: row.id,
    supporterId: row.supporter_id,
    monthKey: row.month_key,
    kind: row.kind,
    beforeLevel: row.before_level,
    afterLevel: row.after_level,
    occurredAt: row.occurred_at,
    supportingAtMonthEnd:
      row.supporting_at_month_end === null
        ? null
        : row.supporting_at_month_end === 1,
    createdAt: row.created_at,
  });
}

function toSupporterPortalAccessRecord(
  row: SupporterPortalAccessRow,
): SupporterPortalAccessRecord {
  return Object.freeze({
    supporterId: row.supporter_id,
    tokenHash: row.token_hash,
    issuedAt: row.issued_at,
    provisionedAt: row.provisioned_at,
    sentAt: row.sent_at,
  });
}

function toFanboxSupporterImportRecord(
  row: FanboxSupporterImportRow,
): FanboxSupporterImportRecord {
  return Object.freeze({
    sequence: row.sequence,
    importedAt: row.imported_at,
    presentSupporterCount: row.present_supporter_count,
  });
}

const PORTAL_TOKEN_HASH_PATTERN = /^[0-9a-f]{64}$/;

function assertValidPortalTokenHash(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== "string" || !PORTAL_TOKEN_HASH_PATTERN.test(value)) {
    throw new TypeError(`${fieldName} must be a lowercase SHA-256 hex string`);
  }
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

  createDatabaseSnapshot(): Uint8Array {
    return this.database.serialize();
  }

  createSupporter(input: CreateSupporterInput): SupporterRecord {
    assertValidCreateSupporterInput(input);

    if (this.getSupporterByRelationshipId(input.fanboxRelationshipId) !== null) {
      throw new DuplicateFanboxRelationshipError(input.fanboxRelationshipId);
    }

    const id = randomUUID();
    const timestamp = timestampFromClock(this.clock);
    try {
      this.insertSupporterRow({
        id,
        fanboxRelationshipId: input.fanboxRelationshipId,
        displayName: input.displayName,
        currentLevel: input.initialLevel === undefined ? 0 : input.initialLevel,
        supporting: input.supporting,
        timestamp,
      });
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

  applyFanboxSupporterImport(
    input: ApplyFanboxSupporterImportInput,
  ): FanboxSupporterImportRecord {
    assertValidApplyFanboxSupporterImportInput(input);
    const timestamp = timestampFromClock(this.clock);

    const apply = this.database.transaction((): FanboxSupporterImportRecord => {
      for (const create of input.creates) {
        this.insertSupporterRow({
          id: randomUUID(),
          fanboxRelationshipId: create.fanboxRelationshipId,
          displayName: create.displayName,
          currentLevel: 0,
          supporting: true,
          timestamp,
        });
      }

      for (const update of input.updates) {
        const existing = this.database
          .prepare("SELECT id FROM supporters WHERE id = ?")
          .get(update.supporterId) as { id: string } | undefined;
        if (existing === undefined) {
          throw new SupporterNotFoundError(update.supporterId);
        }

        const fields: string[] = [];
        const values: Array<string | number> = [];
        if ("displayName" in update) {
          fields.push("display_name = ?");
          values.push(update.displayName as string);
        }
        if ("supporting" in update) {
          fields.push("supporting = ?");
          values.push(update.supporting ? 1 : 0);
        }
        values.push(timestamp, update.supporterId);

        const result = this.database
          .prepare(
            `UPDATE supporters
             SET ${fields.join(", ")}, updated_at = ?
             WHERE id = ?`,
          )
          .run(...values);
        if (result.changes !== 1) {
          throw new SupporterNotFoundError(update.supporterId);
        }
      }

      const insertResult = this.database
        .prepare(
          `INSERT INTO fanbox_supporter_imports (
             imported_at,
             present_supporter_count
           ) VALUES (?, ?)`,
        )
        .run(timestamp, input.presentSupporterCount);
      const sequence = Number(insertResult.lastInsertRowid);
      const row = this.database
        .prepare(
          `SELECT sequence,
                  imported_at,
                  present_supporter_count
           FROM fanbox_supporter_imports
           WHERE sequence = ?`,
        )
        .get(sequence) as FanboxSupporterImportRow | undefined;
      if (row === undefined) {
        throw new Error("created FANBOX supporter import could not be loaded");
      }

      return toFanboxSupporterImportRecord(row);
    });

    return apply();
  }

  getLatestFanboxSupporterImport(): FanboxSupporterImportRecord | null {
    const row = this.database
      .prepare(
        `SELECT sequence,
                imported_at,
                present_supporter_count
         FROM fanbox_supporter_imports
         ORDER BY sequence DESC
         LIMIT 1`,
      )
      .get() as FanboxSupporterImportRow | undefined;

    return row === undefined ? null : toFanboxSupporterImportRecord(row);
  }

  createMigratedSupporter(
    input: CreateMigratedSupporterInput,
  ): CreateMigratedSupporterResult {
    assertValidCreateMigratedSupporterInput(input);

    if (this.getSupporterByRelationshipId(input.fanboxRelationshipId) !== null) {
      throw new DuplicateFanboxRelationshipError(input.fanboxRelationshipId);
    }

    const supporterId = randomUUID();
    const operationId = randomUUID();
    const timestamp = timestampFromClock(this.clock);

    const migrate = this.database.transaction((): CreateMigratedSupporterResult => {
      this.insertSupporterRow({
        id: supporterId,
        fanboxRelationshipId: input.fanboxRelationshipId,
        displayName: input.displayName,
        currentLevel: input.currentLevel,
        supporting: input.supporting,
        timestamp,
      });

      this.database
        .prepare(
          `INSERT INTO level_operations (
             id,
             supporter_id,
             month_key,
             kind,
             before_level,
             after_level,
             occurred_at,
             supporting_at_month_end,
             created_at
           ) VALUES (?, ?, ?, 'initial_import', ?, ?, NULL, NULL, ?)`,
        )
        .run(
          operationId,
          supporterId,
          input.monthKey,
          input.currentLevel,
          input.currentLevel,
          timestamp,
        );

      const supporter = this.getSupporterById(supporterId);
      if (supporter === null) {
        throw new Error("created migrated supporter could not be loaded");
      }

      const operation = this.database
        .prepare(
          `SELECT sequence,
                  id,
                  supporter_id,
                  month_key,
                  kind,
                  before_level,
                  after_level,
                  occurred_at,
                  supporting_at_month_end,
                  created_at
           FROM level_operations
           WHERE id = ?`,
        )
        .get(operationId) as LevelOperationRow | undefined;
      if (operation === undefined) {
        throw new Error("created migrated operation could not be loaded");
      }

      return Object.freeze({
        supporter,
        operation: toLevelOperationRecord(operation),
      });
    });

    try {
      return migrate();
    } catch (error: unknown) {
      if (
        isUniqueConstraintError(error) &&
        this.getSupporterByRelationshipId(input.fanboxRelationshipId) !== null
      ) {
        throw new DuplicateFanboxRelationshipError(input.fanboxRelationshipId);
      }

      throw error;
    }
  }

  private insertSupporterRow(values: SupporterInsertValues): void {
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
        values.id,
        values.fanboxRelationshipId,
        values.displayName,
        values.currentLevel,
        values.supporting ? 1 : 0,
        values.timestamp,
        values.timestamp,
      );
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

  listSupporters(): readonly SupporterRecord[] {
    const rows = this.database
      .prepare(
        `SELECT *
         FROM supporters
         ORDER BY supporting DESC, display_name COLLATE NOCASE ASC, id ASC`,
      )
      .all() as SupporterRow[];

    return Object.freeze(rows.map(toSupporterRecord));
  }

  getSupporterPortalAccess(
    supporterId: string,
  ): SupporterPortalAccessRecord | null {
    assertValidSupporterId(supporterId);
    if (this.getSupporterById(supporterId) === null) {
      throw new SupporterNotFoundError(supporterId);
    }

    const row = this.database
      .prepare(
        `SELECT supporter_id,
                token_hash,
                issued_at,
                provisioned_at,
                sent_at
         FROM supporter_portal_access
         WHERE supporter_id = ?`,
      )
      .get(supporterId) as SupporterPortalAccessRow | undefined;

    return row === undefined ? null : toSupporterPortalAccessRecord(row);
  }

  replaceSupporterPortalAccessToken(
    supporterId: string,
    tokenHash: string,
  ): SupporterPortalAccessRecord {
    assertValidSupporterId(supporterId);
    assertValidPortalTokenHash(tokenHash, "tokenHash");

    const replace = this.database.transaction((): SupporterPortalAccessRecord => {
      if (this.getSupporterById(supporterId) === null) {
        throw new SupporterNotFoundError(supporterId);
      }

      const owner = this.database
        .prepare(
          `SELECT supporter_id
           FROM supporter_portal_access
           WHERE token_hash = ?`,
        )
        .get(tokenHash) as { supporter_id: string } | undefined;
      if (owner !== undefined && owner.supporter_id !== supporterId) {
        throw new PortalTokenHashConflictError(supporterId);
      }

      const timestamp = timestampFromClock(this.clock);
      this.database
        .prepare(
          `INSERT INTO supporter_portal_access (
             supporter_id,
             token_hash,
             issued_at,
             provisioned_at,
             sent_at
           ) VALUES (?, ?, ?, NULL, NULL)
           ON CONFLICT(supporter_id) DO UPDATE SET
             token_hash = excluded.token_hash,
             issued_at = excluded.issued_at,
             provisioned_at = NULL,
             sent_at = NULL`,
        )
        .run(supporterId, tokenHash, timestamp);

      const row = this.getSupporterPortalAccessRow(supporterId);
      if (row === undefined) {
        throw new Error("replaced supporter portal access could not be loaded");
      }

      return toSupporterPortalAccessRecord(row);
    });

    try {
      return replace();
    } catch (error: unknown) {
      if (isUniqueConstraintError(error)) {
        const owner = this.database
          .prepare(
            `SELECT supporter_id
             FROM supporter_portal_access
             WHERE token_hash = ?`,
          )
          .get(tokenHash) as { supporter_id: string } | undefined;
        if (owner !== undefined && owner.supporter_id !== supporterId) {
          throw new PortalTokenHashConflictError(supporterId);
        }
      }

      throw error;
    }
  }

  markSupporterPortalAccessProvisioned(
    supporterId: string,
    expectedTokenHash: string,
  ): SupporterPortalAccessRecord {
    assertValidSupporterId(supporterId);
    assertValidPortalTokenHash(expectedTokenHash, "expectedTokenHash");

    const mark = this.database.transaction((): SupporterPortalAccessRecord => {
      if (this.getSupporterById(supporterId) === null) {
        throw new SupporterNotFoundError(supporterId);
      }

      const row = this.getSupporterPortalAccessRow(supporterId);
      if (row === undefined) {
        throw new PortalAccessNotIssuedError(supporterId);
      }
      if (row.token_hash !== expectedTokenHash) {
        throw new StalePortalAccessError(supporterId);
      }
      if (row.provisioned_at !== null) {
        return toSupporterPortalAccessRecord(row);
      }

      const timestamp = timestampFromClock(this.clock);
      this.database
        .prepare(
          `UPDATE supporter_portal_access
           SET provisioned_at = ?
           WHERE supporter_id = ? AND token_hash = ?`,
        )
        .run(timestamp, supporterId, expectedTokenHash);

      const persistedRow = this.getSupporterPortalAccessRow(supporterId);
      if (persistedRow === undefined) {
        throw new Error("provisioned supporter portal access could not be loaded");
      }

      return toSupporterPortalAccessRecord(persistedRow);
    });

    return mark();
  }

  markSupporterPortalAccessSent(
    supporterId: string,
    expectedTokenHash: string,
  ): SupporterPortalAccessRecord {
    assertValidSupporterId(supporterId);
    assertValidPortalTokenHash(expectedTokenHash, "expectedTokenHash");

    const mark = this.database.transaction((): SupporterPortalAccessRecord => {
      if (this.getSupporterById(supporterId) === null) {
        throw new SupporterNotFoundError(supporterId);
      }

      const row = this.getSupporterPortalAccessRow(supporterId);
      if (row === undefined) {
        throw new PortalAccessNotIssuedError(supporterId);
      }
      if (row.token_hash !== expectedTokenHash) {
        throw new StalePortalAccessError(supporterId);
      }
      if (row.provisioned_at === null) {
        throw new PortalAccessNotProvisionedError(supporterId);
      }
      if (row.sent_at !== null) {
        return toSupporterPortalAccessRecord(row);
      }

      const timestamp = timestampFromClock(this.clock);
      this.database
        .prepare(
          `UPDATE supporter_portal_access
           SET sent_at = ?
           WHERE supporter_id = ? AND token_hash = ?`,
        )
        .run(timestamp, supporterId, expectedTokenHash);

      const persistedRow = this.getSupporterPortalAccessRow(supporterId);
      if (persistedRow === undefined) {
        throw new Error("sent supporter portal access could not be loaded");
      }

      return toSupporterPortalAccessRecord(persistedRow);
    });

    return mark();
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
    return this.runMonthlyTransition(supporterId, monthKey, transition, null);
  }

  transitionMonthlyStateWithOperation(
    supporterId: string,
    monthKey: string,
    operation: LevelTransitionOperationInput,
    transition: MonthlyStateTransition,
  ): MonthlyTransitionWithOperationResult {
    return this.runMonthlyTransition(
      supporterId,
      monthKey,
      transition,
      operation,
    );
  }

  transitionMonthlyStatesWithOperations(
    items: readonly MonthlyTransitionWithOperationBatchItem[],
  ): readonly MonthlyTransitionWithOperationResult[] {
    assertValidMonthlyTransitionWithOperationBatch(items);
    const timestamp = timestampFromClock(this.clock);
    const runTransitions = this.database.transaction(
      (): readonly MonthlyTransitionWithOperationResult[] =>
        Object.freeze(
          items.map((item) =>
            this.runMonthlyTransitionInCurrentTransaction(
              item.supporterId,
              item.monthKey,
              item.transition,
              item.operation,
              timestamp,
            ),
          ),
        ),
    );

    return runTransitions();
  }

  listLevelOperations(supporterId: string): readonly LevelOperationRecord[] {
    assertValidSupporterId(supporterId);
    if (this.getSupporterById(supporterId) === null) {
      throw new SupporterNotFoundError(supporterId);
    }

    const rows = this.database
      .prepare(
        `SELECT sequence,
                id,
                supporter_id,
                month_key,
                kind,
                before_level,
                after_level,
                occurred_at,
                supporting_at_month_end,
                created_at
         FROM level_operations
         WHERE supporter_id = ?
         ORDER BY sequence ASC`,
      )
      .all(supporterId) as LevelOperationRow[];

    return Object.freeze(rows.map(toLevelOperationRecord));
  }

  private getSupporterPortalAccessRow(
    supporterId: string,
  ): SupporterPortalAccessRow | undefined {
    return this.database
      .prepare(
        `SELECT supporter_id,
                token_hash,
                issued_at,
                provisioned_at,
                sent_at
         FROM supporter_portal_access
         WHERE supporter_id = ?`,
      )
      .get(supporterId) as SupporterPortalAccessRow | undefined;
  }

  private runMonthlyTransition(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
    operation: null,
  ): MonthlyStateRecord;
  private runMonthlyTransition(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
    operation: LevelTransitionOperationInput,
  ): MonthlyTransitionWithOperationResult;
  private runMonthlyTransition(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
    operation: LevelTransitionOperationInput | null,
  ): MonthlyStateRecord | MonthlyTransitionWithOperationResult {
    assertValidSupporterId(supporterId);
    assertValidMonthKey(monthKey);
    assertValidTransitionCallback(transition);

    const timestamp = timestampFromClock(this.clock);
    const runTransition = this.database.transaction(
      (): MonthlyStateRecord | MonthlyTransitionWithOperationResult => {
        if (operation === null) {
          return this.runMonthlyTransitionInCurrentTransaction(
            supporterId,
            monthKey,
            transition,
            null,
            timestamp,
          );
        }

        return this.runMonthlyTransitionInCurrentTransaction(
          supporterId,
          monthKey,
          transition,
          operation,
          timestamp,
        );
      },
    );

    return runTransition();
  }

  private runMonthlyTransitionInCurrentTransaction(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
    operation: null,
    timestamp: string,
  ): MonthlyStateRecord;
  private runMonthlyTransitionInCurrentTransaction(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
    operation: LevelTransitionOperationInput,
    timestamp: string,
  ): MonthlyTransitionWithOperationResult;
  private runMonthlyTransitionInCurrentTransaction(
    supporterId: string,
    monthKey: string,
    transition: MonthlyStateTransition,
    operation: LevelTransitionOperationInput | null,
    timestamp: string,
  ): MonthlyStateRecord | MonthlyTransitionWithOperationResult {
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

    const normalizedOperation =
      operation === null ? null : normalizeLevelTransitionOperation(operation);

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

    const persistedState = toMonthlyStateRecord(persistedRow);
    if (normalizedOperation === null) {
      return persistedState;
    }

    const operationId = randomUUID();
    this.database
      .prepare(
        `INSERT INTO level_operations (
           id,
           supporter_id,
           month_key,
           kind,
           before_level,
           after_level,
           occurred_at,
           supporting_at_month_end,
           created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        operationId,
        supporterId,
        monthKey,
        normalizedOperation.kind,
        snapshot.level,
        result.level,
        normalizedOperation.occurredAt,
        normalizedOperation.supportingAtMonthEnd === null
          ? null
          : normalizedOperation.supportingAtMonthEnd
            ? 1
            : 0,
        timestamp,
      );

    const persistedOperation = this.database
      .prepare(
        `SELECT sequence,
                id,
                supporter_id,
                month_key,
                kind,
                before_level,
                after_level,
                occurred_at,
                supporting_at_month_end,
                created_at
         FROM level_operations
         WHERE id = ?`,
      )
      .get(operationId) as LevelOperationRow | undefined;
    if (persistedOperation === undefined) {
      throw new Error("persisted level operation could not be loaded");
    }

    return Object.freeze({
      state: persistedState,
      operation: toLevelOperationRecord(persistedOperation),
    });
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
      applyVersionTwoMigration(database);
      applyVersionThreeMigration(database);
      applyVersionFourMigration(database);
    } else if (userVersion === 1) {
      applyVersionTwoMigration(database);
      applyVersionThreeMigration(database);
      applyVersionFourMigration(database);
    } else if (userVersion === 2) {
      applyVersionThreeMigration(database);
      applyVersionFourMigration(database);
    } else if (userVersion === 3) {
      applyVersionFourMigration(database);
    }

    return new LocalStoreImplementation(database, clock);
  } catch (error: unknown) {
    if (database.open) {
      database.close();
    }
    throw error;
  }
}
