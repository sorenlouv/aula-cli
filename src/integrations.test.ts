/**
 * Vendor integration tests.
 *
 * The payloads are trimmed versions of the shapes scaarup/aula and
 * Casperjuel/aula-mcp observed live. Every test stubs `fetch`, so nothing here
 * touches the network or needs a session.
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AulaClient } from './client.ts';
import * as easyiq from './integrations/easyiq.ts';
import * as skoleportal from './integrations/easyiq-skoleportal.ts';
import { NoProviderError, readCapability } from './integrations/index.ts';
import * as meebook from './integrations/meebook.ts';
import * as minUddannelse from './integrations/min-uddannelse.ts';
import * as systematic from './integrations/systematic.ts';
import type { IntegrationContext } from './integrations/types.ts';
import { type DetectedWidget, WidgetTokens } from './widgets.ts';

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** Stubs fetch and records what was sent. `respond` maps a URL to a payload. */
async function withVendor<T>(
  respond: (url: string) => unknown,
  fn: (calls: Call[], tokens: WidgetTokens) => Promise<T>,
): Promise<T> {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      ...(init?.body ? { body: JSON.parse(String(init.body)) } : {}),
    });
    return new Response(JSON.stringify(respond(url)), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const client = { getWidgetToken: async () => 'widget-token' } as unknown as AulaClient;
  try {
    return await fn(calls, new WidgetTokens(client));
  } finally {
    globalThis.fetch = original;
  }
}

const CTX: IntegrationContext = {
  isoWeek: '2026-W33',
  guardianId: '99887',
  sessionId: 'mikkel1234',
  sessionIdIsFallback: false,
  children: [
    { id: 4242, name: 'Alma Eksempelsen', userId: 'alma1234' },
    { id: 4343, name: 'Viggo Eksempelsen', userId: 'vigg5678' },
  ],
  institutionCodes: ['A12345'],
};

function query(url: string): URLSearchParams {
  return new URL(url).searchParams;
}

// ------------------------------------------------------------------- Meebook

test('Meebook is keyed on UniLogin, not the numeric child id', async () => {
  await withVendor(
    () => [
      {
        name: 'Alma Eksempelsen',
        weekPlan: [
          {
            date: 'mandag 10. aug.',
            tasks: [
              {
                type: 'comment',
                author: 'Mette',
                pill: 'Matematik',
                content: 'Husk lineal.',
                editUrl: 'https://app.meebook.com/x',
              },
              // "no subject" is a literal string, not an absent field.
              { type: 'task', pill: 'Ingen fag tilknyttet', content: 'Læs kapitel 3.' },
            ],
          },
        ],
      },
    ],
    async (calls, tokens) => {
      const plan = await meebook.getWeekPlan(CTX, tokens);
      const params = query(calls[0]?.url ?? '');

      assert.deepEqual(params.getAll('childFilter[]'), ['alma1234', 'vigg5678']);
      assert.deepEqual(params.getAll('institutionFilter[]'), ['A12345']);
      assert.equal(params.get('currentWeekNumber'), '2026-W33');
      // Meebook wants the MitID username here, not the Aula guardian id.
      assert.equal(calls[0]?.headers.sessionuuid, 'mikkel1234');
      assert.equal(calls[0]?.headers.authorization, 'Bearer widget-token');

      assert.equal(plan.provider, 'meebook');
      assert.equal(plan.items.length, 2);
      assert.deepEqual(plan.items[0], {
        kind: 'comment',
        childName: 'Alma Eksempelsen',
        date: 'mandag 10. aug.',
        subject: 'Matematik',
        content: 'Husk lineal.',
        url: 'https://app.meebook.com/x',
      });
      assert.equal(plan.items[1]?.subject, undefined, '"Ingen fag tilknyttet" is not a subject');
    },
  );
});

test("Meebook's browser-SSO prerequisite is surfaced verbatim, not swallowed", async () => {
  await withVendor(
    () => [
      { name: 'Alma', exceptionMessage: 'First time you use this function with unilogin…' },
      { name: 'Viggo', weekPlan: [{ date: 'mandag', tasks: [{ type: 'task', content: 'Læs' }] }] },
    ],
    async (_calls, tokens) => {
      const plan = await meebook.getWeekPlan(CTX, tokens);
      assert.equal(plan.items.length, 1, 'the working child still comes through');
      assert.match(plan.warnings?.join('\n') ?? '', /First time you use this function/);
    },
  );
});

test('a missing MitID username is warned about rather than failing silently', async () => {
  await withVendor(
    () => [],
    async (_calls, tokens) => {
      const plan = await meebook.getWeekPlan({ ...CTX, sessionIdIsFallback: true }, tokens);
      assert.match(plan.warnings?.join('\n') ?? '', /AULA_MITID_USERNAME/);
    },
  );
});

test('a child with no UniLogin is reported rather than quietly skipped', async () => {
  await withVendor(
    () => [],
    async (calls, tokens) => {
      const ctx = { ...CTX, children: [{ id: 1, name: 'Ukendt', userId: '' }] };
      const plan = await meebook.getWeekPlan(ctx, tokens);
      assert.deepEqual(query(calls[0]?.url ?? '').getAll('childFilter[]'), []);
      assert.match(plan.warnings?.join('\n') ?? '', /no UniLogin/);
    },
  );
});

// ------------------------------------------------------------ MinUddannelse

test('MinUddannelse takes numeric child ids and the Aula guardian id', async () => {
  await withVendor(
    () => ({
      opgaver: [
        {
          kuvertnavn: 'Alma',
          title: 'Aflever novelle',
          ugedag: 'Torsdag',
          opgaveType: 'aflevering',
          hold: [{ name: '5A' }, { name: '5B' }],
          forloeb: { navn: 'Noveller' },
        },
      ],
    }),
    async (calls, tokens) => {
      const plan = await minUddannelse.getOpgaver(CTX, tokens);
      const params = query(calls[0]?.url ?? '');

      assert.equal(params.get('childFilter'), '4242,4343', 'numeric ids, comma separated');
      assert.equal(params.get('sessionUUID'), '99887', 'the Aula guardian id, not the username');
      assert.equal(params.get('currentWeekNumber'), '2026-W33');
      assert.equal(params.get('assuranceLevel'), '2');

      assert.deepEqual(plan.items[0], {
        kind: 'aflevering',
        childName: 'Alma',
        date: 'Torsdag',
        subject: '5A, 5B',
        title: 'Aflever novelle',
        content: 'Noveller',
      });
    },
  );
});

test('a MinUddannelse ugebrev is flattened from HTML to text', async () => {
  await withVendor(
    () => ({
      personer: [
        {
          navn: 'Viggo Eksempelsen',
          institutioner: [
            { ugebreve: [{ indhold: '<p>K&aelig;re for&aelig;ldre</p><p>Husk gummist&oslash;vler.</p>' }] },
          ],
        },
      ],
    }),
    async (_calls, tokens) => {
      const plan = await minUddannelse.getUgebrev(CTX, tokens);
      assert.equal(plan.capability, 'ugebrev');
      assert.equal(plan.items[0]?.content, 'Kære forældre\n\nHusk gummistøvler.');
      assert.equal(plan.items[0]?.childName, 'Viggo Eksempelsen');
    },
  );
});

// -------------------------------------------------------------------- EasyIQ

test('EasyIQ posts one request per child and maps itemType 5 to a note', async () => {
  await withVendor(
    () => ({
      Events: [
        {
          start: '2026/08/10 08:00',
          end: '2026/08/10 09:30',
          itemType: '1',
          ownername: 'Matematik 5A',
          description: 'Kapitel 4',
        },
        { start: '2026/08/11 00:00', itemType: '5', title: 'Skolefoto', description: 'Kom pænt' },
      ],
    }),
    async (calls, tokens) => {
      const plan = await easyiq.getWeekPlan(CTX, tokens);

      assert.equal(calls.length, 2, 'one call per child');
      assert.equal(calls[0]?.method, 'POST');
      assert.deepEqual(calls[0]?.body, {
        sessionId: '99887',
        currentWeekNr: '2026-W33',
        userProfile: 'guardian',
        institutionFilter: ['A12345'],
        childFilter: ['alma1234'],
      });
      assert.equal(calls[0]?.headers['x-aula-institutionfilter'], 'A12345');

      assert.equal(plan.items[0]?.kind, 'event');
      assert.equal(plan.items[0]?.subject, 'Matematik 5A');
      assert.equal(plan.items[1]?.kind, 'note');
      assert.equal(plan.items[0]?.childName, 'Alma Eksempelsen');
    },
  );
});

// ------------------------------------------------------- EasyIQ SkolePortal

test('SkolePortal authenticates per child, then reads that login', async () => {
  await withVendor(
    (url) =>
      url.includes('AuthenticateAulaUser')
        ? { loginId: 'login-1', childName: 'Alma Eksempelsen' }
        : [
            {
              StartTimeISO: '2026-08-10T08:00:00',
              CoursesDisplay: 'Dansk',
              ActivitiesDisplay: '5A',
              ChapterTitle: 'Eventyr',
              Description: 'L&aelig;s side 12-18',
            },
          ],
    async (calls, tokens) => {
      const plan = await skoleportal.getWeekPlan(
        { ...CTX, children: [CTX.children[0] as never] },
        tokens,
      );

      const auth = calls.find((c) => c.url.includes('AuthenticateAulaUser'));
      const events = calls.find((c) => c.url.includes('CalendarGetWeekplanEvents'));
      assert.equal(auth?.method, 'POST');
      // x-childfilter takes the opaque userId, and x-login the MitID username.
      assert.equal(auth?.headers['x-childfilter'], 'alma1234');
      assert.equal(auth?.headers['x-login'], 'mikkel1234');
      assert.match(String(auth?.headers.referer), /UgeplanWidget$/);
      // The date must carry the time component or the API returns nothing.
      assert.equal(query(events?.url ?? '').get('date'), '2026-08-10T00:00:00.000Z');
      assert.equal(query(events?.url ?? '').get('loginId'), 'login-1');

      assert.equal(plan.items[0]?.subject, 'Dansk / 5A');
      assert.equal(plan.items[0]?.title, 'Eventyr');
      assert.equal(plan.items[0]?.content, 'Læs side 12-18', 'entities are decoded');
    },
  );
});

test('Lektier enumerates children and maps them by UniLogin', async () => {
  await withVendor(
    (url) => {
      if (url.includes('AuthenticateAulaUser')) return { loginId: 'x' };
      if (url.includes('GetChildren')) {
        return {
          Children: [
            { Id: 11, Login: 'alma1234', Name: 'Alma' },
            // Viggo is absent: SkolePortal does not know this child.
          ],
        };
      }
      return [{ StartTimeISO: '2026-08-12T00:00:00', ChapterTitle: 'Matematik', Description: 'Side 4' }];
    },
    async (calls, tokens) => {
      const plan = await skoleportal.getLektier(CTX, tokens);

      const auth = calls.find((c) => c.url.includes('AuthenticateAulaUser'));
      assert.match(String(auth?.headers.referer), /LektierWidget$/);
      assert.equal(auth?.headers['x-requested-with'], 'Fetch');
      // Lektier signs in with the Aula guardian id, unlike the ugeplan widget.
      assert.equal(auth?.headers['x-login'], '99887');
      assert.equal(auth?.headers['x-childfilter'], 'alma1234,vigg5678');

      const events = calls.find((c) => c.url.includes('AulaHuskeliste'));
      assert.equal(query(events?.url ?? '').get('loginId'), '11');

      assert.equal(plan.items.length, 1);
      assert.equal(plan.items[0]?.kind, 'lektier');
      assert.match(plan.warnings?.join('\n') ?? '', /Viggo.*GetChildren/s);
    },
  );
});

// ---------------------------------------------------------------- Systematic

test('Huskelisten uses the Aula-Authorization header and a date range', async () => {
  await withVendor(
    () => [
      {
        userName: 'Alma Eksempelsen',
        teamReminders: [
          {
            dueDate: '2026-08-14T23:00:00Z',
            teamName: '5A',
            subjectName: 'Matematik',
            reminderText: 'Onsdagslektie.',
          },
        ],
        assignmentReminders: [
          { dueDate: '2026-08-20T11:00:00Z', teamNames: ['5A', '5B'], assignmentText: 'Novelle' },
        ],
      },
    ],
    async (calls, tokens) => {
      const plan = await systematic.getReminders(
        { ...CTX, fromDate: '2026-08-10', toDate: '2026-08-24' },
        tokens,
      );
      const params = query(calls[0]?.url ?? '');

      assert.equal(calls[0]?.headers['aula-authorization'], 'Bearer widget-token');
      assert.equal(calls[0]?.headers.authorization, undefined, 'not the usual header name');
      assert.equal(params.get('children'), '4242,4343');
      assert.equal(params.get('from'), '2026-08-10');
      assert.equal(params.get('dueNoLaterThan'), '2026-08-24');
      assert.equal(params.get('sessionId'), 'mikkel1234');

      assert.equal(plan.items.length, 2);
      assert.equal(plan.items[0]?.kind, 'huskelisten:team');
      assert.equal(plan.items[1]?.kind, 'huskelisten:assignment');
      assert.equal(plan.items[1]?.title, '5A, 5B');
      assert.equal(plan.items[1]?.content, 'Novelle', 'assignmentText stands in for reminderText');
    },
  );
});

// ------------------------------------------------------------------ dispatch

const MEEBOOK_WIDGET: DetectedWidget = {
  widgetId: '0004',
  name: 'Meebook',
  provider: 'meebook',
  capability: 'ugeplan',
};

test('a capability with no widget names the widgets that would have served it', async () => {
  await withVendor(
    () => [],
    async (_calls, tokens) => {
      await assert.rejects(
        () => readCapability('huskelisten', [MEEBOOK_WIDGET], CTX, tokens),
        (err: unknown) => {
          assert.ok(err instanceof NoProviderError);
          assert.match(err.message, /0062/);
          assert.match(err.message, /0004 Meebook/, 'says what was detected');
          return true;
        },
      );
    },
  );
});

test('two schools on two ugeplan providers are both read', async () => {
  await withVendor(
    (url) => (url.includes('meebook') ? [] : { Events: [] }),
    async (_calls, tokens) => {
      const plans = await readCapability(
        'ugeplan',
        [
          MEEBOOK_WIDGET,
          { widgetId: '0001', name: 'EasyIQ', provider: 'easyiq', capability: 'ugeplan' },
        ],
        CTX,
        tokens,
      );
      assert.deepEqual(
        plans.map((p) => p.provider).sort(),
        ['easyiq', 'meebook'],
      );
    },
  );
});

test("MinUddannelse's two opgave widget ids are not read twice", async () => {
  await withVendor(
    () => ({ opgaver: [] }),
    async (calls, tokens) => {
      const plans = await readCapability(
        'opgaver',
        [
          { widgetId: '0030', name: 'MU', provider: 'minuddannelse', capability: 'opgaver' },
          { widgetId: '0023', name: 'MU (old)', provider: 'minuddannelse', capability: 'opgaver' },
        ],
        CTX,
        tokens,
      );
      assert.equal(plans.length, 1);
      assert.equal(calls.length, 1);
    },
  );
});
