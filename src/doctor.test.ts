/**
 * `doctor`'s own failure modes.
 *
 * The command exists to report truthfully on a broken session, which makes the
 * ways it can fail to report at all the thing worth pinning. It talks to Aula
 * through the client, so the tests hand it a stub and read the JSON report.
 */

import { describe, expect, test } from 'bun:test';
import type { CalendarLoad } from './calendar/index.ts';
import type { AulaClient } from './client.ts';
import { calendarConnectorCheck, claudeCliCheck, runDoctor } from './doctor.ts';
import { localIsoDate } from './integrations/types.ts';

/** Just enough client for the two identity checks and the report header. */
function stubClient(over: Partial<Record<'getProfiles' | 'getProfileContext', () => unknown>>) {
  return {
    apiVersion: 23,
    authKind: 'token',
    mitidUsername: null,
    getProfiles: async () => [],
    getProfileContext: async () => ({ userId: 'vald42a1', pageConfiguration: {} }),
    ...over,
  } as unknown as AulaClient;
}

/** Runs doctor with stdout captured, returning the parsed report. */
async function report(client: AulaClient) {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.join(' '));
  };
  try {
    const code = await runDoctor(client, { asText: false, days: 7 });
    return { code, report: JSON.parse(lines.join('\n')) };
  } finally {
    console.log = original;
  }
}

describe('runDoctor', () => {
  test('reports rather than crashing when Aula returns no profiles', async () => {
    // An empty list is truthy, so it used to sail past the `!profiles` guard
    // into buildFamily, which threw on profiles[0] — doctor died with a stack
    // trace and printed nothing, losing the warning it had just recorded about
    // exactly this state.
    const { code, report: got } = await report(stubClient({ getProfiles: async () => [] }));

    const profiles = got.checks.find(
      (c: { name: string }) => c.name === 'profiles.getProfilesByLogin',
    );
    expect(profiles.status).toBe('warn');
    expect(profiles.note).toContain('no profiles');
    // A warning is not a failure: the run still reports ok.
    expect(code).toBe(0);
  });

  test('a thrown identity check still produces a report', async () => {
    const { code, report: got } = await report(
      stubClient({
        getProfiles: async () => {
          throw new Error('401 Unauthorized');
        },
      }),
    );

    const profiles = got.checks.find(
      (c: { name: string }) => c.name === 'profiles.getProfilesByLogin',
    );
    expect(profiles.status).toBe('fail');
    expect(got.ok).toBe(false);
    expect(code).toBe(1);
  });
});

describe('claudeCliCheck', () => {
  test('passes with the resolved path when claude is on PATH', () => {
    const outcome = claudeCliCheck(() => '/Users/x/.local/bin/claude');

    expect(outcome.status).toBeUndefined(); // defaults to ok
    expect(outcome.detail).toBe('/Users/x/.local/bin/claude');
    expect(outcome.note).toBeUndefined();
  });

  test('warns — not fails — when claude is missing, and says how to install it', () => {
    // A warn keeps `report.ok` true: every Aula read still works without
    // `claude`, and only the overview breaks. Failing the run would overstate
    // it, but staying silent is what let a doomed schedule get installed.
    const outcome = claudeCliCheck(() => null);

    expect(outcome.status).toBe('warn');
    expect(outcome.detail).toBe('not on PATH');
    expect(outcome.note).toContain('claude.ai/install.sh');
  });

  test('a missing claude does not fail the run', async () => {
    const { code, report: got } = await report(stubClient({}));
    const claude = got.checks.find((c: { name: string }) => c.name === 'claude CLI');

    // Whichever way this machine answers, the check is present and never the
    // reason doctor exits non-zero.
    expect(claude).toBeDefined();
    expect(claude.status === 'ok' || claude.status === 'warn').toBe(true);
    expect(code).toBe(0);
  });
});

describe('calendarConnectorCheck', () => {
  const FAMILY = { id: 'familien@eksempel.dk', name: 'Familien' };
  const ARBEJDE = { id: 'arbejde@eksempel.dk', name: 'Arbejde' };
  const event = (calendarId: string) => ({ calendarId }) as CalendarLoad['events'][number];

  const load = (over: Partial<CalendarLoad> = {}): CalendarLoad => ({
    events: [],
    warnings: [],
    notConnected: false,
    ...over,
  });

  test('no configured calendar is a skip, because that is the documented default', async () => {
    const outcome = await calendarConnectorCheck([], async () => load());

    expect(outcome.status).toBe('skip');
    expect(outcome.detail).toContain('no calendars configured');
  });

  /**
   * The whole reason this check exists. A lapsed connector passes every Aula
   * check, accepts `aula schedule`, and then drops the calendar half of the
   * brief at 06:00 with nobody watching — and a page with no appointments on
   * it is indistinguishable from a quiet fortnight.
   */
  test('a missing connector warns with the command that fixes it', async () => {
    const outcome = await calendarConnectorCheck([FAMILY], async () =>
      load({ notConnected: true, warnings: ['Google Kalender blev ikke læst'] }),
    );

    expect(outcome.status).toBe('warn');
    expect(outcome.note).toContain('not connected');
    expect(outcome.note).toContain('calendars');
  });

  test('a calendar that reads fine but is empty is called out by name', async () => {
    const outcome = await calendarConnectorCheck([FAMILY, ARBEJDE], async () =>
      load({ events: [event(FAMILY.id)] }),
    );

    // Not a failure — it may really be empty — but the one thing a silent pass
    // would hide is precisely a calendar configured against the wrong id.
    expect(outcome.status).toBe('warn');
    expect(outcome.note).toContain('Arbejde');
    expect(outcome.note).not.toContain('Familien');
  });

  test('both calendars answering is a plain pass with the counts', async () => {
    const outcome = await calendarConnectorCheck([FAMILY, ARBEJDE], async () =>
      load({ events: [event(FAMILY.id), event(ARBEJDE.id)] }),
    );

    expect(outcome.status).toBeUndefined(); // defaults to ok
    expect(outcome.detail).toContain('2 appointment(s)');
    expect(outcome.note).toBeUndefined();
  });

  test('a per-calendar warning is reported rather than swallowed', async () => {
    const outcome = await calendarConnectorCheck([FAMILY], async () =>
      load({ events: [event(FAMILY.id)], warnings: ['1 aftale(r) i «Familien» kunne ikke læses'] }),
    );

    expect(outcome.status).toBe('warn');
    expect(outcome.note).toContain('kunne ikke læses');
  });

  test('it asks for the same fortnight the overview reads', async () => {
    let asked: { from: Date; to: Date } | undefined;
    await calendarConnectorCheck(
      [FAMILY],
      async (_calendars, window) => {
        asked = window;
        return load();
      },
      new Date(2026, 8, 8, 14, 30),
    );

    // Local midnight to local midnight, which is also what makes the read a
    // cache hit rather than a fresh pair of subprocesses.
    expect(asked?.from.getHours()).toBe(0);
    expect(asked && localIsoDate(asked.from)).toBe('2026-09-08');
    expect(asked && localIsoDate(asked.to)).toBe('2026-09-22');
  });
});
