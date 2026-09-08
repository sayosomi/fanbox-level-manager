import type {
  FanboxSupporterImportCreate,
  FanboxSupporterImportRecord,
  FanboxSupporterImportUpdate,
  LocalStore,
} from "@sayosomi/storage";
import {
  createFanboxSupporterComparisonService,
  type FanboxPdfSupporterComparison,
  type FanboxSupporterComparisonService,
} from "./fanbox-supporter-comparison-service.js";
import type { FanboxPdfInspection } from "./fanbox-pdf-inspection-service.js";

export type FanboxSupporterImportBlockedReason =
  | "empty_relationships"
  | "duplicate_relationship_id"
  | "new_display_name_unavailable";

const BLOCKED_ERROR_MESSAGE = "FANBOX supporter import cannot be applied.";
const GENERIC_ERROR_MESSAGE = "Failed to import FANBOX supporters.";

export class FanboxSupporterImportBlockedError extends Error {
  readonly reason: FanboxSupporterImportBlockedReason;

  constructor(reason: FanboxSupporterImportBlockedReason) {
    super(BLOCKED_ERROR_MESSAGE);
    this.name = "FanboxSupporterImportBlockedError";
    this.reason = reason;
  }
}

export class FanboxSupporterImportError extends Error {
  constructor() {
    super(GENERIC_ERROR_MESSAGE);
    this.name = "FanboxSupporterImportError";
  }
}

export type FanboxSupporterImportResult = Readonly<{
  comparison: FanboxPdfSupporterComparison;
  importRecord: FanboxSupporterImportRecord;
}>;

export interface FanboxSupporterImportService {
  applyInspection(inspection: FanboxPdfInspection): FanboxSupporterImportResult;
}

type MutableImportUpdate = {
  supporterId: string;
  displayName?: string;
  supporting?: boolean;
};

function hasUsableDisplayNameCandidate(
  candidate: string | null,
): candidate is string {
  return candidate !== null && candidate.trim().length > 0;
}

function addUpdate(
  updates: Map<string, MutableImportUpdate>,
  supporterId: string,
  patch: Readonly<{
    displayName?: string;
    supporting?: boolean;
  }>,
): void {
  const existing = updates.get(supporterId);
  updates.set(supporterId, {
    ...existing,
    supporterId,
    ...patch,
  });
}

function buildImportPlan(
  comparison: FanboxPdfSupporterComparison,
  presentSupporterCount: number,
): {
  creates: readonly FanboxSupporterImportCreate[];
  updates: readonly FanboxSupporterImportUpdate[];
  presentSupporterCount: number;
} {
  const creates: FanboxSupporterImportCreate[] = [];
  const updates = new Map<string, MutableImportUpdate>();

  for (const supporter of comparison.presentSupporters) {
    if (supporter.status === "new") {
      if (!hasUsableDisplayNameCandidate(supporter.displayNameCandidate)) {
        throw new FanboxSupporterImportBlockedError(
          "new_display_name_unavailable",
        );
      }
      creates.push({
        fanboxRelationshipId: supporter.relationshipId,
        displayName: supporter.displayNameCandidate,
      });
      continue;
    }

    if (
      hasUsableDisplayNameCandidate(supporter.displayNameCandidate) &&
      supporter.displayNameCandidate !== supporter.storedDisplayName
    ) {
      addUpdate(updates, supporter.supporterId, {
        displayName: supporter.displayNameCandidate,
      });
    }
    if (supporter.status === "returning") {
      addUpdate(updates, supporter.supporterId, { supporting: true });
    }
  }

  for (const supporter of comparison.absentSupporters) {
    if (supporter.wasSupporting) {
      addUpdate(updates, supporter.supporterId, { supporting: false });
    }
  }

  return {
    creates,
    updates: [...updates.values()],
    presentSupporterCount,
  };
}

function assertNoDuplicateRelationshipIds(
  inspection: FanboxPdfInspection,
): void {
  const relationshipIds = new Set<string>();
  for (const relationship of inspection.relationshipLinks) {
    if (relationshipIds.has(relationship.relationshipId)) {
      throw new FanboxSupporterImportBlockedError(
        "duplicate_relationship_id",
      );
    }
    relationshipIds.add(relationship.relationshipId);
  }
}

export function createFanboxSupporterImportService(
  store: LocalStore,
): FanboxSupporterImportService {
  const comparisonService: FanboxSupporterComparisonService =
    createFanboxSupporterComparisonService(store);

  return {
    applyInspection(inspection) {
      try {
        if (inspection.relationshipLinks.length === 0) {
          throw new FanboxSupporterImportBlockedError("empty_relationships");
        }
        assertNoDuplicateRelationshipIds(inspection);

        const comparison = comparisonService.compareInspection(inspection);
        const plan = buildImportPlan(
          comparison,
          inspection.relationshipLinks.length,
        );
        const importRecord = store.applyFanboxSupporterImport(plan);

        return Object.freeze({ comparison, importRecord });
      } catch (error: unknown) {
        if (error instanceof FanboxSupporterImportBlockedError) {
          throw error;
        }
        throw new FanboxSupporterImportError();
      }
    },
  };
}
