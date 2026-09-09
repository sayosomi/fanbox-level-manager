import type {
  EntryCountOperationRecord,
  LocalStore,
} from "@sayosomi/storage";

export type SupporterHistoryReason =
  | "当選"
  | "抽選結果による口数増加"
  | "抽選不参加による口数増加"
  | "旧管理方式による履歴";

export type SupporterHistoryEntry = Readonly<{
  id: string;
  monthKey: string;
  entryCount: number;
  reason: SupporterHistoryReason;
  occurredAt: string | null;
  recordedAt: string;
}>;

export interface SupporterHistoryService {
  getSupporterHistory(
    supporterId: string,
  ): readonly SupporterHistoryEntry[];
}

function reasonForOperation(
  operation: EntryCountOperationRecord,
): SupporterHistoryReason | null {
  switch (operation.kind) {
    case "initial_import":
      return "旧管理方式による履歴";
    case "lottery_loss":
      return operation.afterEntryCount === operation.beforeEntryCount
        ? null
        : "抽選結果による口数増加";
    case "lottery_win":
      return operation.afterEntryCount === operation.beforeEntryCount ? null : "当選";
    case "month_end":
      return operation.afterEntryCount === operation.beforeEntryCount
        ? null
        : "抽選不参加による口数増加";
  }
}

function toSupporterHistoryEntry(
  operation: EntryCountOperationRecord,
  reason: SupporterHistoryReason,
): SupporterHistoryEntry {
  return Object.freeze({
    id: operation.id,
    monthKey: operation.monthKey,
    entryCount: operation.afterEntryCount,
    reason,
    occurredAt: operation.occurredAt,
    recordedAt: operation.createdAt,
  });
}

export function createSupporterHistoryService(
  store: LocalStore,
): SupporterHistoryService {
  return {
    getSupporterHistory(supporterId) {
      const entries: SupporterHistoryEntry[] = [];

      for (const operation of store.listEntryCountOperations(supporterId)) {
        const reason = reasonForOperation(operation);
        if (reason === null) {
          continue;
        }

        entries.push(toSupporterHistoryEntry(operation, reason));
      }

      return Object.freeze(entries.reverse());
    },
  };
}
