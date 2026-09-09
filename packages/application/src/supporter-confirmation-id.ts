import { createHash } from "node:crypto";

const CONFIRMATION_ID_HEX_LENGTH = 16;
const CONFIRMATION_ID_GROUP_LENGTH = 4;

export function deriveSupporterConfirmationId(supporterId: string): string {
  const hex = createHash("sha256")
    .update(supporterId, "utf8")
    .digest("hex")
    .slice(0, CONFIRMATION_ID_HEX_LENGTH)
    .toUpperCase();

  const groups: string[] = [];
  for (
    let offset = 0;
    offset < hex.length;
    offset += CONFIRMATION_ID_GROUP_LENGTH
  ) {
    groups.push(hex.slice(offset, offset + CONFIRMATION_ID_GROUP_LENGTH));
  }

  return groups.join("-");
}
