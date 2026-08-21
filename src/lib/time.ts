/**
 * Relative-time formatting for the UI, in natural Mexican Spanish
 * ("hace 2 días", "justo ahora"). Client-safe: no `fs`, no db.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const MONTH = 30 * DAY;
const YEAR = 365 * DAY;

function plural(n: number, singular: string, plural: string): string {
  return n === 1 ? singular : plural;
}

/** Formats `date` relative to `now` (defaults to the current time) as a short Spanish phrase. */
export function timeAgo(date: Date, now: Date = new Date()): string {
  const diffMs = Math.max(0, now.getTime() - date.getTime());

  if (diffMs < MINUTE) return "justo ahora";
  if (diffMs < HOUR) {
    const n = Math.round(diffMs / MINUTE);
    return `hace ${n} min`;
  }
  if (diffMs < DAY) {
    const n = Math.round(diffMs / HOUR);
    return `hace ${n} ${plural(n, "hora", "horas")}`;
  }
  if (diffMs < WEEK) {
    const n = Math.round(diffMs / DAY);
    return `hace ${n} ${plural(n, "día", "días")}`;
  }
  if (diffMs < MONTH) {
    const n = Math.round(diffMs / WEEK);
    return `hace ${n} ${plural(n, "semana", "semanas")}`;
  }
  if (diffMs < YEAR) {
    const n = Math.round(diffMs / MONTH);
    return `hace ${n} ${plural(n, "mes", "meses")}`;
  }
  const n = Math.round(diffMs / YEAR);
  return `hace ${n} ${plural(n, "año", "años")}`;
}
