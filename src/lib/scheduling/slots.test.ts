import { describe, expect, it } from 'vitest';
import {
  computeExpiry,
  findEarliestSlot,
  findSlots,
  fromLocal,
  isSlotFree,
  localDateKey,
  localWeekday,
  parseLocalTime,
  type AvailabilityWindow,
} from './slots';

/** Mon–Fri 09:00–17:00, 45-minute slots, 15-minute buffer. */
function weekdayWindows(userId = 'lawyer-1'): AvailabilityWindow[] {
  return [1, 2, 3, 4, 5].map((weekday) => ({
    userId,
    weekday,
    startTime: '09:00:00',
    endTime: '17:00:00',
    slotMinutes: 45,
    bufferMinutes: 15,
  }));
}

const NO_HOLIDAYS = new Set<string>();

describe('firm-local time conversion', () => {
  it('maps a UTC instant to the Malaysian calendar day', () => {
    // 2026-09-14T17:30Z is already 2026-09-15 in Kuala Lumpur.
    expect(localDateKey(new Date('2026-09-14T17:30:00Z'))).toBe('2026-09-15');
  });

  it('maps weekday in local time, not UTC', () => {
    // Sunday 17:30Z is Monday locally.
    expect(localWeekday(new Date('2026-09-13T17:30:00Z'))).toBe(1);
  });

  it('round-trips local wall-clock to UTC', () => {
    // 09:00 MYT == 01:00 UTC
    expect(fromLocal('2026-09-14', 9 * 60).toISOString()).toBe('2026-09-14T01:00:00.000Z');
  });

  it('parses HH:MM and HH:MM:SS', () => {
    expect(parseLocalTime('09:30')).toBe(570);
    expect(parseLocalTime('17:00:00')).toBe(1020);
  });
});

describe('isSlotFree — buffers (FR-3.1)', () => {
  const slot = {
    userId: 'lawyer-1',
    startsAt: new Date('2026-09-14T02:00:00Z'), // 10:00 MYT
    endsAt: new Date('2026-09-14T02:45:00Z'),
  };

  it('is free when nothing is booked', () => {
    expect(isSlotFree(slot, [], 15)).toBe(true);
  });

  it('collides with a directly overlapping appointment', () => {
    const busy = [
      { startsAt: new Date('2026-09-14T02:15:00Z'), endsAt: new Date('2026-09-14T03:00:00Z') },
    ];
    expect(isSlotFree(slot, busy, 0)).toBe(false);
  });

  it('respects the buffer before the slot', () => {
    // Ends 10 minutes before the slot starts — inside a 15-minute buffer.
    const busy = [
      { startsAt: new Date('2026-09-14T01:00:00Z'), endsAt: new Date('2026-09-14T01:50:00Z') },
    ];
    expect(isSlotFree(slot, busy, 15)).toBe(false);
    expect(isSlotFree(slot, busy, 5)).toBe(true);
  });

  it('respects the buffer after the slot', () => {
    const busy = [
      { startsAt: new Date('2026-09-14T02:55:00Z'), endsAt: new Date('2026-09-14T03:40:00Z') },
    ];
    expect(isSlotFree(slot, busy, 15)).toBe(false);
    expect(isSlotFree(slot, busy, 5)).toBe(true);
  });

  it('treats back-to-back appointments as free when there is no buffer', () => {
    const busy = [
      { startsAt: new Date('2026-09-14T02:45:00Z'), endsAt: new Date('2026-09-14T03:30:00Z') },
    ];
    expect(isSlotFree(slot, busy, 0)).toBe(true);
  });
});

describe('findEarliestSlot (FR-3.2)', () => {
  it('proposes the first free slot of the next working day', () => {
    // Friday 2026-09-11 23:00 MYT == 15:00Z. AT-01: an 11pm enquiry.
    const from = new Date('2026-09-11T15:00:00Z');
    const slot = findEarliestSlot({
      windows: weekdayWindows(),
      busy: [],
      holidayDateKeys: NO_HOLIDAYS,
      from,
    });
    expect(slot).not.toBeNull();
    // Next working day is Monday 14 September, 09:00 MYT = 01:00Z.
    expect(slot!.startsAt.toISOString()).toBe('2026-09-14T01:00:00.000Z');
    expect(slot!.endsAt.toISOString()).toBe('2026-09-14T01:45:00.000Z');
  });

  it('skips a weekend', () => {
    const saturday = new Date('2026-09-12T02:00:00Z');
    const slot = findEarliestSlot({
      windows: weekdayWindows(),
      busy: [],
      holidayDateKeys: NO_HOLIDAYS,
      from: saturday,
    });
    expect(localWeekday(slot!.startsAt)).toBe(1); // Monday
  });

  it('skips a public holiday', () => {
    // Malaysia Day, Wednesday 16 September 2026.
    const from = new Date('2026-09-15T10:00:00Z'); // Tue 18:00 MYT, after hours
    const slot = findEarliestSlot({
      windows: weekdayWindows(),
      busy: [],
      holidayDateKeys: new Set(['2026-09-16']),
      from,
    });
    expect(localDateKey(slot!.startsAt)).toBe('2026-09-17');
  });

  it('honours the minimum notice period', () => {
    // Monday 08:30 MYT (00:30Z); 09:00 is only 30 minutes away.
    const from = new Date('2026-09-14T00:30:00Z');
    const slot = findEarliestSlot({
      windows: weekdayWindows(),
      busy: [],
      holidayDateKeys: NO_HOLIDAYS,
      from,
      minimumNoticeMinutes: 60,
    });
    // 09:00 is too soon, so the 09:45 slot is proposed.
    expect(slot!.startsAt.toISOString()).toBe('2026-09-14T01:45:00.000Z');
  });

  it('steps past a booked slot', () => {
    const from = new Date('2026-09-13T20:00:00Z'); // Mon 04:00 MYT
    const slot = findEarliestSlot({
      windows: weekdayWindows(),
      busy: [
        { startsAt: new Date('2026-09-14T01:00:00Z'), endsAt: new Date('2026-09-14T01:45:00Z') },
      ],
      holidayDateKeys: NO_HOLIDAYS,
      from,
      minimumNoticeMinutes: 0,
    });
    // 09:00 taken; buffer pushes past 09:45 too, so 10:30 MYT = 02:30Z.
    expect(slot!.startsAt.toISOString()).toBe('2026-09-14T02:30:00.000Z');
  });

  it('never proposes a slot that runs past the end of the window', () => {
    const windows: AvailabilityWindow[] = [
      {
        userId: 'lawyer-1',
        weekday: 1,
        startTime: '09:00:00',
        endTime: '10:00:00',
        slotMinutes: 45,
        bufferMinutes: 0,
      },
    ];
    const slots = findSlots({
      windows,
      busy: [],
      holidayDateKeys: NO_HOLIDAYS,
      from: new Date('2026-09-13T20:00:00Z'),
      minimumNoticeMinutes: 0,
      limit: 5,
      horizonDays: 6,
    });
    // Only 09:00-09:45 fits; 09:45-10:30 would overrun.
    expect(slots).toHaveLength(1);
    expect(slots[0]!.endsAt.toISOString()).toBe('2026-09-14T01:45:00.000Z');
  });

  it('returns null when nothing is available inside the horizon', () => {
    const slot = findEarliestSlot({
      windows: [],
      busy: [],
      holidayDateKeys: NO_HOLIDAYS,
      from: new Date('2026-09-14T01:00:00Z'),
    });
    expect(slot).toBeNull();
  });

  it('prefers the lawyer whose window opens earliest, deterministically', () => {
    const windows: AvailabilityWindow[] = [
      { ...weekdayWindows('lawyer-b')[0]!, startTime: '11:00:00' },
      { ...weekdayWindows('lawyer-a')[0]!, startTime: '09:00:00' },
    ];
    const slot = findEarliestSlot({
      windows,
      busy: [],
      holidayDateKeys: NO_HOLIDAYS,
      from: new Date('2026-09-13T20:00:00Z'),
      minimumNoticeMinutes: 0,
    });
    expect(slot!.userId).toBe('lawyer-a');
  });
});

describe('findSlots — reschedule options (FR-3.3)', () => {
  it('returns distinct, ascending slots', () => {
    const slots = findSlots({
      windows: weekdayWindows(),
      busy: [],
      holidayDateKeys: NO_HOLIDAYS,
      from: new Date('2026-09-13T20:00:00Z'),
      minimumNoticeMinutes: 0,
      limit: 4,
    });
    expect(slots).toHaveLength(4);
    for (let i = 1; i < slots.length; i += 1) {
      expect(slots[i]!.startsAt.getTime()).toBeGreaterThan(slots[i - 1]!.startsAt.getTime());
    }
  });
});

describe('computeExpiry — working hours (FR-3.5)', () => {
  it('expires later the same day when there is time left', () => {
    // Monday 10:00 MYT + 4 working hours = 14:00 MYT.
    const expiry = computeExpiry({
      from: new Date('2026-09-14T02:00:00Z'),
      workingHours: 4,
      holidayDateKeys: NO_HOLIDAYS,
    });
    expect(expiry.toISOString()).toBe('2026-09-14T06:00:00.000Z'); // 14:00 MYT
  });

  it('rolls over to the next working day', () => {
    // Monday 16:00 MYT + 4 working hours: 2h left Monday, 2h into Tuesday = 11:00.
    const expiry = computeExpiry({
      from: new Date('2026-09-14T08:00:00Z'),
      workingHours: 4,
      holidayDateKeys: NO_HOLIDAYS,
    });
    expect(expiry.toISOString()).toBe('2026-09-15T03:00:00.000Z'); // 11:00 MYT Tue
  });

  it('does not burn the window over a weekend', () => {
    // Friday 16:00 MYT + 12 working hours must land on Tuesday, not Saturday.
    const expiry = computeExpiry({
      from: new Date('2026-09-11T08:00:00Z'),
      workingHours: 12,
      holidayDateKeys: NO_HOLIDAYS,
    });
    const weekday = localWeekday(expiry);
    expect(weekday).toBe(2); // Tuesday
  });

  it('skips public holidays', () => {
    // Tuesday 16:00 MYT, 12 working hours, Wednesday is Malaysia Day.
    const expiry = computeExpiry({
      from: new Date('2026-09-15T08:00:00Z'),
      workingHours: 12,
      holidayDateKeys: new Set(['2026-09-16']),
    });
    expect(localDateKey(expiry)).not.toBe('2026-09-16');
    expect(localWeekday(expiry)).toBe(5); // Friday
  });

  it('starts counting from the start of the next working day when raised after hours', () => {
    // Monday 22:00 MYT + 2 working hours = Tuesday 11:00 MYT.
    const expiry = computeExpiry({
      from: new Date('2026-09-14T14:00:00Z'),
      workingHours: 2,
      holidayDateKeys: NO_HOLIDAYS,
    });
    expect(expiry.toISOString()).toBe('2026-09-15T03:00:00.000Z');
  });
});
