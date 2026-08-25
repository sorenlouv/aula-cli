import assert from 'node:assert/strict';
import { test } from 'node:test';
import { listAttachments, safeFilename } from './attachments.ts';
import {
  AulaApiError,
  AulaAuthError,
  AulaClient,
  CALENDAR_MAX_SPAN_DAYS,
  READ_METHOD_PATTERN,
  READ_ONLY_METHODS,
  assertReadOnly,
  formatAulaDate,
} from './client.ts';
import { htmlToText, preview } from './html.ts';
import { addLocalDays, localIsoDate } from './integrations/types.ts';
import {
  normaliseCommonFile,
  normaliseSchedule,
  mapLimit,
  parseKeyValues,
  selectCommonFile,
  parseSince,
  presenceStatus,
  presenceStatusDanish,
  resolveWeek,
  upcomingBirthdays,
} from './cli-helpers.ts';

const COOKIE = 'PHPSESSID=test; Csrfp-Token=test-csrf';

/**
 * A stub only ever needs to be callable. `typeof fetch` additionally carries
 * Bun's `preconnect`, which no test wants to implement.
 */
type FetchStub = (input: string | Request | URL, init?: RequestInit) => Promise<Response>;

/** Swaps global fetch for the duration of one test. */
function withFetch<T>(handler: FetchStub, fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = handler as unknown as typeof fetch;
  return fn().finally(() => {
    globalThis.fetch = original;
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const OK_PROFILES = { status: { code: 0 }, data: { profiles: [] } };
/** Distinguishable from OK_PROFILES, so a replayed request proves it carried data. */
const ONE_PROFILE = {
  status: { code: 0 },
  data: { profiles: [{ profileId: 1, institutionProfiles: [], children: [] }] },
};

test('API versions must be finite integers in the supported range', () => {
  assert.throws(() => new AulaClient({ cookie: COOKIE, apiVersion: 0 }), /integer from 1 to 99/);
  assert.throws(() => new AulaClient({ cookie: COOKIE, apiVersion: 1.5 }), /integer from 1 to 99/);

  const previous = process.env.AULA_API_VERSION;
  process.env.AULA_API_VERSION = 'latest';
  try {
    assert.throws(() => new AulaClient({ cookie: COOKIE }), /AULA_API_VERSION must be an integer/);
  } finally {
    if (previous === undefined) delete process.env.AULA_API_VERSION;
    else process.env.AULA_API_VERSION = previous;
  }
});

test('the guard refuses every write method Aula exposes', () => {
  const writeMethods = [
    'messaging.sendMessage',
    'messaging.createThread',
    'messaging.markThreadAsRead',
    'messaging.deleteThread',
    'posts.createPost',
    'posts.updatePost',
    'posts.deletePost',
    'posts.addComment',
    'calendar.updateEventResponse',
    'calendar.createEvent',
    'presence.registerVacation',
  ];
  for (const method of writeMethods) {
    assert.throws(() => assertReadOnly(method, 'GET'), AulaApiError, `${method} must be refused`);
  }
});

test('the guard allows POST only for the calendar read', () => {
  assert.doesNotThrow(() => assertReadOnly('calendar.getEventsByProfileIdsAndResourceIds', 'POST'));
  assert.throws(() => assertReadOnly('messaging.getThreads', 'POST'), AulaApiError);
});

test('every allowlisted method is a getter, so the allowlist cannot drift into writes', () => {
  assert.ok(READ_ONLY_METHODS.size > 5, 'expected the allowlist to be populated');
  for (const method of READ_ONLY_METHODS) {
    assert.match(
      method,
      READ_METHOD_PATTERN,
      `"${method}" is in the read-only allowlist but is not a getter`,
    );
  }
});

test('a refused method never opens a socket', async () => {
  let called = 0;
  await withFetch(
    async () => {
      called++;
      return jsonResponse(OK_PROFILES);
    },
    async () => {
      assert.throws(() => assertReadOnly('posts.createPost', 'GET'));
      assert.equal(called, 0, 'no request should have been sent');
    },
  );
});

// Aula rejects `Authorization: Bearer` outright, so token auth has to travel in
// the query string. Getting this wrong authenticates nothing and looks exactly
// like an expired session.
test('token auth sends the access token as a query parameter, not a Bearer header', async () => {
  let url = '';
  let headers = new Headers();
  let call = 0;
  await withFetch(
    async (input, init) => {
      call++;
      if (call === 1) return jsonResponse(OK_PROFILES); // version probe
      url = String(input);
      headers = new Headers(init?.headers);
      return jsonResponse({ status: { code: 0 }, data: [] });
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'tok-abc', username: 'vald42a1' },
      });
      await client.getDailyPresence([11]);
      assert.match(url, /access_token=tok-abc/);
      assert.equal(headers.get('authorization'), null, 'must not send a Bearer header');
    },
  );
});

// The calendar read is a POST and Aula wants a CSRF token with it, which only
// exists in the cookie jar — so token auth still replays cookies when it has
// them, even though they are not what authenticates the call.
test('token auth still sends cookies when a jar was captured at login', async () => {
  let headers = new Headers();
  let call = 0;
  await withFetch(
    async (_input, init) => {
      call++;
      if (call === 1) return jsonResponse(OK_PROFILES);
      headers = new Headers(init?.headers);
      return jsonResponse({ status: { code: 0 }, data: [] });
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'tok', username: 'u', cookie: COOKIE },
      });
      await client.getCalendarEvents({
        childInstitutionProfileIds: [1],
        start: new Date(),
        end: new Date(),
      });
      assert.match(headers.get('cookie') ?? '', /PHPSESSID=test/);
      assert.equal(headers.get('csrfp-token'), 'test-csrf');
    },
  );
});

// Aula answers an over-long calendar window with a bare 403 — the same status
// it uses for a wrong id set. Without this the user is told to check their ids,
// which is not the problem and not fixable.
test('an over-long calendar window is refused locally, with the real reason', async () => {
  let requests = 0;
  await withFetch(
    async () => {
      requests++;
      return jsonResponse(OK_PROFILES);
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      const start = new Date('2026-08-13T00:00:00Z');
      const tooLong = new Date(start.getTime() + (CALENDAR_MAX_SPAN_DAYS + 1) * 86_400_000);
      await assert.rejects(
        () => client.getCalendarEvents({ childInstitutionProfileIds: [1], start, end: tooLong }),
        (err: unknown) => {
          assert.ok(err instanceof AulaApiError);
          assert.match(err.message, /longer than 50 days/);
          assert.doesNotMatch(err.message, /id set/, 'must not blame the ids');
          return true;
        },
      );
      assert.equal(requests, 0, 'should not spend a request to learn this');
    },
  );
});

test('a calendar window at the limit is still attempted', async () => {
  let called = 0;
  await withFetch(
    async () => {
      called++;
      return jsonResponse(called === 1 ? OK_PROFILES : { status: { code: 0 }, data: [] });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      const start = new Date('2026-08-13T00:00:00Z');
      const atLimit = new Date(start.getTime() + CALENDAR_MAX_SPAN_DAYS * 86_400_000);
      await client.getCalendarEvents({ childInstitutionProfileIds: [1], start, end: atLimit });
      assert.ok(called > 1, 'the boundary itself must not be refused');
    },
  );
});

test('a 50-day local calendar window remains valid across the autumn DST change', async () => {
  const previous = process.env.TZ;
  process.env.TZ = 'Europe/Copenhagen';
  let called = 0;
  try {
    await withFetch(
      async () => {
        called++;
        return jsonResponse(called === 1 ? OK_PROFILES : { status: { code: 0 }, data: [] });
      },
      async () => {
        const client = new AulaClient({ cookie: COOKIE });
        const start = new Date(2026, 8, 20);
        const end = addLocalDays(start, CALENDAR_MAX_SPAN_DAYS);
        assert.equal(end.getTime() - start.getTime(), 50 * 86_400_000 + 3_600_000);
        await client.getCalendarEvents({ childInstitutionProfileIds: [1], start, end });
      },
    );
    assert.ok(called > 1, 'DST must not turn 50 calendar days into an over-limit request');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

// Fælles Filer, trimmed from a live response. The `file.file` nesting is
// Aula's own — the outer object is the attachment record, the inner one the
// stored blob with the presigned URL.
const COMMON_FILE = {
  id: 125633,
  title: '2e skema uge 33-43 2026',
  created: '2026-06-22T09:14:00+00:00',
  groupRestrictions: [{ id: 1520003, name: '2E' }],
  institution: { institutionCode: '100001', institutionName: 'Eksempelskolen' },
  file: {
    id: 41472385,
    name: '2e Uge 33-43 2026.pdf',
    status: 'available',
    creator: { name: 'Yrsa Storm Bille', institutionName: 'Eksempelskolen' },
    file: { id: 41472385, name: '2e Uge 33-43 2026.pdf', url: 'https://media-prod.aula.dk/signed' },
  },
};

// getCommonFiles rejects the request with a bare status 40 — and an empty
// errorInformation — if orderField or orderDirection are missing, giving no clue
// which parameter was at fault. It also filters on institution *codes*, not on
// any of the profile ids the rest of the API uses.
test('getCommonFiles sends the parameters Aula silently requires', async () => {
  let url = '';
  let call = 0;
  await withFetch(
    async (input) => {
      call++;
      if (call === 1) return jsonResponse(OK_PROFILES);
      url = String(input);
      return jsonResponse({ status: { code: 0 }, data: { commonFiles: [], totalAmount: 0 } });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await client.getCommonFiles({ institutionCodes: ['100001', 'E10002'] });
      const query = new URL(url).searchParams;
      assert.equal(query.get('orderField'), 'title', 'the only value Aula accepts');
      assert.ok(query.get('orderDirection'), 'orderDirection is mandatory too');
      assert.deepEqual(query.getAll('institutionCodes[]'), ['100001', 'E10002']);
      assert.ok(query.get('limit'), 'limit is mandatory');
      assert.equal(query.get('index'), '0');
    },
  );
});

test("a shared file is read off the right level of Aula's double nesting", () => {
  const f = normaliseCommonFile(COMMON_FILE);
  assert.equal(f.title, '2e skema uge 33-43 2026');
  assert.equal(f.filename, '2e Uge 33-43 2026.pdf');
  assert.equal(f.url, 'https://media-prod.aula.dk/signed', 'url lives on the inner file');
  assert.equal(f.uploadedBy, 'Yrsa Storm Bille');
  assert.equal(f.status, 'available');
  assert.deepEqual(f.groups, ['2E']);
});

test('a shared file still awaiting its virus scan reports no url', () => {
  const pending = normaliseCommonFile({
    ...COMMON_FILE,
    file: { ...COMMON_FILE.file, status: 'pending', file: null },
  });
  assert.equal(pending.url, null);
  assert.equal(pending.status, 'pending');
});

// The shelf carries near-identical names across years. Quietly downloading last
// year's timetable would look like success.
test('an ambiguous shared-file reference is refused, not guessed', () => {
  const files = [
    normaliseCommonFile({ ...COMMON_FILE, id: 1, title: 'Ferieplan for skoleåret 25-26' }),
    normaliseCommonFile({ ...COMMON_FILE, id: 2, title: 'Ferieplan for skoleåret 26-27' }),
  ];
  assert.throws(
    () => selectCommonFile(files, 'Ferieplan'),
    (err: unknown) => {
      assert.match((err as Error).message, /matches 2 files/);
      assert.match((err as Error).message, /\[1\]/, 'should list the candidates');
      return true;
    },
  );
  // Narrowing, and addressing by id, both resolve it.
  assert.equal(selectCommonFile(files, '26-27').id, 2);
  assert.equal(selectCommonFile(files, '2').id, 2);
});

test('a shared file matches on filename as well as title', () => {
  const files = [normaliseCommonFile(COMMON_FILE)];
  assert.equal(selectCommonFile(files, 'Uge 33-43').id, 125633);
  assert.throws(() => selectCommonFile(files, 'nonexistent'), /No shared file matches/);
});

test('cookie auth never adds an access_token parameter', async () => {
  let url = '';
  let call = 0;
  await withFetch(
    async (input) => {
      call++;
      if (call === 1) return jsonResponse(OK_PROFILES);
      url = String(input);
      return jsonResponse({ status: { code: 0 }, data: [] });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await client.getDailyPresence([11]);
      assert.doesNotMatch(url, /access_token/);
    },
  );
});

test('a response with no status envelope fails explicitly instead of becoming typed data', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      return call === 1 ? jsonResponse(OK_PROFILES) : jsonResponse(null);
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(
        () => client.getDailyPresence([11]),
        (err: unknown) => {
          assert.ok(err instanceof AulaApiError);
          assert.match(err.message, /could not read/i);
          // The method, and a way to see what Aula actually sent — the two
          // things that make this reportable rather than just annoying.
          assert.match(err.message, /presence\.getDailyOverview/);
          assert.match(err.message, /aula raw presence\.getDailyOverview/);
          return true;
        },
      );
    },
  );
});

// MitID is the only credential, so every expiry points at the same fix — and
// that message is the whole of what the user (or Claude) gets to act on.
test('an expired credential points at the MitID login', async () => {
  const expired = async () => jsonResponse({ status: { code: 448 }, data: null }, 403);

  for (const opts of [
    { auth: { kind: 'token', accessToken: 'tok', username: 'u' } as const },
    { cookie: COOKIE },
  ]) {
    await withFetch(expired, async () => {
      const client = new AulaClient(opts);
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          assert.match((err as Error).message, /bun run login/);
          return true;
        },
      );
    });
  }
});

test('status 448 is reported as expired credentials, not a permission problem', async () => {
  await withFetch(
    async () => jsonResponse({ status: { code: 448 }, data: null }, 403),
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          assert.ok(err instanceof AulaAuthError, 'should be an auth error');
          assert.match(err.message, /rejected the credentials/);
          return true;
        },
      );
    },
  );
});

test('status 403 is reported as a refusal, and does not claim the session expired', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      // First call is the API-version probe, which must succeed.
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 403 }, data: null }, 403);
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(
        () =>
          client.getCalendarEvents({
            childInstitutionProfileIds: [1],
            start: new Date(),
            end: new Date(),
          }),
        (err: unknown) => {
          assert.ok(err instanceof AulaApiError, 'should be an API error, not an auth error');
          assert.ok(!(err instanceof AulaAuthError));
          assert.match(err.message, /institution code|calendar window/i);
          // Measured against the live API: a foreign institution-profile id comes
          // back as code 10, not code 403, so this message must not send the
          // reader off checking profile ids as if that were the cause.
          assert.match(err.message, /code 10/);
          return true;
        },
      );
    },
  );
});

// Aula reuses HTTP 403 for four unrelated failures and status code 10 for three,
// so these four cases are the ones that used to collapse into one unhelpful
// "run doctor" message. Each pairing below was reproduced against the live API.
test('status 10 is split by HTTP status rather than collapsed', async () => {
  const cases: Array<{ http: number; expect: RegExp; not?: RegExp }> = [
    // A mistyped or guessed method name — the `raw` escape hatch's usual failure.
    { http: 404, expect: /has no method called/i, not: /doctor/ },
    // An unactivated session, or an id this login cannot reach.
    { http: 403, expect: /would not let this session read/i },
    // Every method answers this once a version retires.
    { http: 410, expect: /retired/i },
  ];
  for (const { http, expect, not } of cases) {
    let call = 0;
    await withFetch(
      async () => {
        call++;
        return call === 1
          ? jsonResponse(OK_PROFILES)
          : jsonResponse({ status: { code: 10 }, data: null }, http);
      },
      async () => {
        const client = new AulaClient({ cookie: COOKIE });
        await assert.rejects(
          () => client.getThreads(),
          (err: unknown) => {
            assert.ok(err instanceof AulaApiError, `HTTP ${http} should be an API error`);
            assert.equal(err.code, 10);
            assert.match(err.message, expect);
            if (not) assert.doesNotMatch(err.message, not);
            return true;
          },
        );
      },
    );
  }
});

test('status 20 says the token was superseded, not that the login died', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 20, subCode: 9 }, data: null }, 403);
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(
        () => client.getThreads(),
        (err: unknown) => {
          // An OAuth refresh retires the previous access token immediately, so this
          // resolves itself on the next run. Reporting it as an auth error would
          // send the user to MitID for something a retry fixes.
          assert.ok(err instanceof AulaApiError, 'should not be an auth error');
          assert.ok(!(err instanceof AulaAuthError));
          assert.match(err.message, /replaced by a newer one/i);
          assert.match(err.message, /again/i);
          return true;
        },
      );
    },
  );
});

// Overlapping runs are routine here — the scheduled brief retries all morning,
// and a manual command lands in the middle of that window. Each of these is a
// step the recovery has to get right for that to stay invisible.
test('a superseded token is swapped out and the request replayed', async () => {
  const sent: Array<string | null> = [];
  let call = 0;
  await withFetch(
    async (input: string | Request | URL) => {
      call++;
      sent.push(new URL(String(input)).searchParams.get('access_token'));
      if (call === 1) return jsonResponse(OK_PROFILES); // version probe
      if (call === 2) return jsonResponse({ status: { code: 20, subCode: 9 }, data: null }, 403);
      return jsonResponse(ONE_PROFILE);
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'stale', username: 'u' },
        renewToken: async () => 'fresh',
      });
      const profiles = await client.getProfiles();
      assert.equal(profiles.length, 1, 'the replay should return the real payload');
      assert.deepEqual(sent.slice(1), ['stale', 'fresh'], 'the replay must carry the new token');
    },
  );
});

test('a superseded token is not retried forever', async () => {
  let call = 0;
  let renewals = 0;
  await withFetch(
    async () => {
      call++;
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 20 }, data: null }, 403);
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'stale', username: 'u' },
        renewToken: async () => {
          renewals++;
          return 'fresh';
        },
      });
      // Aula rejects the replacement too, so the failure has to surface rather
      // than the client renewing its way around in circles.
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          assert.match((err as Error).message, /replaced by a newer one/i);
          return true;
        },
      );
      assert.equal(renewals, 1, 'exactly one recovery attempt per request');
    },
  );
});

test('a token that cannot be renewed surfaces the failure instead of replaying', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 20 }, data: null }, 403);
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'stale', username: 'u' },
        // No login on disk, or the store still holds the dead token.
        renewToken: async () => undefined,
      });
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          assert.match((err as Error).message, /replaced by a newer one/i);
          return true;
        },
      );
      assert.equal(call, 2, 'no replay when there is no better token to replay with');
    },
  );
});

test('concurrent requests share one token recovery', async () => {
  // The whole point of memoising it: three requests failing together must not
  // buy three tokens, because each grant would invalidate the one before it.
  let renewals = 0;
  let call = 0;
  await withFetch(
    async (input: string | Request | URL) => {
      call++;
      if (call === 1) return jsonResponse(OK_PROFILES); // version probe
      const token = new URL(String(input)).searchParams.get('access_token');
      return token === 'stale'
        ? jsonResponse({ status: { code: 20 }, data: null }, 403)
        : jsonResponse(ONE_PROFILE);
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'stale', username: 'u' },
        renewToken: async () => {
          renewals++;
          await new Promise((r) => setTimeout(r, 5));
          return 'fresh';
        },
      });
      const all = await Promise.all([
        client.getProfiles(),
        client.getProfiles(),
        client.getProfiles(),
      ]);
      assert.equal(all.length, 3);
      for (const profiles of all)
        assert.equal(profiles.length, 1, 'every caller gets the replayed payload');
      assert.equal(renewals, 1, 'one renewal shared by all three');
    },
  );
});

test('cookie auth has no token to recover, so code 20 surfaces immediately', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 20 }, data: null }, 403);
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          assert.match((err as Error).message, /replaced by a newer one/i);
          return true;
        },
      );
      assert.equal(call, 2, 'nothing to renew, so nothing replayed');
    },
  );
});

test('an unknown status code reports the HTTP status it arrived with', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      // Aula leaves `message` empty far more often than not, so when a code this
      // client has never seen turns up, the HTTP status is the only clue there is.
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 77, message: '' } }, 418);
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(
        () => client.getThreads(),
        (err: unknown) => {
          assert.match((err as Error).message, /status code 77 \(HTTP 418\)/);
          return true;
        },
      );
    },
  );
});

test('an HTML login page is detected as an expired session', async () => {
  await withFetch(
    async () => new Response('<html><body>Log ind</body></html>', { status: 200 }),
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(() => client.getProfiles(), AulaAuthError);
    },
  );
});

test('a retired API version is probed around instead of failing', async () => {
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      const url = String(input);
      seen.push(url);
      // v24 is retired; v23 answers.
      if (url.includes('/v23/')) return jsonResponse(OK_PROFILES);
      return jsonResponse({ status: { code: 10 }, data: null });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE, apiVersion: 24 });
      await client.getProfiles();
      assert.equal(client.apiVersion, 23);
      assert.ok(seen.some((u) => u.includes('/v23/')));
    },
  );
});

/**
 * The probe's own warning tells the user to pin the version it found. A ceiling
 * measured from the module constant instead of from the version in use would
 * leave anyone who followed that advice unable to find the next live version.
 */
test('the retirement probe searches above whatever version is configured', async () => {
  const tried: number[] = [];
  await withFetch(
    async (input) => {
      const version = Number(/\/v(\d+)\//.exec(String(input))?.[1] ?? 0);
      tried.push(version);
      if (version === 38) return jsonResponse(OK_PROFILES);
      return jsonResponse({ status: { code: 10 }, data: null });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE, apiVersion: 34 });
      await client.getProfiles();
      assert.equal(client.apiVersion, 38);
      assert.ok(
        tried.includes(38),
        `never probed above the fallback constant: ${tried.join(', ')}`,
      );
    },
  );
});

/**
 * `data: null` under `status.code: 0` is Aula saying "nothing", not "broken".
 * Every endpoint wrapper used to end in `?? []` or `?? {}` for exactly this.
 */
test('an empty result is an empty result, not an API error', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 0 }, data: null });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      assert.deepEqual(await client.getNotifications(), []);
      assert.deepEqual(await client.getDailyPresence([11]), []);
      assert.deepEqual(await client.getGroupsByContext([11]), []);
      assert.deepEqual(await client.getAlbums({ childInstitutionProfileIds: [11] }), []);
      assert.deepEqual(
        await client.getPresenceTemplates({
          childInstitutionProfileIds: [11],
          fromDate: '2026-08-01',
          toDate: '2026-08-07',
        }),
        {},
      );
      assert.deepEqual(await client.getCommonFiles({ institutionCodes: ['A12345'] }), {
        commonFiles: [],
        totalAmount: 0,
      });
    },
  );
});

test('a payload of the wrong shape still fails, and says what arrived', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 0 }, data: 'nope' });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await assert.rejects(
        () => client.getNotifications(),
        (err: unknown) => {
          assert.ok(err instanceof AulaApiError);
          assert.match(err.message, /does not understand/);
          assert.match(err.message, /should answer with a list/);
          assert.match(err.message, /Aula sent a string/);
          return true;
        },
      );
    },
  );
});

test('successful-looking endpoint payloads reject malformed rows at the boundary', async () => {
  const cases: Array<{
    name: string;
    data: unknown;
    read: (client: AulaClient) => Promise<unknown>;
  }> = [
    {
      name: 'profiles',
      data: { profiles: [{ profileId: 1, institutionProfiles: [], children: [{ id: '11' }] }] },
      read: (client) => client.getProfiles(),
    },
    {
      name: 'thread list',
      data: { threads: [{ id: '5001', read: false, sensitive: false }], moreMessagesExist: false },
      read: (client) => client.getThreads(),
    },
    {
      name: 'thread detail',
      data: {
        id: 5001,
        sensitive: false,
        messages: [{ id: 1, sendDateTime: '2026-08-24T08:00:00Z' }],
      },
      read: (client) => client.getThread(5001),
    },
    {
      name: 'posts',
      data: { posts: [{ id: '7' }], hasMorePosts: false },
      read: (client) => client.getPosts({ institutionProfileIds: [1] }),
    },
    {
      name: 'calendar',
      data: [{ id: 7, title: 'No start' }],
      read: (client) =>
        client.getCalendarEvents({
          childInstitutionProfileIds: [11],
          start: new Date('2026-08-24T00:00:00Z'),
          end: new Date('2026-08-25T00:00:00Z'),
        }),
    },
    {
      name: 'presence',
      data: [{ status: 3 }],
      read: (client) => client.getDailyPresence([11]),
    },
    {
      name: 'groups',
      data: [{ profileId: 111, groups: [{ id: '5', name: '2E' }] }],
      read: (client) => client.getGroupsByContext([11]),
    },
    {
      name: 'contacts',
      data: [{ birthday: '2016-05-04' }],
      read: (client) => client.getContactList({ groupId: 5 }),
    },
    {
      name: 'presence templates',
      data: { presenceWeekTemplates: 'not a list' },
      read: (client) =>
        client.getPresenceTemplates({
          childInstitutionProfileIds: [11],
          fromDate: '2026-08-24',
          toDate: '2026-08-31',
        }),
    },
    {
      name: 'shared files',
      data: { commonFiles: [{ id: '7' }], totalAmount: 1 },
      read: (client) => client.getCommonFiles({ institutionCodes: ['100001'] }),
    },
  ];

  for (const item of cases) {
    let call = 0;
    await withFetch(
      async () => {
        call++;
        return call === 1
          ? jsonResponse(OK_PROFILES)
          : jsonResponse({ status: { code: 0 }, data: item.data });
      },
      async () => {
        const client = new AulaClient({ cookie: COOKIE });
        await assert.rejects(item.read(client), /does not understand/, item.name);
      },
    );
  }
});

test('remote Aula requests carry an abort signal', async () => {
  const signals: Array<AbortSignal | null | undefined> = [];
  let call = 0;
  await withFetch(
    async (_input, init) => {
      call++;
      signals.push(init?.signal);
      return call === 1 ? jsonResponse(OK_PROFILES) : jsonResponse(ONE_PROFILE);
    },
    async () => {
      await new AulaClient({ cookie: COOKIE }).getProfiles();
    },
  );
  assert.equal(signals.length, 2);
  assert.ok(signals.every((signal) => signal instanceof AbortSignal));
});

test('array query parameters use the PHP-style repeated-key form Aula expects', async () => {
  let captured = '';
  let call = 0;
  await withFetch(
    async (input) => {
      call++;
      if (call === 1) return jsonResponse(OK_PROFILES);
      captured = String(input);
      return jsonResponse({ status: { code: 0 }, data: [] });
    },
    async () => {
      const client = new AulaClient({ cookie: COOKIE });
      await client.getDailyPresence([11, 22]);
      assert.match(captured, /childIds%5B%5D=11/);
      assert.match(captured, /childIds%5B%5D=22/);
    },
  );
});

test("calendar dates use Aula's non-ISO format", () => {
  const formatted = formatAulaDate(new Date(2026, 7, 12, 9, 5, 3));
  assert.match(formatted, /^2026-08-12 09:05:03\.0000[+-]\d{4}$/);
});

test('htmlToText flattens Aula message markup', () => {
  assert.equal(htmlToText('Hej<br />Vitus'), 'Hej\nVitus');
  assert.equal(
    htmlToText('<div>Tusind tak.</div>\n<div>God sommer</div>'),
    'Tusind tak.\nGod sommer',
  );
  assert.equal(
    htmlToText('m&oslash;de p&aring; fredag &amp; l&oslash;rdag'),
    'møde på fredag & lørdag',
  );
  assert.equal(htmlToText('<ul><li>Et</li><li>To</li></ul>'), '- Et\n- To');
  assert.equal(htmlToText('&#127774; sol'), '🌞 sol');
  assert.equal(htmlToText(null), '');
});

// These four fragments reproduce the shapes Aula's editor really emits. Copy the
// *markup* out of a live response, never the words inside it: a fixture pasted
// whole is how a child's name and a signup code once reached this public repo.
test('htmlToText handles the markup Aula really produces', () => {
  // Pretty-printed <p> blocks: paragraphs stay separated.
  assert.equal(
    htmlToText('<div>\n<p>Kære forældre</p>\n<p>SFO tilbyder <strong>hjælp</strong>.</p>\n</div>'),
    'Kære forældre\n\nSFO tilbyder hjælp.',
  );
  // `<div> </div>` is how the editor writes a deliberate blank line.
  assert.equal(
    htmlToText('<div><strong>Hej Valdemar</strong></div>\n<div> </div>\n<div>Jeg håber…</div>'),
    'Hej Valdemar\n\nJeg håber…',
  );
  // Consecutive <br> is the other way it writes one.
  assert.equal(
    htmlToText('Kære alle.<br /><br />I dag har vi leget.'),
    'Kære alle.\n\nI dag har vi leget.',
  );
  // Plain divs are single line breaks, not paragraph breaks.
  assert.equal(htmlToText('<div>Linje et</div>\n<div>Linje to</div>'), 'Linje et\nLinje to');
});

test('htmlToText never leaves more than one blank line', () => {
  assert.equal(htmlToText('<p>a</p><br /><br /><br /><p>b</p>'), 'a\n\nb');
});

test('htmlToText keeps link targets that carry the real information', () => {
  assert.equal(
    htmlToText('<a href="https://x.dk/a">Tilmelding</a>'),
    'Tilmelding (https://x.dk/a)',
  );
  assert.equal(htmlToText('<a href="https://x.dk/a">https://x.dk/a</a>'), 'https://x.dk/a');
});

test('preview collapses whitespace and truncates', () => {
  assert.equal(preview('a\n\n  b'), 'a b');
  assert.equal(preview('abcdef', 4), 'abc…');
});

test('parseSince understands relative and absolute forms', () => {
  const sevenDays = parseSince('7d');
  const delta = Date.now() - sevenDays.getTime();
  assert.ok(Math.abs(delta - 7 * 86_400_000) < 5_000);
  // Local midnight, not UTC midnight: --since names a calendar day in the
  // family's own timezone. Asserting through toISOString() only looked right
  // because `bun test` defaults TZ to UTC — it failed in Europe/Copenhagen,
  // which is the timezone this tool actually runs in.
  const absolute = parseSince('2026-08-01');
  assert.equal(localIsoDate(absolute), '2026-08-01');
  assert.equal(absolute.getHours(), 0);
  assert.ok(Math.abs(Date.now() - parseSince('14').getTime() - 14 * 86_400_000) < 5_000);
  // Aula's own timestamps are full ISO datetimes, so one pasted out of a
  // message or out of `--text` output resolves to the day it names.
  assert.equal(localIsoDate(parseSince('2026-08-01T14:30:00+02:00')), '2026-08-01');
  assert.equal(localIsoDate(parseSince('2026-08-01 14:30')), '2026-08-01');
  assert.throws(() => parseSince('2026-08-01Tnot-a-timestamp'));
  assert.throws(() => parseSince('2026-08-01T25:00:00+02:00'));
  assert.throws(() => parseSince('2026-08-01T14:30:00+15:00'));
  assert.throws(() => parseSince('not-a-date'));
  assert.throws(() => parseSince('2026-02-31'));
  assert.throws(() => parseSince('2026-8-1'));
});

// -------------------------------------------------------- the raw escape hatch

test('the raw escape hatch reaches unwrapped reads but still refuses writes', () => {
  // Not in the named allowlist, but unmistakably a read.
  assert.doesNotThrow(() => assertReadOnly('gallery.getAlbums', 'GET', { allowAnyGetter: true }));
  assert.doesNotThrow(() =>
    assertReadOnly('posts.hasUnreadPosts', 'GET', { allowAnyGetter: true }),
  );
  assert.doesNotThrow(() =>
    assertReadOnly('presence.isCheckedIn', 'GET', { allowAnyGetter: true }),
  );

  for (const method of [
    'messaging.sendMessage',
    'posts.createPost',
    'calendar.updateEventResponse',
    'presence.updatePresenceTemplate',
    'profiles.getContactlist; DROP TABLE',
    'getEverything',
  ]) {
    assert.throws(
      () => assertReadOnly(method, 'GET', { allowAnyGetter: true }),
      AulaApiError,
      `${method} must still be refused`,
    );
  }
});

test('the raw escape hatch cannot POST, not even to an allowlisted read', () => {
  assert.throws(
    () => assertReadOnly('gallery.getAlbums', 'POST', { allowAnyGetter: true }),
    AulaApiError,
  );
  assert.throws(
    () => assertReadOnly('messaging.getThreads', 'POST', { allowAnyGetter: true }),
    AulaApiError,
  );
});

// ------------------------------------------------------------ new endpoints

/** Answers the version probe, then hands the next call to `handler`. */
function withProbedFetch<T>(
  handler: (url: string) => unknown,
  fn: (urls: string[]) => Promise<T>,
): Promise<T> {
  const urls: string[] = [];
  let call = 0;
  return withFetch(
    async (input) => {
      call++;
      if (call === 1) return jsonResponse(OK_PROFILES);
      const url = String(input);
      urls.push(url);
      return jsonResponse({ status: { code: 0 }, data: handler(url) });
    },
    () => fn(urls),
  );
}

test('presence templates use filterInstitutionProfileIds, not childIds', async () => {
  await withProbedFetch(
    () => ({ presenceWeekTemplates: [] }),
    async (urls) => {
      const client = new AulaClient({ cookie: COOKIE });
      await client.getPresenceTemplates({
        childInstitutionProfileIds: [4242, 4343],
        fromDate: '2026-08-10',
        toDate: '2026-08-16',
      });
      const params = new URL(urls[0] as string).searchParams;
      assert.equal(params.get('method'), 'presence.getPresenceTemplates');
      assert.deepEqual(params.getAll('filterInstitutionProfileIds[]'), ['4242', '4343']);
      assert.equal(params.get('fromDate'), '2026-08-10');
      assert.equal(params.get('toDate'), '2026-08-16');
    },
  );
});

test('the contact list is paged from 1 and stops on an empty page', async () => {
  await withProbedFetch(
    (url) => {
      const page = Number(new URL(url).searchParams.get('page'));
      return page <= 2 ? [{ profileId: page, fullName: `Barn ${page}`, role: 'child' }] : [];
    },
    async (urls) => {
      const client = new AulaClient({ cookie: COOKIE });
      const first = await client.getContactList({ groupId: 65240 });
      const params = new URL(urls[0] as string).searchParams;
      assert.equal(params.get('method'), 'profiles.getContactlist');
      assert.equal(params.get('groupId'), '65240');
      assert.equal(params.get('page'), '1', 'this endpoint is 1-based, unlike the rest');
      assert.equal(params.get('filter'), 'child');
      assert.equal(first.length, 1);
    },
  );
});

test('groups and widget tokens hit the endpoints they claim to', async () => {
  await withProbedFetch(
    (url) => (url.includes('aulaToken') ? 'jwt-token' : [{ profileId: 7, groups: [] }]),
    async (urls) => {
      const client = new AulaClient({ cookie: COOKIE });
      await client.getGroupsByContext([4242]);
      assert.deepEqual(
        new URL(urls[0] as string).searchParams.getAll('childInstitutionProfileIds[]'),
        ['4242'],
      );

      assert.equal(await client.getWidgetToken('0004'), 'jwt-token');
      assert.equal(new URL(urls[1] as string).searchParams.get('widgetId'), '0004');
    },
  );
});

test('empty id sets short-circuit instead of asking Aula for nothing', async () => {
  await withProbedFetch(
    () => [],
    async (urls) => {
      const client = new AulaClient({ cookie: COOKIE });
      assert.deepEqual(await client.getDailyPresence([]), []);
      assert.deepEqual(await client.getGroupsByContext([]), []);
      assert.deepEqual(
        await client.getPresenceTemplates({
          childInstitutionProfileIds: [],
          fromDate: '2026-08-10',
          toDate: '2026-08-16',
        }),
        {},
      );
      assert.equal(urls.length, 0, 'no requests should have been sent');
    },
  );
});

// -------------------------------------------------------------- presence enum

test('presence statuses match the values Aula actually renders', () => {
  // Regression guard: this mapping was off by one, which turned "på tur" into
  // "present" and "ferie/fri" into "sick".
  assert.equal(presenceStatusDanish(0), 'Ikke kommet');
  assert.equal(presenceStatusDanish(1), 'Syg');
  assert.equal(presenceStatusDanish(2), 'Ferie/fri');
  assert.equal(presenceStatusDanish(3), 'Kommet/til stede');
  assert.equal(presenceStatusDanish(4), 'På tur');
  assert.equal(presenceStatusDanish(5), 'Sover');
  assert.equal(presenceStatusDanish(8), 'Gået');
  assert.equal(presenceStatus(3), 'present');
  assert.equal(presenceStatus(99), 'status 99');
});

test('a presence template is flattened whichever pickup type it uses', () => {
  const { days } = normaliseSchedule(
    {
      presenceWeekTemplates: [
        {
          institutionProfile: { id: 4242, name: 'Alma' },
          dayTemplates: [
            // "Hentes af" — times nested under `pickup`.
            {
              date: '2026-08-11',
              activityType: 0,
              pickup: { entryTime: '08:00', exitTime: '15:30', exitWith: 'Farmor' },
            },
            // "Selvbestemmer" — a window rather than a time.
            {
              date: '2026-08-10',
              activityType: 1,
              selfDecider: { entryTime: '08:15', exitStartTime: '14:00', exitEndTime: '16:00' },
            },
            // "Sendes hjem" — no exitWith at all.
            {
              date: '2026-08-12',
              activityType: 2,
              sendHome: { entryTime: '08:00', exitTime: '14:45' },
              comment: 'Går til fodbold',
            },
          ],
        },
      ],
    },
    { from: '2026-08-10', to: '2026-08-16' },
  );

  assert.deepEqual(
    days.map((d) => d.date),
    ['2026-08-10', '2026-08-11', '2026-08-12'],
    'sorted by date, not by the order Aula returned',
  );
  assert.equal(days[0]?.exitTime, '14:00–16:00');
  assert.equal(days[0]?.pickupType, 'may leave alone within a window');
  assert.equal(days[1]?.exitWith, 'Farmor');
  assert.equal(days[1]?.child, 'Alma');
  assert.equal(days[2]?.exitWith, null);
  assert.equal(days[2]?.comment, 'Går til fodbold');
});

// ------------------------------------------------------------------ birthdays

test('birthdays are ordered by how soon they are, wrapping the year', () => {
  const today = new Date();
  // Built from local parts: `toISOString` would shift the day for any timezone
  // east of Greenwich, which is exactly where this tool is used.
  const localDate = (offsetDays: number) => {
    const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offsetDays);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `2016-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  };

  const rows = upcomingBirthdays([
    { fullName: 'Eksempel Sent', birthday: localDate(-1), group: '5A' },
    { fullName: 'Eksempel Snart', birthday: localDate(3), group: '5A' },
    // No birthday shared — dropped rather than rendered as "unknown".
    { fullName: 'Ukendt', group: '5A' },
  ]);

  assert.deepEqual(
    rows.map((r) => r.name),
    ['Eksempel Snart', 'Eksempel Sent'],
  );
  assert.equal(rows[0]?.inDays, 3);
  assert.ok((rows[1]?.inDays ?? 0) > 300, 'a birthday just past wraps to next year');
});

// ---------------------------------------------------------------- CLI parsing

test('resolveWeek accepts an explicit week, --next, or defaults to this week', () => {
  assert.equal(resolveWeek('2026-W33', false), '2026-W33');
  assert.match(resolveWeek(undefined, false), /^\d{4}-W\d{2}$/);
  assert.notEqual(resolveWeek(undefined, true), resolveWeek(undefined, false));
  assert.throws(() => resolveWeek('week 33', false));
  assert.throws(
    () => resolveWeek('2025-W53', false),
    /must look like/,
    'week 53 does not exist in 2025',
  );
  // A hand-typed one-digit week is padded rather than refused; everything
  // downstream keys on the canonical form.
  assert.equal(resolveWeek('2026-W3', false), '2026-W03');
  assert.equal(resolveWeek('2026-w3', false), '2026-W03');
  assert.throws(() => resolveWeek('2026-W0', false));
  assert.throws(() => resolveWeek('2026-W54', false));
});

test('raw key=value pairs collapse repeats into an array', () => {
  assert.deepEqual(parseKeyValues(['groupId=5', 'filter=child']), {
    groupId: '5',
    filter: 'child',
  });
  assert.deepEqual(parseKeyValues(['childIds=1', 'childIds=2', 'childIds=3']), {
    childIds: ['1', '2', '3'],
  });
  // A value may itself contain "=", so only the first one splits.
  assert.deepEqual(parseKeyValues(['q=a=b']), { q: 'a=b' });
  assert.throws(() => parseKeyValues(['nope']));
});

test('mapLimit bounds concurrency and preserves input order', async () => {
  let active = 0;
  let peak = 0;
  const result = await mapLimit([3, 1, 2], 2, async (value) => {
    active++;
    peak = Math.max(peak, active);
    await Bun.sleep(value);
    active--;
    return value * 10;
  });
  assert.deepEqual(result, [30, 10, 20]);
  assert.equal(peak, 2);
  await assert.rejects(() => mapLimit([1], 0, async (value) => value), RangeError);
});

// --------------------------------------------------------------- attachments

test('attachments are indexed across all three kinds Aula models', () => {
  const found = listAttachments([
    { name: 'seddel.pdf', file: { name: 'seddel.pdf', url: 'https://cf/1' } },
    { name: 'foto.jpg', media: { name: 'foto.jpg', url: 'https://cf/2' } },
    { name: 'Tilmelding', link: { name: 'Tilmelding', url: 'https://x.dk' } },
    // No target at all — skipped, so the indices stay contiguous.
    { name: 'broken' },
  ]);
  assert.deepEqual(
    found.map((a) => [a.index, a.kind]),
    [
      [0, 'file'],
      [1, 'media'],
      [2, 'link'],
    ],
  );
});

test('attachment filenames cannot escape the download directory', () => {
  assert.equal(safeFilename('../../.ssh/authorized_keys'), 'ssh_authorized_keys');
  assert.equal(safeFilename('..'), 'attachment');
  assert.equal(safeFilename('/etc/passwd'), 'etc_passwd');
  assert.equal(safeFilename('Ugeplan uge 33.pdf'), 'Ugeplan uge 33.pdf');
  assert.equal(safeFilename('....'), 'attachment');
  assert.equal(safeFilename(''), 'attachment');
});

// --------------------------------------------------------- session bootstrap

/**
 * Aula's session rules, which the plain stub above does not model and which are
 * the whole reason `digest` used to fail.
 *
 * A request arriving without `PHPSESSID` gets a fresh PHP session. That session
 * can read the two profile endpoints and nothing else: every module endpoint
 * answers HTTP 403 + status code 10 until `getProfileContext` has run *inside
 * that same session* and activated a profile. See API.md.
 */
function sessionEnforcingAula(): { handler: FetchStub; sessions: number } & { sent: string[] } {
  const activated = new Set<string>();
  const sent: string[] = [];
  let minted = 0;

  const handler: FetchStub = async (input, init) => {
    const url = new URL(String(input));
    const method = url.searchParams.get('method') ?? '';
    sent.push(method);
    // Latency is load-bearing, not decoration. A stub that resolves in the same
    // microtask lets the handshake finish before the racing reads are issued,
    // which hides the bug this test exists for — the first version of this test
    // passed against the broken client for exactly that reason.
    await new Promise((resolve) => setTimeout(resolve, 10));

    const cookies = String((init?.headers as Record<string, string>)?.Cookie ?? '');
    let sid = /PHPSESSID=([^;]+)/.exec(cookies)?.[1];
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (!sid) {
      sid = `S${++minted}`;
      headers['set-cookie'] = `PHPSESSID=${sid}; Path=/`;
    }

    if (method === 'profiles.getProfilesByLogin') {
      return new Response(JSON.stringify(OK_PROFILES), { status: 200, headers });
    }
    if (method === 'profiles.getProfileContext') {
      activated.add(sid);
      return new Response(
        JSON.stringify({
          status: { code: 0 },
          data: { userId: 'vald42a1', institutionProfiles: [] },
        }),
        { status: 200, headers },
      );
    }
    if (!activated.has(sid)) {
      return new Response(JSON.stringify({ status: { code: 10 }, data: null }), {
        status: 403,
        headers,
      });
    }
    const data =
      method === 'messaging.getThreads'
        ? { threads: [], moreMessagesExist: false, page: Number(url.searchParams.get('page') ?? 0) }
        : [];
    return new Response(JSON.stringify({ status: { code: 0 }, data }), {
      status: 200,
      headers,
    });
  };

  return { handler, sessions: minted, sent };
}

/**
 * The regression that 275 passing tests missed.
 *
 * `buildDigest` fans six reads out at once. While the handshake was tracked by
 * booleans set *before* their awaits, exactly one of those reads waited for it
 * and the rest went out against a session with no activated profile — so the
 * command that the skill runs for nearly every question failed with status code
 * 10, or with `Invalid CSRF Token` on the calendar POST, roughly half the time.
 */
test('concurrent reads all wait for the session bootstrap', async () => {
  const aula = sessionEnforcingAula();
  await withFetch(aula.handler, async () => {
    const client = new AulaClient({
      auth: { kind: 'token', accessToken: 'tok', username: 'valdemarex' },
    });
    // Six at once, as buildDigest issues them. None may reach the wire before
    // getProfileContext has activated a profile in the jar's session.
    await Promise.all([
      client.getThreads(0),
      client.getNotifications(),
      client.getGroupsByContext([11]),
      client.getThreads(1),
      client.getNotifications(),
      client.getGroupsByContext([22]),
    ]);
  });

  // One handshake for the fan-out, not one per caller and not none.
  assert.equal(
    aula.sent.filter((m) => m === 'profiles.getProfileContext').length,
    1,
    'the bootstrap should be performed exactly once and shared',
  );
});

test('a failed bootstrap is not sticky for the life of the client', async () => {
  const sent: string[] = [];
  let failNext = true;
  const handler: FetchStub = async (input) => {
    const method = new URL(String(input)).searchParams.get('method') ?? '';
    sent.push(method);
    if (method === 'profiles.getProfileContext' && failNext) {
      failNext = false;
      return jsonResponse({ status: { code: 500 }, data: null }, 500);
    }
    if (method === 'profiles.getProfilesByLogin') return jsonResponse(OK_PROFILES);
    return jsonResponse({
      status: { code: 0 },
      data: { threads: [], moreMessagesExist: false, page: 0 },
    });
  };

  await withFetch(handler, async () => {
    const client = new AulaClient({
      auth: { kind: 'token', accessToken: 'tok', username: 'valdemarex' },
    });
    await assert.rejects(() => client.getThreads(0));
    await client.getThreads(0);
  });

  // The retry has to re-run the handshake rather than sail past a memo that a
  // failed attempt left behind. Two attempts, so two bootstraps.
  assert.equal(
    sent.filter((m) => m === 'profiles.getProfileContext').length,
    2,
    'a bootstrap that threw must be retried, not remembered as done',
  );
});

/**
 * The failure that started all this.
 *
 * Aula answers an access token it will not accept with HTTP 500 *and* a status
 * code 0 — "success" — envelope, so believing the envelope handed `"intern
 * fejl"` on as data and the user was eventually told the payload was malformed:
 * a shape complaint, three layers from the cause, for a dead login.
 */
const INTERN_FEJL = { status: { code: 0, message: 'intern fejl' }, data: 'intern fejl' };

test('a 500 with a success envelope is reported as a rejected login, not a shape error', async () => {
  const seen: string[] = [];
  await withFetch(
    async (input) => {
      const authenticated = new URL(String(input)).searchParams.has('access_token');
      seen.push(authenticated ? 'authenticated' : 'anonymous');
      // A healthy Aula turns a credential-free request away cleanly, which is
      // what tells the two causes of a 500 apart.
      return authenticated
        ? jsonResponse(INTERN_FEJL, 500)
        : jsonResponse({ status: { code: 448 }, data: null }, 403);
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'stale', username: 'u' },
      });
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          assert.ok(
            err instanceof AulaAuthError,
            'a token Aula will not accept is an auth problem',
          );
          assert.match(err.message, /rejected your login/i);
          assert.match(err.message, /bun run login/);
          assert.doesNotMatch(err.message, /malformed|payload/i, 'the old, misleading complaint');
          return true;
        },
      );
    },
  );

  assert.equal(
    seen.filter((s) => s === 'anonymous').length,
    1,
    'it should ask once whether Aula is up at all, and not once per failed read',
  );
});

test('a 500 that Aula gives everyone is reported as an outage, not as a login problem', async () => {
  await withFetch(
    async () => jsonResponse(INTERN_FEJL, 500),
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'fine', username: 'u' },
      });
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          assert.ok(err instanceof AulaApiError);
          assert.ok(!(err instanceof AulaAuthError), 'logging in again would not help');
          assert.match(err.message, /having trouble/i);
          // Sending someone through a MitID round-trip on their phone to fix an
          // outage is the specific waste this distinction buys.
          assert.doesNotMatch(err.message, /bun run login/);
          return true;
        },
      );
    },
  );
});

test('a success envelope of the wrong shape says what arrived and how to look at it', async () => {
  let call = 0;
  await withFetch(
    async () => {
      call++;
      // The version probe has to succeed or the read never happens.
      return call === 1
        ? jsonResponse(OK_PROFILES)
        : jsonResponse({ status: { code: 0 }, data: 'intern fejl' });
    },
    async () => {
      const client = new AulaClient({
        auth: { kind: 'token', accessToken: 'tok', username: 'u' },
      });
      await assert.rejects(
        () => client.getProfiles(),
        (err: unknown) => {
          // The detail is wrapped to the terminal, so match on the flattened text.
          const flat = (err as Error).message.replace(/\s+/g, ' ');
          assert.match(flat, /does not understand/i);
          assert.match(flat, /a string \("intern fejl"\)/, 'name what actually arrived');
          assert.match(flat, /aula raw profiles\.getProfilesByLogin/, 'and how to go and see it');
          return true;
        },
      );
    },
  );
});
