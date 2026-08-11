/**
 * Slot generation and proposal timing (FR-3.1, FR-3.2, FR-3.5).
 *
 * Pure functions over explicit inputs — no database, no clock — so the rules
 * can be asserted directly. The service layer supplies rules, existing
 * appointments and holidays; this decides which slot to propose.
 *
 * Timezone handling: the firm works in Asia/Kuala_Lumpur (UTC+8, no DST).
 * Availability rules are stored as local wall-clock times; everything else in
 * the system is UTC. The conversion is a fixed offset, which is why it is done
 * arithmetically here rather than pulling in a timezone library — Malaysia has
 * had no DST transitions since 1935 and none are planned.
 */

export const MYT_OFFSET_MINUTES = 8 * 60;

export interface AvailabilityWindow {
  userId: string;
  /** 0 = Sunday … 6 = Saturday, in firm-local time. */
  weekday: number;
  /** 'HH:MM:SS' local. */
  startTime: string;
  endTime: string;
  slotMinutes: number;
  bufferMinutes: number;
  validFrom?: Date | null;
  validTo?: Date | null;
}

export interface BusyInterval {
  startsAt: Date;
  endsAt: Date;
}

export interface Slot {
  userId: string;
  startsAt: Date;
  endsAt: Date;
}

/** Parse 'HH:MM' or 'HH:MM:SS' into minutes past local midnight. */
export function parseLocalTime(value: string): number {
  const parts = value.split(':');
  const hours = Number(parts[0] ?? 0);
  const minutes = Number(parts[1] ?? 0);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) {
    throw new Error(`Invalid time value: ${value}`);
  }
  return hours * 60 + minutes;
}

/** The firm-local calendar day (YYYY-MM-DD) that a UTC instant falls on. */
export function localDateKey(instant: Date): string {
  const shifted = new Date(instant.getTime() + MYT_OFFSET_MINUTES * 60_000);
  return shifted.toISOString().slice(0, 10);
}

/** Firm-local weekday (0=Sun) for a UTC instant. */
export function localWeekday(instant: Date): number {
  const shifted = new Date(instant.getTime() + MYT_OFFSET_MINUTES * 60_000);
  return shifted.getUTCDay();
}

/** Build a UTC instant from a firm-local date key and minutes past midnight. */
export function fromLocal(dateKey: string, minutesPastMidnight: number): Date {
  const [y, m, d] = dateKey.split('-').map(Number);
  const utcMidnight = Date.UTC(y!, (m ?? 1) - 1, d ?? 1);
  return new Date(utcMidnight + (minutesPastMidnight - MYT_OFFSET_MINUTES) * 60_000);
}

function overlaps(a: BusyInterval, b: BusyInterval): boolean {
  return a.startsAt < b.endsAt && b.startsAt < a.endsAt;
}

/**
 * Does this candidate slot collide with existing commitments, once the buffer
 * either side is taken into account?
 *
 * The buffer is applied to the *candidate*, not to stored appointments, so
 * changing the buffer changes future proposals without rewriting history.
 */
export function isSlotFree(slot: Slot, busy: BusyInterval[], bufferMinutes: number): boolean {
  const padded: BusyInterval = {
    startsAt: new Date(slot.startsAt.getTime() - bufferMinutes * 60_000),
    endsAt: new Date(slot.endsAt.getTime() + bufferMinutes * 60_000),
  };
  return !busy.some((b) => overlaps(padded, b));
}

export interface FindSlotOptions {
  windows: AvailabilityWindow[];
  busy: BusyInterval[];
  holidayDateKeys: Set<string>;
  /** Search starts here — normally "now". */
  from: Date;
  /** How many calendar days ahead to search. */
  horizonDays?: number;
  /**
   * Minimum notice before the proposed slot. An 11pm enquiry should not
   * propose 8am the same night (FR-2.7 keeps it for the morning queue, and
   * this stops the proposal itself being unreasonable).
   */
  minimumNoticeMinutes?: number;
}

/**
 * Earliest slot matching the rules with no existing appointment (FR-3.2).
 * Returns null when nothing is available inside the horizon — the caller
 * routes that to the human queue rather than proposing something invalid.
 */
export function findEarliestSlot(options: FindSlotOptions): Slot | null {
  const horizonDays = options.horizonDays ?? 21;
  const notice = options.minimumNoticeMinutes ?? 60;
  const earliestStart = new Date(options.from.getTime() + notice * 60_000);

  for (let dayOffset = 0; dayOffset <= horizonDays; dayOffset += 1) {
    const cursor = new Date(options.from.getTime() + dayOffset * 86_400_000);
    const dateKey = localDateKey(cursor);

    if (options.holidayDateKeys.has(dateKey)) continue;

    const weekday = localWeekday(cursor);
    const dayWindows = options.windows.filter((w) => {
      if (w.weekday !== weekday) return false;
      if (w.validFrom && cursor < w.validFrom) return false;
      if (w.validTo && cursor > w.validTo) return false;
      return true;
    });

    // Deterministic ordering: earliest window first, then by user so two
    // lawyers with identical availability always resolve the same way.
    const ordered = [...dayWindows].sort((a, b) => {
      const byTime = parseLocalTime(a.startTime) - parseLocalTime(b.startTime);
      return byTime !== 0 ? byTime : a.userId.localeCompare(b.userId);
    });

    for (const window of ordered) {
      const startMinutes = parseLocalTime(window.startTime);
      const endMinutes = parseLocalTime(window.endTime);
      const step = window.slotMinutes;

      for (let m = startMinutes; m + step <= endMinutes; m += step) {
        const startsAt = fromLocal(dateKey, m);
        if (startsAt < earliestStart) continue;

        const slot: Slot = {
          userId: window.userId,
          startsAt,
          endsAt: new Date(startsAt.getTime() + step * 60_000),
        };

        const userBusy = options.busy.filter(
          (b) => !('userId' in b) || (b as { userId?: string }).userId === window.userId,
        );
        if (isSlotFree(slot, userBusy, window.bufferMinutes)) {
          return slot;
        }
      }
    }
  }

  return null;
}

/** Several candidate slots, for the reschedule picker (FR-3.3). */
export function findSlots(options: FindSlotOptions & { limit?: number }): Slot[] {
  const limit = options.limit ?? 6;
  const found: Slot[] = [];
  const busy = [...options.busy];

  for (let i = 0; i < limit; i += 1) {
    const slot = findEarliestSlot({ ...options, busy });
    if (!slot) break;
    found.push(slot);
    // Treat the slot we just offered as taken, so the next iteration advances.
    busy.push({ startsAt: slot.startsAt, endsAt: slot.endsAt });
  }
  return found;
}

/**
 * Proposal expiry (FR-3.5): a configurable window of *working hours*, default
 * 12, after which the proposal expires and escalates to the practice lead.
 *
 * Counted in working hours rather than wall-clock so a proposal made at 5pm
 * Friday does not silently expire over the weekend before anyone could act.
 */
export function computeExpiry(params: {
  from: Date;
  workingHours: number;
  holidayDateKeys: Set<string>;
  /** Local working day, defaults to 09:00–18:00. */
  dayStartMinutes?: number;
  dayEndMinutes?: number;
}): Date {
  const dayStart = params.dayStartMinutes ?? 9 * 60;
  const dayEnd = params.dayEndMinutes ?? 18 * 60;
  const hoursPerDay = (dayEnd - dayStart) / 60;

  let remaining = params.workingHours;
  let cursor = new Date(params.from);
  let guard = 0;

  while (remaining > 0 && guard < 365) {
    guard += 1;
    const dateKey = localDateKey(cursor);
    const weekday = localWeekday(cursor);
    const isWorkingDay = weekday >= 1 && weekday <= 5 && !params.holidayDateKeys.has(dateKey);

    if (!isWorkingDay) {
      cursor = fromLocal(nextDateKey(dateKey), dayStart);
      continue;
    }

    const localMinutes = minutesPastLocalMidnight(cursor);
    const windowStart = Math.max(localMinutes, dayStart);

    if (windowStart >= dayEnd) {
      cursor = fromLocal(nextDateKey(dateKey), dayStart);
      continue;
    }

    const availableHours = (dayEnd - windowStart) / 60;
    if (availableHours >= remaining) {
      return fromLocal(dateKey, windowStart + remaining * 60);
    }

    remaining -= availableHours;
    cursor = fromLocal(nextDateKey(dateKey), dayStart);
    void hoursPerDay;
  }

  return cursor;
}

export function minutesPastLocalMidnight(instant: Date): number {
  const shifted = new Date(instant.getTime() + MYT_OFFSET_MINUTES * 60_000);
  return shifted.getUTCHours() * 60 + shifted.getUTCMinutes();
}

export function nextDateKey(dateKey: string): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const next = new Date(Date.UTC(y!, (m ?? 1) - 1, (d ?? 1) + 1));
  return next.toISOString().slice(0, 10);
}

/** Human-facing slot rendering in firm-local time. */
export function formatSlotForClient(slot: { startsAt: Date; endsAt: Date }): string {
  const fmt = new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  const end = new Intl.DateTimeFormat('en-MY', {
    timeZone: 'Asia/Kuala_Lumpur',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
  return `${fmt.format(slot.startsAt)} – ${end.format(slot.endsAt)} (MYT)`;
}
