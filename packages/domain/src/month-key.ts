export const TOKYO_TIME_ZONE = "Asia/Tokyo";

const tokyoMonthFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: TOKYO_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
});

export function monthKeyInTokyo(date: Date): string {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
    throw new RangeError("date must be a valid Date");
  }

  const parts = tokyoMonthFormatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;

  if (year === undefined || month === undefined) {
    throw new Error("could not derive a Tokyo month key");
  }

  return `${year}-${month}`;
}
