import type { FanboxRelationshipTextAssociation } from "./relationship-text.js";

export function deriveFanboxDisplayNameCandidate(
  association: FanboxRelationshipTextAssociation,
): string | null {
  const { textRuns } = association;
  if (textRuns.length < 2 || textRuns.length % 2 !== 0) {
    return null;
  }

  const halfLength = textRuns.length / 2;
  const firstHalfTexts: string[] = [];

  for (let index = 0; index < halfLength; index += 1) {
    const firstText = textRuns[index]?.text;
    const secondText = textRuns[index + halfLength]?.text;
    if (
      firstText === undefined ||
      secondText === undefined ||
      firstText === "" ||
      firstText !== secondText
    ) {
      return null;
    }

    firstHalfTexts.push(firstText);
  }

  return firstHalfTexts.join(" ");
}
