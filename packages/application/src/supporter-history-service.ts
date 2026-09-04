import type {
  LevelOperationRecord,
  LocalStore,
} from "@sayosomi/storage";

export type SupporterHistoryReason =
  | "当選"
  | "抽選結果によるレベルアップ"
  | "抽選不参加によるレベルアップ"
  | "旧管理方式による履歴";

export type SupporterHistoryEntry = Readonly<{
  id: string;
  monthKey: string;
  level: number;
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
  operation: LevelOperationRecord,
): SupporterHistoryReason | null {
  switch (operation.kind) {
    case "initial_import":
      return "旧管理方式による履歴";
    case "lottery_loss":
      return operation.afterLevel === operation.beforeLevel
        ? null
        : "抽選結果によるレベルアップ";
    case "lottery_win":
      return operation.afterLevel === operation.beforeLevel ? null : "当選";
    case "month_end":
      return operation.afterLevel === operation.beforeLevel
        ? null
        : "抽選不参加によるレベルアップ";
  }
}

function toSupporterHistoryEntry(
  operation: LevelOperationRecord,
  reason: SupporterHistoryReason,
): SupporterHistoryEntry {
  return Object.freeze({
    id: operation.id,
    monthKey: operation.monthKey,
    level: operation.afterLevel,
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

      for (const operation of store.listLevelOperations(supporterId)) {
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
