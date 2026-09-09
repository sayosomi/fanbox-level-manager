import {
  DuplicateFanboxRelationshipError,
  FanboxRelationshipNotFoundError,
  type LocalStore,
} from "@sayosomi/storage";

export type FanboxIdentityRelinkInput = Readonly<{
  currentFanboxRelationshipId: string;
  replacementFanboxRelationshipId: string;
}>;

const GENERIC_ERROR_MESSAGE = "Failed to relink FANBOX relationship identity.";

export class FanboxIdentityRelinkError extends Error {
  constructor() {
    super(GENERIC_ERROR_MESSAGE);
    this.name = "FanboxIdentityRelinkError";
  }
}

export interface FanboxIdentityRelinkService {
  relinkSupporter(input: FanboxIdentityRelinkInput): void;
}

export function createFanboxIdentityRelinkService(
  store: LocalStore,
): FanboxIdentityRelinkService {
  return {
    relinkSupporter(input) {
      try {
        store.relinkSupporterFanboxRelationship(input);
      } catch (error: unknown) {
        if (
          error instanceof FanboxRelationshipNotFoundError ||
          error instanceof DuplicateFanboxRelationshipError
        ) {
          throw error;
        }

        throw new FanboxIdentityRelinkError();
      }
    },
  };
}
