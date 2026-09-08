import { describe, expect, test } from 'bun:test';

// `bun test` runs in UTC, and this module is entirely about Danish wall-clock
// time — "is the dentist inside SFO hours" is a question about the clock on the
// kitchen wall. Asserting it in UTC would test a program nobody runs.
process.env.TZ = 'Europe/Copenhagen';

import { toPersonalSourceItem } from '../brief/collect.ts';
import { overviewWindow } from '../brief/dates.ts';
import { localIsoDate } from '../integrations/types.ts';
import type { ResponseCache } from '../cache.ts';
import { parseCalendarsPayload, parseEventsPayload, parseStream } from './connector.ts';
import { calendarWindow, loadPersonalEvents, rfc3339, toPersonalEvent } from './index.ts';

/** In-memory stand-in, so a cache test never touches the real ~/.aula. */
function fakeCache(): ResponseCache {
  const store = new Map<string, unknown>();
  return {
    get: (namespace: string, key: unknown) => store.get(`${namespace} ${JSON.stringify(key)}`),
    set: (namespace: string, key: unknown, value: unknown) =>
      store.set(`${namespace} ${JSON.stringify(key)}`, value),
  } as unknown as ResponseCache;
}

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

  test('malformed entries throw instead of looking absent', () => {
    expect(() => toPersonalEvent(null, CAL)).toThrow('ikke var et objekt');
    expect(() => toPersonalEvent({ summary: 'no times' }, CAL)).toThrow('uden id');
  });
});

/**
 * Everything here is driven through a primed cache rather than the connector,
 * so the shaping loop is exercised without a `claude` subprocess — the cache
 * stores the *raw* connector answer precisely so this is possible.
 */
describe('reading a calendar that is partly unreadable', () => {
  const from = new Date(2026, 7, 27);
  const to = new Date(2026, 8, 10);

  function loadWith(raw: unknown[]) {
    const cache = fakeCache();
    cache.set('google-calendar', { calendarId: CAL.id, from: rfc3339(from), to: rfc3339(to) }, raw);
    return loadPersonalEvents([CAL], { from, to }, cache);
  }

  /**
   * The regression. `toPersonalEvent` throws, and the throw used to escape to
   * the per-calendar catch — so one appointment with a shape this code cannot
   * read cost the family the whole fortnight, reported as "the calendar could
   * not be read". A new field shape from Google reaching one recurring
   * appointment would have done it.
   */
  test('one unreadable appointment costs one appointment, not the fortnight', async () => {
    const load = await loadWith([TIMED, { summary: 'no id' }, ALL_DAY]);
    expect(load.events.map((event) => event.title)).toEqual(['Ferie', 'Tandlæge']);
    expect(load.warnings).toHaveLength(1);
    expect(load.warnings[0]).toContain('1 aftale(r)');
    expect(load.notConnected).toBe(false);
  });

  /** One line, however many are broken: the first already says everything. */
  test('a wholly unreadable calendar warns once rather than per appointment', async () => {
    const load = await loadWith([{ summary: 'a' }, { summary: 'b' }, { summary: 'c' }]);
    expect(load.events).toEqual([]);
    expect(load.warnings).toHaveLength(1);
    expect(load.warnings[0]).toContain('3 aftale(r)');
  });

  test('a clean calendar says nothing at all', async () => {
    const load = await loadWith([TIMED, ALL_DAY]);
    expect(load.events).toHaveLength(2);
    expect(load.warnings).toEqual([]);
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

  test('is identical at every hour of one day, which is what makes it a cache key', () => {
    // `loadPersonalEvents` keys its entries on {calendarId, from, to}. Taken
    // from the raw clock this would name a slightly different fortnight on
    // every run, miss every time, and go on spending ~25 seconds re-reading two
    // calendars through the connector — the whole cost the cache removes.
    const morning = calendarWindow(new Date(2026, 7, 30, 6, 30), 14);
    const midnightish = calendarWindow(new Date(2026, 7, 30, 23, 59, 59), 14);
    expect(morning.from.getTime()).toBe(midnightish.from.getTime());
    expect(morning.to.getTime()).toBe(midnightish.to.getTime());

    // And it does move on, so a run just after midnight is not served
    // yesterday's fortnight.
    const nextDay = calendarWindow(new Date(2026, 7, 31, 0, 0, 1), 14);
    expect(nextDay.from.getTime()).toBeGreaterThan(morning.from.getTime());
  });

  test('uses the overview horizon as the same exclusive calendar end', () => {
    const now = new Date(2026, 7, 30, 16, 30); // Sunday
    const overview = overviewWindow(localIsoDate(now));
    const { from, to } = calendarWindow(now, overview.days);

    expect(localIsoDate(from)).toBe(overview.from);
    expect(localIsoDate(to)).toBe(overview.to);
    expect(overview).toMatchObject({ through: '2026-09-06', days: 8 });
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
    // Measured, and the estimate this comment used to carry — "one run in
    // three" — was far too kind: with the connectors connecting
    // fire-and-forget it was six in seven, and the cause was a race rather
    // than a transient. `CONNECTOR_ENV` is what closes it. The rule here
    // outlives the fix, because an empty list is still what an unreachable
    // account server list looks like, and reading it as "not connected" sends
    // somebody off to connect a connector they already have. Only a populated
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

  /**
   * A `nextPageToken` used to be fatal here — a busy shared calendar lost its
   * whole fortnight rather than its 251st appointment. The parser now reports
   * the token and `listAllPages` follows it; what must never happen is a token
   * being *dropped*, which is what makes a truncated fortnight look quiet.
   */
  test('a next page is reported rather than discarded or fatal', () => {
    expect(parseEventsPayload({ events: [], nextPageToken: 'page-2' })).toEqual({
      items: [],
      nextPageToken: 'page-2',
    });
    expect(parseEventsPayload({ events: [], nextPageToken: '' })).toEqual({
      items: [],
      nextPageToken: null,
    });
    expect(parseEventsPayload({ events: [] })).toEqual({ items: [], nextPageToken: null });
  });

  test('a non-string next page is a contract break, not an absent one', () => {
    expect(() => parseEventsPayload({ events: [], nextPageToken: 7 })).toThrow(
      'ugyldig nextPageToken',
    );
  });

  /**
   * The silent half of the same bug. `list_calendars` never looked at its own
   * pagination and the connector's default page is 100, so a long calendar list
   * lost its tail — and the loss surfaced two commands later as `calendars set`
   * refusing a name that plainly exists.
   */
  test('the calendar listing reports its next page too', () => {
    expect(
      parseCalendarsPayload({
        calendars: [{ id: 'family', summary: 'Familie' }],
        nextPageToken: 'page-2',
      }).nextPageToken,
    ).toBe('page-2');
  });
});
