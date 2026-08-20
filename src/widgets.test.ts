import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AulaClient } from './client.ts';
import { SUPPORTED_WIDGET_IDS } from './integrations/index.ts';
import { isoDate, isoWeekString, isoWeekToMonday, weekOffset } from './integrations/types.ts';
import type { ProfileContext } from './types.ts';
import {
  assertWidgetEndpoint,
  detectWidgets,
  EXPIRED,
  looksExpired,
  WIDGET_ENDPOINTS,
  WIDGETS,
  WidgetError,
  WidgetTokens,
} from './widgets.ts';

function context(widgetConfigurations: unknown[]): ProfileContext {
  return {
    id: 1,
    userId: '42',
    portalRole: 'guardian',
    isSteppedUp: false,
    institutionProfile: { id: 1, profileId: 1 },
    institutions: [],
    pageConfiguration: { widgetConfigurations: widgetConfigurations as never },
  };
}

function tokenClient(onFetch: (widgetId: string) => string): AulaClient {
  return { getWidgetToken: async (widgetId: string) => onFetch(widgetId) } as unknown as AulaClient;
}

// ------------------------------------------------------------------ detection

test('widgets are detected from both the nested and the flat shape', () => {
  const detected = detectWidgets(
    context([
      { widget: { widgetId: '0004', name: 'Ugeplan' } },
      // The older shape, still served by some institutions.
      { widgetId: '0029' },
      // A widget we have no integration for is reported, not dropped.
      { widget: { widgetId: '9999', name: 'Something new' } },
    ]),
  );
  assert.deepEqual(
    detected.map((w) => w.widgetId),
    ['0004', '0029', '9999'],
  );
  assert.equal(detected[0]?.provider, 'meebook');
  assert.equal(detected[1]?.capability, 'ugebrev');
  assert.equal(detected[2]?.provider, undefined, 'unknown widgets carry no provider');
  assert.equal(detected[2]?.name, 'Something new');
});

test('the same widget on two institutions is reported once', () => {
  const detected = detectWidgets(
    context([
      { widget: { widgetId: '0001' }, institutionCode: 'A1' },
      { widget: { widgetId: '0001' }, institutionCode: 'B2' },
    ]),
  );
  assert.equal(detected.length, 1);
});

test('an institution with no widget configuration detects nothing', () => {
  assert.deepEqual(detectWidgets(context([])), []);
  const bare = { ...context([]), pageConfiguration: null };
  assert.deepEqual(detectWidgets(bare), []);
});

test('the widget registry and the fetcher table cover exactly the same ids', () => {
  for (const [widgetId, info] of Object.entries(WIDGETS)) {
    assert.ok(
      SUPPORTED_WIDGET_IDS.includes(widgetId),
      `widget ${widgetId} (${info.name}) is registered but has no fetcher`,
    );
  }
  for (const widgetId of SUPPORTED_WIDGET_IDS) {
    assert.ok(
      widgetId in WIDGETS,
      `widget ${widgetId} has a fetcher but no registry entry — detection can never reach it`,
    );
  }
});

// ---------------------------------------------------------------- the guard

test('only allowlisted vendor endpoints can be called', () => {
  assert.doesNotThrow(() =>
    assertWidgetEndpoint('https://app.meebook.com/aulaapi/relatedweekplan/all?x=1', 'GET'),
  );
  // A different path on an allowlisted host is still refused.
  assert.throws(
    () => assertWidgetEndpoint('https://app.meebook.com/aulaapi/deleteEverything', 'GET'),
    WidgetError,
  );
  assert.throws(() => assertWidgetEndpoint('https://evil.example/aula', 'GET'), WidgetError);
});

test('an endpoint allowlisted for GET cannot be POSTed to', () => {
  assert.throws(
    () => assertWidgetEndpoint('https://api.minuddannelse.net/aula/ugebrev', 'POST'),
    WidgetError,
  );
  // ...and the two genuine read-POSTs still work.
  assert.doesNotThrow(() =>
    assertWidgetEndpoint('https://api.easyiqcloud.dk/api/aula/weekplaninfo', 'POST'),
  );
  assert.doesNotThrow(() =>
    assertWidgetEndpoint('https://skoleportal.easyiqcloud.dk/Aula/AuthenticateAulaUser', 'POST'),
  );
});

test('the vendor allowlist stays https-only, so a token cannot leak in cleartext', () => {
  for (const url of Object.keys(WIDGET_ENDPOINTS)) {
    assert.ok(url.startsWith('https://'), `${url} must be https`);
  }
});

// ------------------------------------------------------------------- expiry

test('expiry is detected from the body as well as the status', () => {
  assert.ok(looksExpired(401, ''));
  assert.ok(looksExpired(403, ''));
  // Vendors that answer HTTP 200 and say so in the body.
  assert.ok(looksExpired(200, '{"message":"JWT-Token expired, please renew."}'));
  assert.ok(looksExpired(200, '{"message":"Unauthorized"}'));
  assert.ok(!looksExpired(200, '{"Events":[]}'));
  assert.ok(!looksExpired(200, ''));
});

test('a rejected token is refreshed once and the call retried', async () => {
  let issued = 0;
  const tokens = new WidgetTokens(tokenClient(() => `token-${++issued}`));

  const seen: string[] = [];
  const result = await tokens.withToken('0004', async (token) => {
    seen.push(token);
    return token === 'token-1' ? EXPIRED : { ok: true };
  });

  assert.deepEqual(seen, ['token-1', 'token-2'], 'should have retried with a fresh token');
  assert.deepEqual(result, { ok: true });
});

test('a token still rejected after a refresh fails loudly rather than looking empty', async () => {
  const tokens = new WidgetTokens(tokenClient(() => 'always-stale'));
  await assert.rejects(
    () => tokens.withToken('0062', async () => EXPIRED),
    (err: unknown) => {
      assert.ok(err instanceof WidgetError);
      assert.match(err.message, /freshly issued token/);
      return true;
    },
  );
});

test('a cached token is reused, and concurrent callers share one request', async () => {
  let issued = 0;
  const tokens = new WidgetTokens(
    tokenClient(() => `token-${++issued}`),
    { ttlMs: 60_000 },
  );

  const [a, b] = await Promise.all([tokens.get('0001'), tokens.get('0001')]);
  assert.equal(a, 'token-1');
  assert.equal(b, 'token-1');
  assert.equal(await tokens.get('0001'), 'token-1');
  assert.equal(issued, 1, 'one token request for three gets');

  // Different widgets do not share a token.
  await tokens.get('0004');
  assert.equal(issued, 2);
});

test('an expired cache entry is refetched', async () => {
  let issued = 0;
  const tokens = new WidgetTokens(
    tokenClient(() => `token-${++issued}`),
    { ttlMs: -1 },
  );
  await tokens.get('0001');
  await tokens.get('0001');
  assert.equal(issued, 2);
});

// -------------------------------------------------------------- week helpers

test('ISO weeks round-trip, including the year boundary', () => {
  // 2026-01-01 is a Thursday, so it belongs to ISO week 1 of 2026.
  assert.equal(isoWeekString(new Date(2026, 0, 1)), '2026-W01');
  // 2027-01-01 is a Friday, which ISO puts in the last week of 2026.
  assert.equal(isoWeekString(new Date(2027, 0, 1)), '2026-W53');
  assert.equal(isoWeekString(new Date(2026, 7, 12)), '2026-W33');

  assert.equal(isoDate(isoWeekToMonday('2026-W33')), '2026-08-10');
  assert.equal(isoDate(isoWeekToMonday('2026-W01')), '2025-12-29');
  assert.throws(() => isoWeekToMonday('not-a-week'));
});

test('weekOffset moves whole weeks', () => {
  assert.equal(weekOffset(1, new Date(2026, 7, 12)), '2026-W34');
  assert.equal(weekOffset(-1, new Date(2026, 7, 12)), '2026-W32');
  assert.equal(weekOffset(0, new Date(2026, 7, 12)), '2026-W33');
});
