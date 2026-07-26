/**
 * Business-hours arithmetic. The spec grades on business-hours elapsed, which is
 * meaningless without a timezone and a parsed hours structure, so both are first-class
 * here and `confidence` is reported rather than assumed. When confidence is 'none' the
 * caller grades on raw elapsed and says so on the scorecard instead of inventing a number.
 */
import type { HoursWindow, HoursConfidence } from './types.ts';

const DAY_NAMES: Record<string, number> = {
  sun: 0, sunday: 0,
  mon: 1, monday: 1,
  tue: 2, tues: 2, tuesday: 2,
  wed: 3, weds: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4,
  fri: 5, friday: 5,
  sat: 6, saturday: 6,
};

const ALWAYS_OPEN = /24\s*[\/x-]\s*7|24\s*hours|24hrs|around the clock|open all day|any ?time, ?day or night|day or night/i;

const DAY_TOKEN = '(sun|sunday|mon|monday|tue|tues|tuesday|wed|weds|wednesday|thu|thur|thurs|thursday|fri|friday|sat|saturday)';
const TIME_TOKEN = '(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm|a\\.m\\.|p\\.m\\.)?';

function toMinutes(hour: string, minute: string | undefined, meridiem: string | undefined): number | null {
  let h = Number.parseInt(hour, 10);
  const m = minute ? Number.parseInt(minute, 10) : 0;
  if (!Number.isFinite(h) || h > 24 || m > 59) return null;
  const mer = meridiem?.replace(/\./g, '').toLowerCase();
  if (mer === 'pm' && h < 12) h += 12;
  if (mer === 'am' && h === 12) h = 0;
  return h * 60 + m;
}

function expandDayRange(from: string, to: string | undefined): number[] {
  const a = DAY_NAMES[from];
  if (a === undefined) return [];
  if (!to) return [a];
  const b = DAY_NAMES[to];
  if (b === undefined) return [a];
  const out: number[] = [];
  for (let d = a; ; d = (d + 1) % 7) {
    out.push(d);
    if (d === b) break;
    if (out.length > 7) break;
  }
  return out;
}

export type ParsedHours = {
  windows: HoursWindow[];
  confidence: HoursConfidence;
  claims_247: boolean;
};

const WEEKDAYS_9_5: HoursWindow[] = [1, 2, 3, 4, 5].map((day) => ({ day, open: 540, close: 1020 }));

/** Every hour of every day. A 24/7 claim is a schedule, so it is treated as one. */
export const alwaysOpenWindows = (): HoursWindow[] =>
  [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: 0, close: 1440 }));

export function parseHours(text: string | null | undefined): ParsedHours {
  if (!text || !text.trim()) {
    return { windows: WEEKDAYS_9_5, confidence: 'none', claims_247: false };
  }
  const raw = text.replace(/\s+/g, ' ').trim();

  if (ALWAYS_OPEN.test(raw)) {
    const windows = [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: 0, close: 1440 }));
    return { windows, confidence: 'high', claims_247: true };
  }

  const windows: HoursWindow[] = [];
  let sawDays = false;

  // "Mon-Fri 9:00am - 5:30pm", "Saturday 10-2", "9-5 M-F" (day spec on either side)
  const pattern = new RegExp(
    `(?:${DAY_TOKEN}\\s*(?:-|–|—|through|thru|to)?\\s*${DAY_TOKEN}?\\s*[:,]?\\s*)?` +
      `${TIME_TOKEN}\\s*(?:-|–|—|to|until|till)\\s*${TIME_TOKEN}` +
      `(?:\\s*[,;]?\\s*${DAY_TOKEN}\\s*(?:-|–|—|through|thru|to)?\\s*${DAY_TOKEN}?)?`,
    'gi',
  );

  for (const m of raw.matchAll(pattern)) {
    const [, d1, d2, h1, mi1, mer1, h2, mi2, mer2, d3, d4] = m;
    let open = toMinutes(h1, mi1, mer1);
    let close = toMinutes(h2, mi2, mer2);
    if (open === null || close === null) continue;
    // "9-5" with no meridiem on a business listing means 9am-5pm, not 9am-5am.
    if (!mer1 && !mer2 && close <= open) close += 12 * 60;
    if (close <= open) continue;

    const dayTokens = d1 ? [d1, d2] : d3 ? [d3, d4] : null;
    const days = dayTokens
      ? expandDayRange(dayTokens[0].toLowerCase(), dayTokens[1]?.toLowerCase())
      : [1, 2, 3, 4, 5];
    if (dayTokens) sawDays = true;

    for (const day of days) windows.push({ day, open, close: Math.min(close, 1440) });
  }

  if (windows.length === 0) return { windows: WEEKDAYS_9_5, confidence: 'none', claims_247: false };
  return { windows, confidence: sawDays ? 'high' : 'low', claims_247: false };
}

const partsCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = partsCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    partsCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
};

/** Local weekday + minutes-since-midnight for an instant, in the target's timezone. */
export function zonedDayMinute(at: Date, timeZone: string): { day: number; minute: number } {
  let parts;
  try {
    parts = formatter(timeZone).formatToParts(at);
  } catch {
    parts = formatter('UTC').formatToParts(at);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const hour = Number.parseInt(get('hour'), 10) % 24;
  const minute = Number.parseInt(get('minute'), 10);
  return { day: WEEKDAY_INDEX[get('weekday')] ?? 0, minute: hour * 60 + minute };
}

export function isWithinHours(at: Date, windows: HoursWindow[], timeZone: string): boolean {
  const { day, minute } = zonedDayMinute(at, timeZone);
  return windows.some((w) => w.day === day && minute >= w.open && minute < w.close);
}

/**
 * Minutes of business time between two instants. Steps one minute at a time, which is
 * DST-correct because every step re-reads the zoned wall clock, and cheap enough at the
 * 72h cap the run loop enforces.
 */
export function businessMinutesBetween(
  startIso: string,
  endIso: string,
  windows: HoursWindow[],
  timeZone: string,
): number {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return 0;
  if (windows.length === 0) return 0;

  const STEP = 60_000;
  const capped = Math.min(end, start + 90 * 24 * 60 * 60_000);
  let open = 0;
  for (let t = start; t < capped; t += STEP) {
    if (isWithinHours(new Date(t), windows, timeZone)) open += 1;
  }
  return open;
}

/**
 * Instant that is `minutes` of business time after `fromIso`. Used for promise deadlines:
 * "we'll call you back within 2 hours" said at 4:55pm on a Friday does not expire at 6:55pm.
 */
export function addBusinessMinutes(
  fromIso: string,
  minutes: number,
  windows: HoursWindow[],
  timeZone: string,
): string {
  const start = new Date(fromIso).getTime();
  if (!Number.isFinite(start)) return fromIso;
  if (minutes <= 0 || windows.length === 0) return new Date(start + minutes * 60_000).toISOString();
  const STEP = 60_000;
  const limit = start + 30 * 24 * 60 * 60_000;
  let remaining = minutes;
  let t = start;
  while (remaining > 0 && t < limit) {
    t += STEP;
    if (isWithinHours(new Date(t), windows, timeZone)) remaining -= 1;
  }
  return new Date(t).toISOString();
}

export function rawMinutesBetween(startIso: string, endIso: string): number {
  const ms = new Date(endIso).getTime() - new Date(startIso).getTime();
  return Number.isFinite(ms) ? Math.max(0, Math.round(ms / 60_000)) : 0;
}

/**
 * US state code to timezone. Two-letter codes are only trusted from a parsed
 * "City, ST" string, never from free page text — "in", "or" and "me" are English words
 * and matching them against body copy silently mislabels the whole run.
 */
const STATE_TZ: Record<string, string> = {
  CT: 'America/New_York', DC: 'America/New_York', DE: 'America/New_York',
  FL: 'America/New_York', GA: 'America/New_York', IN: 'America/New_York',
  KY: 'America/New_York', MA: 'America/New_York', MD: 'America/New_York',
  ME: 'America/New_York', MI: 'America/New_York', NC: 'America/New_York',
  NH: 'America/New_York', NJ: 'America/New_York', NY: 'America/New_York',
  OH: 'America/New_York', PA: 'America/New_York', RI: 'America/New_York',
  SC: 'America/New_York', TN: 'America/New_York', VA: 'America/New_York',
  VT: 'America/New_York', WV: 'America/New_York',
  AL: 'America/Chicago', AR: 'America/Chicago', IA: 'America/Chicago',
  IL: 'America/Chicago', KS: 'America/Chicago', LA: 'America/Chicago',
  MN: 'America/Chicago', MO: 'America/Chicago', MS: 'America/Chicago',
  ND: 'America/Chicago', NE: 'America/Chicago', OK: 'America/Chicago',
  SD: 'America/Chicago', TX: 'America/Chicago', WI: 'America/Chicago',
  AZ: 'America/Phoenix', CO: 'America/Denver', ID: 'America/Denver',
  MT: 'America/Denver', NM: 'America/Denver', UT: 'America/Denver',
  WY: 'America/Denver',
  CA: 'America/Los_Angeles', NV: 'America/Los_Angeles',
  OR: 'America/Los_Angeles', WA: 'America/Los_Angeles',
  AK: 'America/Anchorage', HI: 'Pacific/Honolulu',
};

/** Unambiguous city names, used only when no "City, ST" was parsed. */
const CITY_TZ: Array<[RegExp, string]> = [
  [/\b(new york|nyc|brooklyn|manhattan|boston|philadelphia|atlanta|miami|orlando|tampa|charlotte|baltimore|pittsburgh|cleveland|detroit|columbus|cincinnati|indianapolis|jacksonville)\b/i, 'America/New_York'],
  [/\b(chicago|houston|dallas|austin|san antonio|minneapolis|kansas city|st\.? louis|nashville|memphis|new orleans|milwaukee|oklahoma city)\b/i, 'America/Chicago'],
  [/\b(denver|salt lake city|albuquerque|boise|colorado springs)\b/i, 'America/Denver'],
  [/\bphoenix|tucson|scottsdale\b/i, 'America/Phoenix'],
  [/\b(los angeles|san francisco|san diego|san jose|sacramento|seattle|portland|las vegas)\b/i, 'America/Los_Angeles'],
];

export function guessTimezone(city: string | null | undefined, pageText = ''): string {
  const stateCode = city?.match(/,\s*([A-Z]{2})\b/)?.[1];
  if (stateCode && STATE_TZ[stateCode]) return STATE_TZ[stateCode];
  const hay = `${city ?? ''} ${pageText.slice(0, 4000)}`;
  for (const [re, tz] of CITY_TZ) if (re.test(hay)) return tz;
  return 'America/New_York';
}
