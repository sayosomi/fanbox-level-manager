export class SupporterNotFoundError extends Error {
  readonly supporterId: string;

  constructor(supporterId: string) {
    super(`Supporter not found: ${supporterId}`);
    this.name = "SupporterNotFoundError";
    this.supporterId = supporterId;
  }
}

export class DuplicateFanboxRelationshipError extends Error {
  readonly fanboxRelationshipId: string;

  constructor(fanboxRelationshipId: string) {
    super(`FANBOX relationship already exists: ${fanboxRelationshipId}`);
    this.name = "DuplicateFanboxRelationshipError";
    this.fanboxRelationshipId = fanboxRelationshipId;
  }
}

export class FanboxRelationshipNotFoundError extends Error {
  readonly fanboxRelationshipId: string;

  constructor(fanboxRelationshipId: string) {
    super(`FANBOX relationship not found: ${fanboxRelationshipId}`);
    this.name = "FanboxRelationshipNotFoundError";
    this.fanboxRelationshipId = fanboxRelationshipId;
  }
}

export class StaleMonthError extends Error {
  readonly requestedMonthKey: string;
  readonly latestMonthKey: string;

  constructor(requestedMonthKey: string, latestMonthKey: string) {
    super(
      `Requested month ${requestedMonthKey} is older than latest month ${latestMonthKey}`,
    );
    this.name = "StaleMonthError";
    this.requestedMonthKey = requestedMonthKey;
    this.latestMonthKey = latestMonthKey;
  }
}

export class UnsupportedSchemaVersionError extends Error {
  readonly actualVersion: number;
  readonly supportedVersion: number;

  constructor(actualVersion: number, supportedVersion: number) {
    super(
      `Unsupported schema version ${actualVersion}; supported version is ${supportedVersion}`,
    );
    this.name = "UnsupportedSchemaVersionError";
    this.actualVersion = actualVersion;
    this.supportedVersion = supportedVersion;
  }
}

export class PortalAccessNotIssuedError extends Error {
  readonly supporterId: string;

  constructor(supporterId: string) {
    super(`Portal access has not been issued for supporter ${supporterId}`);
    this.name = "PortalAccessNotIssuedError";
    this.supporterId = supporterId;
  }
}

export class PortalAccessNotProvisionedError extends Error {
  readonly supporterId: string;

  constructor(supporterId: string) {
    super(`Portal access has not been provisioned for supporter ${supporterId}`);
    this.name = "PortalAccessNotProvisionedError";
    this.supporterId = supporterId;
  }
}

export class StalePortalAccessError extends Error {
  readonly supporterId: string;

  constructor(supporterId: string) {
    super(`Portal access acknowledgement is stale for supporter ${supporterId}`);
    this.name = "StalePortalAccessError";
    this.supporterId = supporterId;
  }
}

export class PortalTokenHashConflictError extends Error {
  readonly supporterId: string;

  constructor(supporterId: string) {
    super(`Portal access token hash is already owned by another supporter`);
    this.name = "PortalTokenHashConflictError";
    this.supporterId = supporterId;
  }
}
