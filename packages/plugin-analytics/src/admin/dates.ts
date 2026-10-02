const day = 86_400_000;

/**
 * Formats a UTC range whose end is exclusive. Whole days show dates only; when either boundary
 * is not at midnight both show the time, so partial days are never mistaken for whole ones.
 */
export function formatRange(start: string, end: string, locale?: string) {
  const from = Date.parse(start);
  const to = Date.parse(end);
  const date = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', year: 'numeric', month: 'short', day: 'numeric' });
  if (from % day === 0 && to % day === 0) {
    const first = date.format(from);
    const last = date.format(Math.max(from, to - 1));
    return first === last ? `${first} UTC` : `${first}–${last} UTC`;
  }
  const time = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const firstDay = date.format(from);
  const lastDay = date.format(to);
  return firstDay === lastDay
    ? `${firstDay}, ${time.format(from)}–${time.format(to)} UTC`
    : `${firstDay}, ${time.format(from)} – ${lastDay}, ${time.format(to)} UTC`;
}

/** Calendar dates intersecting [start, end), including partial first/last UTC days. */
export function dailyDates(start: string, end: string): string[] {
  const from = Date.parse(start), to = Date.parse(end);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const dates: string[] = [];
  for (let time = Math.floor(from / day) * day; time < to && dates.length < 366; time += day) {
    dates.push(new Date(time).toISOString().slice(0, 10));
  }
  return dates;
}
