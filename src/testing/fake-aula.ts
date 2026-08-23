/**
 * A stand-in for Aula and for Meebook, installed over `globalThis.fetch`.
 *
 * Loaded with `bun --preload`, so it is in place before `cli.ts` runs its
 * top-level `main()`. That is what makes it possible to test the CLI as the
 * user runs it — through argument parsing, dispatch and rendering — rather than
 * testing the helpers underneath and hoping the wiring between them is right.
 * The bug this was written for (`digest` silently dropping `--child`) lived
 * exactly in that wiring, and no unit test of the helpers could have seen it.
 *
 * Every request is appended to `$FAKE_AULA_LOG`, one method per line, which is
 * how the cache tests count what a second run actually sent.
 *
 * The family: two children at two different institutions, so anything that
 * fails to narrow shows up as the *other* child's data appearing in the output.
 */

import { appendFileSync } from 'node:fs';
import { isNumber, isRecord } from '../validation.ts';

// -------------------------------------------------------------------- fixture

const CHILDREN = [
  {
    id: 11,
    profileId: 111,
    name: 'Alma Eksempelsen',
    shortName: 'ALEK',
    institutionCode: '100001',
    institutionName: 'Eksempelskolen',
    userId: 'alma0101',
  },
  {
    id: 22,
    profileId: 222,
    name: 'Viggo Eksempelsen',
    shortName: 'VIEK',
    institutionCode: 'E10002',
    institutionName: 'Børnehuset Eksemplet',
    userId: 'vigg0202',
  },
] as const;

const PROFILES = {
  profiles: [
    {
      profileId: 999,
      displayName: 'Valdemar Eksempelsen',
      institutionProfiles: [
        { id: 901, institutionCode: '100001', institutionName: 'Eksempelskolen' },
        { id: 902, institutionCode: 'E10002', institutionName: 'Børnehuset Eksemplet' },
      ],
      children: CHILDREN,
    },
  ],
};

/**
 * Fault injection, so the states `doctor` exists to report can be provoked:
 *
 *   FAKE_AULA_NO_STEPUP=1    sensitive threads would read as empty
 *   FAKE_AULA_EMPTY_POSTS=1  the "wrong id set looks like an empty feed" trap
 *   FAKE_AULA_FAIL=<method>  that one method answers 403
 *   FAKE_AULA_FAIL_THREAD=<id>  that one thread's messages answer 403
 *   FAKE_AULA_STALE_TOKEN=1  every widget token is rejected once as expired
 *   FAKE_AULA_REJECT_TOKEN=1 Aula will not accept the access token
 *   FAKE_AULA_DOWN=1         Aula is broken for everyone, credentials or not
 */
const PROFILE_CONTEXT = {
  userId: 'vald42a1',
  isSteppedUp: process.env.FAKE_AULA_NO_STEPUP !== '1',
  institutionProfile: { fullName: 'Valdemar Eksempelsen' },
  institutions: [
    {
      institutionCode: '100001',
      institutionName: 'Eksempelskolen',
      institutionType: 'School',
      institutionProfileId: 901,
      groups: [{ id: 5001, name: '2E' }],
    },
    {
      institutionCode: 'E10002',
      institutionName: 'Børnehuset Eksemplet',
      // The live API labels institutions, and the label is what keeps daycare
      // children away from the weekly-plan vendors.
      institutionType: 'Daycare',
      institutionProfileId: 902,
      groups: [{ id: 5002, name: 'Myretuen' }],
    },
  ],
  pageConfiguration: {
    widgetConfigurations: [{ widget: { widgetId: '0004', name: 'Meebook Ugeplan' } }],
  },
};

/** One thread per child, plus one addressed to neither. */
const THREADS = [
  {
    id: 5001,
    subject: 'Lejrskole for 2E',
    read: false,
    sensitive: false,
    startedTime: iso(-1),
    institutionCode: '100001',
    regardingChildren: [{ profileId: 111, displayName: 'Alma Eksempelsen' }],
    creator: { fullName: 'Yrsa Storm' },
    latestMessage: { sendDateTime: iso(-1), text: { html: 'Vi tager af sted mandag.' } },
  },
  {
    id: 5002,
    subject: 'Lukkedag i Myretuen',
    read: true,
    sensitive: false,
    startedTime: iso(-2),
    institutionCode: 'E10002',
    regardingChildren: [{ profileId: 222, displayName: 'Viggo Eksempelsen' }],
    creator: { fullName: 'Pædagog Palle' },
    latestMessage: { sendDateTime: iso(-2), text: { html: 'Vi holder lukket fredag.' } },
  },
  {
    id: 5003,
    subject: 'Til alle forældre',
    read: true,
    sensitive: false,
    startedTime: iso(-3),
    institutionCode: '100001',
    regardingChildren: [],
    creator: { fullName: 'Skoleleder' },
    latestMessage: { sendDateTime: iso(-3), text: { html: 'Husk forældremødet.' } },
  },
];

/**
 * Thread bodies, oldest first.
 *
 * 5001 is deliberately a back-and-forth rather than a single message: an active
 * conversation is its own shape on the brief — summarised on the card, the whole
 * exchange behind the more-block — and a fixture where every thread is one
 * message would never exercise it.
 */
const MESSAGES: Record<number, { from: string; role: string; ago: number; html: string }[]> = {
  5001: [
    {
      from: 'Yrsa Storm',
      role: 'employee',
      ago: -4,
      html: 'Vi tager af sted mandag den 25. Husk regntøj.',
    },
    {
      from: 'Far Eksempelsen',
      role: 'guardian',
      ago: -3,
      html: 'Skal de have madpakke med begge dage?',
    },
    {
      from: 'Yrsa Storm',
      role: 'employee',
      ago: -2,
      html: 'Kun mandag. Tirsdag sørger vi for maden.',
    },
    { from: 'Far Eksempelsen', role: 'guardian', ago: -1, html: 'Perfekt, tak.' },
  ],
  5002: [
    { from: 'Pædagog Palle', role: 'employee', ago: -2, html: 'Vi holder lukket fredag den 29.' },
  ],
  5003: [
    {
      from: 'Skoleleder',
      role: 'employee',
      ago: -3,
      html: 'Husk forældremødet på torsdag klokken 17.',
    },
  ],
};

/** Keyed by the institution-profile id that makes the post visible. */
const POSTS = [
  { id: 7001, forId: 11, title: 'Ugeplan 2E', institutionCode: '100001' },
  { id: 7002, forId: 22, title: 'Sommerfest i Myretuen', institutionCode: 'E10002' },
  { id: 7003, forId: 901, title: 'Nyt fra skolebestyrelsen', institutionCode: '100001' },
];

const EVENTS = [
  { id: 8001, forId: 11, title: 'Lejrskole' },
  { id: 8002, forId: 22, title: 'Bedsteforældredag' },
];

/**
 * Keyed by the child institution-profile id the album is visible to. The dates
 * deliberately do **not** descend in array order: Aula sorts on `mediaCreatedAt`
 * and returns `creationDate`, so the two disagree on the live API. Reproducing
 * that here is what keeps the CLI's own sort honest.
 */
const ALBUMS = [
  { id: 9001, forId: 11, title: 'Tur til stranden', at: -2, group: '2E', inst: 'Eksempelskolen' },
  {
    id: 9002,
    forId: 22,
    title: 'Sommerfest i Myretuen',
    at: -9,
    group: 'Myretuen',
    inst: 'Børnehuset Eksemplet',
  },
  { id: 9003, forId: 11, title: 'Fastelavn i 2E', at: -5, group: '2E', inst: 'Eksempelskolen' },
];

// ---------------------------------------------------------------- the handler

function iso(daysFromNow: number): string {
  // Fixed offsets from "now" so the `--since` windows the CLI computes always
  // contain them, whenever the suite happens to run.
  return new Date(Date.now() + daysFromNow * 86_400_000).toISOString();
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ status: { code: 0, message: 'OK' }, data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function numbers(params: URLSearchParams, key: string): number[] {
  return params.getAll(`${key}[]`).map(Number);
}

let issuedTokens = 0;

function record(what: string): void {
  const log = process.env.FAKE_AULA_LOG;
  if (log) appendFileSync(log, `${what}\n`);
}

async function handle(input: string | Request | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );

  if (url.host === 'app.meebook.com') {
    record(`meebook ${url.searchParams.getAll('childFilter[]').join(',')}`);
    // Meebook announces a dead token with HTTP 200 and a message, which is what
    // `WidgetTokens.withToken` recovers from by asking for a fresh one. Only
    // the first token ever issued is rejected, so the retry can succeed.
    if (process.env.FAKE_AULA_STALE_TOKEN === '1') {
      const bearer = new Headers(init?.headers).get('authorization') ?? '';
      if (bearer.endsWith('-1')) {
        return new Response(JSON.stringify({ message: 'JWT-Token expired, please renew.' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    const wanted = new Set(url.searchParams.getAll('childFilter[]'));
    return new Response(
      JSON.stringify(
        CHILDREN.filter((c) => wanted.has(c.userId)).map((c) => ({
          id: c.id,
          name: c.name,
          unilogin: c.userId,
          weekPlan: [{ date: 'mandag', tasks: [{ type: 'task', title: `Opgave til ${c.name}` }] }],
        })),
      ),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }

  const method = url.searchParams.get('method') ?? '';
  record(method);

  if (method === process.env.FAKE_AULA_FAIL) {
    return new Response(JSON.stringify({ status: { code: 403 }, data: null }), {
      status: 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  // Verbatim from aula.dk: an access token it will not accept comes back as an
  // HTTP 500 carrying a status code 0 — *success* — envelope, with the error
  // in `data` where the payload belongs. Reproduced exactly, because the whole
  // difficulty of that failure was that nothing in the body admits to being
  // about credentials. A credential-free request is still answered properly,
  // which is what lets the client tell this apart from Aula being down.
  const INTERN_FEJL = { status: { code: 0, message: 'intern fejl' }, data: 'intern fejl' };
  if (process.env.FAKE_AULA_DOWN === '1') {
    return new Response(JSON.stringify(INTERN_FEJL), {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  }
  if (process.env.FAKE_AULA_REJECT_TOKEN === '1') {
    const body = url.searchParams.has('access_token')
      ? INTERN_FEJL
      : { status: { code: 448 }, data: null };
    return new Response(JSON.stringify(body), {
      status: url.searchParams.has('access_token') ? 500 : 403,
      headers: { 'content-type': 'application/json' },
    });
  }

  switch (method) {
    case 'profiles.getProfilesByLogin':
      return envelope(PROFILES);
    case 'profiles.getProfileContext':
      return envelope(PROFILE_CONTEXT);
    case 'messaging.getThreads':
      return envelope({
        threads: Number(url.searchParams.get('page') ?? 0) === 0 ? THREADS : [],
        moreMessagesExist: false,
      });
    case 'messaging.getMessagesForThread': {
      const threadId = Number(url.searchParams.get('threadId'));
      // One unreadable thread among readable ones. `FAKE_AULA_FAIL` can only
      // take out the whole method, and the interesting case is the other one:
      // a single thread the guardian has lost access to, which the digest
      // swallows so the rest of the run survives.
      if (String(threadId) === process.env.FAKE_AULA_FAIL_THREAD) {
        return new Response(JSON.stringify({ status: { code: 403 }, data: null }), {
          status: 403,
          headers: { 'content-type': 'application/json' },
        });
      }
      const messages = MESSAGES[threadId] ?? [];
      return envelope({
        id: threadId,
        subject: THREADS.find((t) => t.id === threadId)?.subject ?? '?',
        totalMessageCount: messages.length,
        moreMessagesExist: false,
        recipients: [],
        messages: messages.map((m, i) => ({
          id: `m-${threadId}-${i}`,
          sendDateTime: iso(m.ago),
          sender: { fullName: m.from, mailBoxOwner: { portalRole: m.role } },
          text: { html: m.html },
        })),
      });
    }
    case 'posts.getAllPosts': {
      const ids = new Set(numbers(url.searchParams, 'institutionProfileIds'));
      const page = Number(url.searchParams.get('index') ?? 0);
      const visible =
        process.env.FAKE_AULA_EMPTY_POSTS === '1' ? [] : POSTS.filter((p) => ids.has(p.forId));
      return envelope({ posts: page === 0 ? visible.map(toPost) : [], hasMorePosts: false });
    }
    case 'gallery.getAlbums': {
      const ids = new Set(numbers(url.searchParams, 'filterInstProfileIds'));
      const page = Number(url.searchParams.get('index') ?? 0);
      // Aula prepends a synthetic tagged-media row with a null id, and does so
      // regardless of the filter — including when the filter matches nothing.
      const tagged = {
        id: null,
        title: 'Medier af dig og dine børn',
        creationDate: iso(0),
        creator: null,
        sharedWithGroups: [],
        thumbnailsUrls: ['https://media.example/tagged.jpg'],
      };
      const visible = ALBUMS.filter((a) => ids.has(a.forId)).map((a) => ({
        id: a.id,
        title: a.title,
        description: '',
        creationDate: iso(a.at),
        creator: { name: 'Yrsa Storm', institutionName: a.inst },
        sharedWithGroups: [{ id: 5001, name: a.group, institutionName: a.inst }],
        // One, always — Aula caps this cover preview regardless of how many
        // photos the album holds. Serving a plausible-looking two here would
        // hide the fact that it cannot be used as a count.
        thumbnailsUrls: ['https://media.example/1.jpg'],
      }));
      return envelope(page === 0 ? [tagged, ...visible] : []);
    }
    case 'calendar.getEventsByProfileIdsAndResourceIds': {
      const body: unknown = JSON.parse(String(init?.body ?? '{}'));
      const rawIds =
        isRecord(body) && Array.isArray(body.instProfileIds)
          ? body.instProfileIds.filter(isNumber)
          : [];
      const ids = new Set(rawIds);
      return envelope(
        EVENTS.filter((e) => ids.has(e.forId)).map((e) => ({
          id: e.id,
          title: e.title,
          startDateTime: iso(2),
          endDateTime: iso(2),
          belongsToProfiles: [e.forId],
        })),
      );
    }
    case 'presence.getDailyOverview': {
      const ids = new Set(numbers(url.searchParams, 'childIds'));
      return envelope(
        CHILDREN.filter((c) => ids.has(c.id)).map((c) => ({
          status: 3,
          institutionProfile: { name: c.name, institutionName: c.institutionName },
        })),
      );
    }
    case 'presence.getPresenceTemplates':
      return envelope({ presenceWeekTemplates: [] });
    case 'groups.getGroupsByContext': {
      const ids = new Set(numbers(url.searchParams, 'childInstitutionProfileIds'));
      return envelope(
        CHILDREN.filter((c) => ids.has(c.id)).map((c) => ({
          profileId: c.profileId,
          groups: [{ id: c.id === 11 ? 5001 : 5002, name: c.id === 11 ? '2E' : 'Myretuen' }],
        })),
      );
    }
    case 'profiles.getContactlist':
      return envelope(
        Number(url.searchParams.get('page') ?? 1) === 1
          ? [{ profileId: 1, fullName: 'Klassekammerat', birthday: '2016-05-04' }]
          : [],
      );
    case 'notifications.getNotificationsForActiveProfile':
      return envelope([]);
    case 'commonFiles.getCommonFiles':
      return envelope({ commonFiles: [], totalAmount: 0 });
    case 'aulaToken.getAulaToken':
      // Serialised so a caller can tell a re-issued token from the one it had.
      return envelope(`fake-widget-jwt-${++issuedTokens}`);
    default:
      return envelope(null);
  }
}

function toPost(p: (typeof POSTS)[number]) {
  return {
    id: p.id,
    title: p.title,
    publishAt: iso(-1),
    content: { html: `Indhold for ${p.title}` },
    ownerProfile: { fullName: 'Afsender', institutionCode: p.institutionCode },
    sharedWithGroups: [],
  };
}

globalThis.fetch = handle as unknown as typeof fetch;
