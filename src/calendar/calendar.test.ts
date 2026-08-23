import { describe, expect, test } from 'bun:test';

// `bun test` runs in UTC, and this module is entirely about Danish wall-clock
// time — "is the dentist inside SFO hours" is a question about the clock on the
// kitchen wall. Asserting it in UTC would test a program nobody runs.
process.env.TZ = 'Europe/Copenhagen';

import { toPersonalSourceItem } from '../brief/collect.ts';
import { parseCalendarsPayload, parseEventsPayload, parseStream } from './connector.ts';
import { calendarWindow, toPersonalEvent } from './index.ts';

const CAL = { id: 'far@eksempel.dk', name: 'Familien' };

/** Shapes measured against the live connector, not invented. */
const TIMED = {
  id: 'evt1',
  summary: 'Tandlæge',
  status: 'confirmed',
  start: { dateTime: '2026-08-27T13:30:00+02:00', timeZone: 'Europe/Copenhagen' },
  end: { dateTime: '2026-08-27T14:15:00+02:00', timeZone: 'Europe/Copenhagen' },
  htmlLink: 'https://www.google.com/calendar/event?eid=abc',
};

const ALL_DAY = {
  id: 'evt2',
  summary: 'Ferie',
  start: { date: '2026-08-25T00:00:00Z' },
  end: { date: '2026-08-28T00:00:00Z' },
};

describe('reading one connector event', () => {
  test('a timed event keeps its wall-clock time', () => {
    const event = toPersonalEvent(TIMED, CAL);
    expect(event).toMatchObject({
      title: 'Tandlæge',
      date: '2026-08-27',
      startTime: '13:30',
      endTime: '14:15',
      allDay: false,
      calendarId: 'far@eksempel.dk',
      calendarName: 'Familien',
    });
  });

  test('an all-day date is sliced, never parsed', () => {
    const event = toPersonalEvent(ALL_DAY, CAL);
    expect(event?.date).toBe('2026-08-25');
    expect(event?.allDay).toBe(true);
    expect(event?.startTime).toBeNull();
  });

  test('an all-day date does not move west of UTC', () => {
    // The `Z` on an all-day `date` is decoration on a date, not an instant.
    // Parsing it as one puts the event a day early anywhere behind UTC — the
    // same bug `localIsoDate` exists to prevent. Copenhagen is ahead of UTC and
    // would never catch it, so this is the assertion that actually pins the
    // slicing: turn it into a `new Date(...)` and this is what goes red.
    try {
      process.env.TZ = 'America/New_York';
      expect(toPersonalEvent(ALL_DAY, CAL)?.date).toBe('2026-08-25');
    } finally {
      process.env.TZ = 'Europe/Copenhagen';
    }
  });

  test("Google's all-day end is exclusive, so the last day is pulled back", () => {
    // 25th–27th inclusive is spelled "ends on the 28th".
    expect(toPersonalEvent(ALL_DAY, CAL)?.endDate).toBe('2026-08-27');
  });

  test('a one-day all-day event does not end before it starts', () => {
    const event = toPersonalEvent({ ...ALL_DAY, end: { date: '2026-08-26T00:00:00Z' } }, CAL);
    expect(event?.date).toBe('2026-08-25');
    expect(event?.endDate).toBe('2026-08-25');
  });

  test('a cancelled occurrence is not something to be anywhere for', () => {
    expect(toPersonalEvent({ ...TIMED, status: 'cancelled' }, CAL)).toBeNull();
  });

  test('an occurrence is keyed on its series and its scheduled slot', () => {
    // Identity, not state: a moved occurrence keeps yesterday's key instead of
    // arriving as a cancellation plus a new appointment.
    const moved = toPersonalEvent(
      {
        ...TIMED,
        id: 'evt1_20260827T113000Z',
        recurringEventId: 'series7',
        originalStartTime: { dateTime: '2026-08-27T13:30:00+02:00' },
        start: { dateTime: '2026-08-27T15:00:00+02:00' },
        end: { dateTime: '2026-08-27T15:45:00+02:00' },
      },
      CAL,
    );
    const original = toPersonalEvent({ ...TIMED, id: 'evt1_x', recurringEventId: 'series7' }, CAL);
    expect(moved?.key).toBe(original?.key);
    expect(moved?.startTime).toBe('15:00');
  });

  test('malformed entries fail the calendar instead of looking absent', () => {
    expect(() => toPersonalEvent(null, CAL)).toThrow('ikke var et objekt');
    expect(() => toPersonalEvent({ summary: 'no times' }, CAL)).toThrow('uden id');
  });
});

describe('the bounded calendar window', () => {
  test('uses local calendar days across daylight saving time', () => {
    const { from, to } = calendarWindow(new Date(2026, 2, 22, 16, 30), 14);
    expect([from.getFullYear(), from.getMonth(), from.getDate(), from.getHours()]).toEqual([
      2026, 2, 22, 0,
    ]);
    expect([to.getFullYear(), to.getMonth(), to.getDate(), to.getHours()]).toEqual([2026, 3, 5, 0]);
    // Copenhagen moves forward during this fortnight. Fixed millisecond
    // arithmetic would end at 01:00 and silently spill into a fifteenth day.
    expect(to.getTime() - from.getTime()).toBe(14 * 86_400_000 - 3_600_000);
  });
});

describe('appointment presentation', () => {
  test('the model reads the timed interval in words; the page gets it as fields', () => {
    // The title stays bare so the page can write "Tandlæge 13:30" in the
    // compact calendar card without parsing its own sentence back apart.
    const source = toPersonalSourceItem(toPersonalEvent(TIMED, CAL)!);
    expect(source.title).toBe('Tandlæge');
    expect(source.text).toBe('Tandlæge · kl. 13:30–14:15 · Fra kalenderen «Familien»');
    expect(source.at).toBe('2026-08-27T13:30:00');
    expect(source.endsAt).toBe('2026-08-27T14:15:00');
    expect(source.allDay).toBe(false);
  });

  test('keeps a multi-day all-day interval visible', () => {
    const source = toPersonalSourceItem(toPersonalEvent(ALL_DAY, CAL)!);
    expect(source.title).toBe('Ferie');
    expect(source.text).toContain('hele dagen 25/8–27/8');
    expect(source.endsAt).toBe('2026-08-27T23:59:00');
    expect(source.allDay).toBe(true);
  });
});

// --------------------------------------------------------------- the wire

const STREAM = [
  JSON.stringify({
    type: 'system',
    subtype: 'init',
    mcp_servers: [{ name: 'claude.ai Google Calendar', status: 'connected' }],
  }),
  'not json at all',
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        {
          type: 'tool_use',
          id: 'tu_1',
          name: 'mcp__claude_ai_Google_Calendar__list_events',
          input: { calendarId: 'a@b.c' },
        },
      ],
    },
  }),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: '{"events":[]}' }] },
  }),
].join('\n');

describe('reading the tool call off the stream', () => {
  test('the arguments the model chose and the payload it got back', () => {
    const { servers, calls, results } = parseStream(STREAM);
    expect(servers).toEqual([{ name: 'claude.ai Google Calendar', status: 'connected' }]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.input).toEqual({ calendarId: 'a@b.c' });
    expect(results.get('tu_1')?.text).toBe('{"events":[]}');
  });

  test('a line that does not parse is skipped, not fatal', () => {
    // The format carries envelopes this module has no opinion about, and a new
    // one in a `claude` update must not cost the family their calendar.
    expect(parseStream('garbage\n{"nope"\n').calls).toEqual([]);
  });

  test('a tool result delivered as content blocks reads the same', () => {
    const line = JSON.stringify({
      type: 'user',
      message: {
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_2',
            content: [{ type: 'text', text: '{"ok":1}' }],
          },
        ],
      },
    });
    expect(parseStream(line).results.get('tu_2')?.text).toBe('{"ok":1}');
  });

  test('no init line means nothing is claimed about the servers', () => {
    expect(parseStream('{"type":"assistant"}').servers).toEqual([]);
  });

  test('an empty server list is not evidence that the connector is missing', () => {
    // Measured: the init envelope reports `mcp_servers: []` on roughly one run
    // in three, written before the session had registered them. Reading that
    // as "not connected" sends somebody off to connect a connector they
    // already have — and would do it on a third of mornings. Only a populated
    // list without ours counts as absence; see `attemptTool`.
    const line = JSON.stringify({ type: 'system', subtype: 'init', mcp_servers: [] });
    expect(parseStream(line).servers).toEqual([]);
  });
});

describe('connector payload contracts', () => {
  test('a missing collection is an error, never an empty result', () => {
    expect(() => parseCalendarsPayload({})).toThrow('calendars-liste');
    expect(() => parseEventsPayload({ ok: true })).toThrow('events-liste');
  });

  test('one malformed calendar rejects the listing', () => {
    expect(() =>
      parseCalendarsPayload({
        calendars: [{ id: 'family', summary: 'Familie' }, { summary: 'Privat' }],
      }),
    ).toThrow('ugyldig kalender');
  });

  test('pagination is refused so a partial fortnight cannot look complete', () => {
    expect(() => parseEventsPayload({ events: [], nextPageToken: 'page-2' })).toThrow(
      'flere sider',
    );
    expect(parseEventsPayload({ events: [], nextPageToken: '' })).toEqual([]);
  });
});
