// UTC calendar helpers shared by the jobs.

export const DAY_MS = 86_400_000;

/** `YYYY-MM-DD` (UTC) of `date`, shifted by `offsetDays`. */
export function utcDay(date: Date, offsetDays = 0): string {
  return new Date(date.getTime() + offsetDays * DAY_MS).toISOString().slice(0, 10);
}

export function isDay(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}
