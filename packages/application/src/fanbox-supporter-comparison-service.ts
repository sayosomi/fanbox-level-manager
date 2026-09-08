import type { LocalStore, SupporterRecord } from "@sayosomi/storage";
import type {
  FanboxPdfInspection,
  FanboxPdfInspectionRelationship,
} from "./fanbox-pdf-inspection-service.js";

export type FanboxPdfPresentSupporterStatus =
  | "new"
  | "continuing"
  | "returning";

export type FanboxPdfPresentSupporterComparison =
  | Readonly<{
      status: "new";
      relationshipId: string;
      displayNameCandidate: string | null;
      supporterId: null;
      storedDisplayName: null;
    }>
  | Readonly<{
      status: "continuing" | "returning";
      relationshipId: string;
      displayNameCandidate: string | null;
      supporterId: string;
      storedDisplayName: string;
    }>;

export type FanboxPdfAbsentSupporterComparison = Readonly<{
  status: "absent";
  supporterId: string;
  relationshipId: string;
  storedDisplayName: string;
  wasSupporting: boolean;
}>;

export type FanboxPdfSupporterComparison = Readonly<{
  presentSupporters: readonly FanboxPdfPresentSupporterComparison[];
  absentSupporters: readonly FanboxPdfAbsentSupporterComparison[];
}>;

const GENERIC_ERROR_MESSAGE = "Failed to compare FANBOX supporters.";

export class FanboxSupporterComparisonError extends Error {
  constructor(message = GENERIC_ERROR_MESSAGE) {
    super(message);
    this.name = "FanboxSupporterComparisonError";
  }
}

export interface FanboxSupporterComparisonService {
  compareInspection(
    inspection: FanboxPdfInspection,
  ): FanboxPdfSupporterComparison;
}

function comparePresentSupporter(
  relationship: FanboxPdfInspectionRelationship,
  supporter: SupporterRecord | undefined,
): FanboxPdfPresentSupporterComparison {
  if (supporter === undefined) {
    return Object.freeze({
      status: "new" as const,
      relationshipId: relationship.relationshipId,
      displayNameCandidate: relationship.displayNameCandidate,
      supporterId: null,
      storedDisplayName: null,
    });
  }

  return Object.freeze({
    status: supporter.supporting ? ("continuing" as const) : ("returning" as const),
    relationshipId: relationship.relationshipId,
    displayNameCandidate: relationship.displayNameCandidate,
    supporterId: supporter.id,
    storedDisplayName: supporter.displayName,
  });
}

function compareAbsentSupporter(
  supporter: SupporterRecord,
): FanboxPdfAbsentSupporterComparison {
  return Object.freeze({
    status: "absent" as const,
    supporterId: supporter.id,
    relationshipId: supporter.fanboxRelationshipId,
    storedDisplayName: supporter.displayName,
    wasSupporting: supporter.supporting,
  });
}

export function createFanboxSupporterComparisonService(
  store: LocalStore,
): FanboxSupporterComparisonService {
  return {
    compareInspection(inspection) {
      let supporters: readonly SupporterRecord[];
      try {
        supporters = store.listSupporters();
      } catch {
        throw new FanboxSupporterComparisonError();
      }

      const supporterByRelationshipId = new Map(
        supporters.map(
          (supporter): readonly [string, SupporterRecord] => [
            supporter.fanboxRelationshipId,
            supporter,
          ],
        ),
      );
      const presentRelationshipIds = new Set(
        inspection.relationshipLinks.map(
          (relationship) => relationship.relationshipId,
        ),
      );
      const presentSupporters = Object.freeze(
        inspection.relationshipLinks.map((relationship) =>
          comparePresentSupporter(
            relationship,
            supporterByRelationshipId.get(relationship.relationshipId),
          ),
        ),
      );
      const absentSupporters = Object.freeze(
        supporters
          .filter(
            (supporter) =>
              !presentRelationshipIds.has(supporter.fanboxRelationshipId),
          )
          .map(compareAbsentSupporter),
      );

      return Object.freeze({ presentSupporters, absentSupporters });
    },
  };
}
