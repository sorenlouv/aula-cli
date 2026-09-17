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
        { id: 901, profileId: 999, institutionCode: '100001', institutionName: 'Eksempelskolen' },
        {
          id: 902,
          profileId: 999,
          institutionCode: 'E10002',
          institutionName: 'Børnehuset Eksemplet',
        },
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
 *   FAKE_AULA_FAIL_THREAD_PAGE=<id>:<page>  one later message page answers 503
 *   FAKE_AULA_THREAD_PAGE_SIZE=<n>  paginate thread bodies for integration tests
 *   FAKE_AULA_CONTACT_PAGES=<n>  serve one distinct contact on each page
 *   FAKE_AULA_COMMON_FILES=<n>  serve this many paged shared files
 *   FAKE_AULA_EXTRA_THREADS=<n>  this many more threads, twenty to a page
 *   FAKE_AULA_BROKER_EXPIRED=1  the silent re-authorise lands on the broker's login page
 *   FAKE_AULA_STALE_TOKEN=1  every widget token is rejected once as expired
 *   FAKE_AULA_REJECT_TOKEN=1 Aula will not accept the access token
 *   FAKE_AULA_DOWN=1         Aula is broken for everyone, credentials or not
 */
const PROFILE_CONTEXT = {
  id: 901,
  userId: 'vald42a1',
  portalRole: 'guardian',
  isSteppedUp: process.env.FAKE_AULA_NO_STEPUP !== '1',
  institutionProfile: { id: 901, profileId: 999, fullName: 'Valdemar Eksempelsen' },
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
 * Where the fixture's files live. Shaped like the real thing — a presigned URL
 * whose query string *is* the authorisation — so a test can assert that no
 * payload ever carries one: `Signature=` appearing on stdout is the failure.
 */
const FILE_HOST = 'files.eksempel.dk';
const signed = (name: string) =>
  `https://${FILE_HOST}/${encodeURIComponent(name)}?Expires=1&Signature=FAKE-SIGNATURE`;

type FixtureAttachment = {
  id: number;
  name: string;
  file?: { name: string; url: string };
  media?: { name: string; url: string };
  link?: { name: string; url: string };
};

/**
 * Thread bodies, oldest first.
 *
 * 5001 is deliberately a back-and-forth rather than a single message: an active
 * conversation is its own shape on the brief — summarised on the card, the whole
 * exchange behind the more-block — and a fixture where every thread is one
 * message would never exercise it.
 */
const MESSAGES: Record<
  number,
  { from: string; role: string; ago: number; html: string; attachments?: FixtureAttachment[] }[]
> = {
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
      // On the third and fourth messages on purpose. Attachments are numbered
      // across the whole thread, which only shows when two messages carry them;
      // and with a page size of two they all sit on the second page, so a read
      // of the first page alone sees a thread with none.
      attachments: [
        {
          id: 401,
          name: 'Tilmelding',
          link: { name: 'Tilmelding', url: 'https://tilmelding.eksempel.dk/lejrskole' },
        },
        {
          id: 402,
          name: 'Pakkeliste.pdf',
          file: { name: 'Pakkeliste.pdf', url: signed('Pakkeliste.pdf') },
        },
      ],
    },
    {
      from: 'Far Eksempelsen',
      role: 'guardian',
      ago: -1,
      html: 'Perfekt, tak.',
      attachments: [
        {
          id: 403,
          name: 'Sovepose.jpg',
          media: { name: 'Sovepose.jpg', url: signed('Sovepose.jpg') },
        },
      ],
    },
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

/** The hosts this stub knows how to answer. Anything else is worth recording. */
const KNOWN_HOSTS = new Set(['www.aula.dk', 'app.meebook.com', 'api.minuddannelse.net', FILE_HOST]);

async function handle(input: string | Request | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(
    typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
  );

  // A host nobody wired up used to fall through to the Aula switch and answer
  // `envelope(null)` silently, which made "the request log is empty" a claim
  // about the log rather than about the process. `login`'s test asserts MitID is
  // not contacted before the username arrives, and that assertion is only worth
  // anything if a call to nemlog-in.mitid.dk actually leaves a mark.
  if (!KNOWN_HOSTS.has(url.host)) record(`unexpected ${url.host}`);

  // The silent re-authorise chain as it ends once the broker session has
  // lapsed: Aula's authorize endpoint redirects to the broker, and the broker
  // answers with its IdP-selection page instead of redirecting on. That 200 is
  // the whole signal — there is no error status to read.
  if (process.env.FAKE_AULA_BROKER_EXPIRED === '1') {
    if (url.host === 'login.aula.dk') {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://broker.unilogin.dk/auth/realms/broker/login' },
      });
    }
    if (url.host === 'broker.unilogin.dk') {
      return new Response('<html><body>Vælg login</body></html>', { status: 200 });
    }
  }

  if (url.host === FILE_HOST) {
    record(`download ${decodeURIComponent(url.pathname.slice(1))}`);
    // A presigned URL is fetched clean: S3 rejects one that arrives with the
    // Aula cookie or an Authorization header beside its signature.
    const headers = new Headers(init?.headers);
    if (headers.has('cookie') || headers.has('authorization')) {
      return new Response('SignatureDoesNotMatch', { status: 403 });
    }
    if (url.searchParams.get('Signature') !== 'FAKE-SIGNATURE') {
      return new Response('MalformedSignature', { status: 403 });
    }
    return new Response(`bytes of ${decodeURIComponent(url.pathname.slice(1))}`, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream' },
    });
  }

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
    case 'messaging.getThreads': {
      // Twenty to a page, as Aula serves them. The three fixture threads fit on
      // one, so a cut list could never be exercised end to end until
      // `FAKE_AULA_EXTRA_THREADS` could push the inbox past a page.
      const extra = Number(process.env.FAKE_AULA_EXTRA_THREADS ?? 0);
      const all = [
        ...THREADS,
        ...Array.from({ length: Math.max(0, extra) }, (_, index) => ({
          id: 6001 + index,
          subject: `Besked ${index + 1}`,
          read: true,
          sensitive: false,
          startedTime: iso(-4),
          institutionCode: '100001',
          regardingChildren: [],
          creator: { fullName: 'Skoleleder' },
          latestMessage: { sendDateTime: iso(-4), text: { html: 'Til orientering.' } },
        })),
      ];
      const page = Number(url.searchParams.get('page') ?? 0);
      return envelope({
        threads: all.slice(page * 20, (page + 1) * 20),
        moreMessagesExist: (page + 1) * 20 < all.length,
      });
    }
    case 'messaging.getMessagesForThread': {
      const threadId = Number(url.searchParams.get('threadId'));
      const page = Number(url.searchParams.get('page') ?? 0);
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
      if (`${threadId}:${page}` === process.env.FAKE_AULA_FAIL_THREAD_PAGE) {
        return new Response(JSON.stringify({ status: { code: 503 }, data: null }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }
      const messages = MESSAGES[threadId] ?? [];
      const requestedSize = Number(process.env.FAKE_AULA_THREAD_PAGE_SIZE ?? messages.length);
      const pageSize =
        Number.isInteger(requestedSize) && requestedSize > 0 ? requestedSize : messages.length;
      const visible = messages.slice(page * pageSize, (page + 1) * pageSize);
      return envelope({
        id: threadId,
        subject: THREADS.find((t) => t.id === threadId)?.subject ?? '?',
        sensitive: false,
        totalMessageCount: messages.length,
        moreMessagesExist: (page + 1) * pageSize < messages.length,
        page,
        recipients: [],
        messages: visible.map((m, i) => ({
          id: `m-${threadId}-${page * pageSize + i}`,
          sendDateTime: iso(m.ago),
          sender: { fullName: m.from, mailBoxOwner: { portalRole: m.role } },
          text: { html: m.html },
          attachments: m.attachments ?? [],
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
      // Only a string body is real here; anything else would stringify to
      // "[object Object]" and parse into nonsense.
      const body: unknown = JSON.parse(typeof init?.body === 'string' ? init.body : '{}');
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
          id: c.id,
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
      if (Number(process.env.FAKE_AULA_CONTACT_PAGES ?? 0) > 0) {
        const page = Number(url.searchParams.get('page') ?? 1);
        const pages = Number(process.env.FAKE_AULA_CONTACT_PAGES);
        return envelope(
          page <= pages
            ? [{ profileId: page, fullName: `Klassekammerat ${page}`, birthday: '2016-05-04' }]
            : [],
        );
      }
      return envelope(
        Number(url.searchParams.get('page') ?? 1) === 1
          ? [{ profileId: 1, fullName: 'Klassekammerat', birthday: '2016-05-04' }]
          : [],
      );
    case 'notifications.getNotificationsForActiveProfile':
      return envelope([]);
    case 'commonFiles.getCommonFiles': {
      const total = Number(process.env.FAKE_AULA_COMMON_FILES ?? 0);
      const index = Number(url.searchParams.get('index') ?? 0);
      const limit = Number(url.searchParams.get('limit') ?? 50);
      const commonFiles = Array.from(
        { length: Math.max(0, Math.min(limit, total - index)) },
        (_, offset) => {
          const id = index + offset + 1;
          const name = `Faelles fil ${id}.pdf`;
          return {
            id,
            title: `Fælles fil ${id}`,
            created: iso(-1),
            // Aula's own double nesting: the attachment record, then the blob.
            file: { name, status: 'available', file: { url: signed(name) } },
          };
        },
      );
      return envelope({ commonFiles, totalAmount: total });
    }
    case 'aulaToken.getAulaToken':
      // Serialised so a caller can tell a re-issued token from the one it had.
      return envelope(`fake-widget-jwt-${++issuedTokens}`);
    default:
      // What Aula says to a method name it does not have: HTTP 404 carrying
      // status code 10. This answered `envelope(null)`, a success, so a typo
      // through `raw` could only be tested as a shape error it never is.
      return new Response(JSON.stringify({ status: { code: 10 }, data: null }), {
        status: 404,
        headers: { 'content-type': 'application/json' },
      });
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
    // One post with something to download, one without.
    attachments:
      p.id === 7001
        ? [
            {
              id: 501,
              name: 'Ugeplan uge 33.pdf',
              file: { name: 'Ugeplan uge 33.pdf', url: signed('Ugeplan uge 33.pdf') },
            },
          ]
        : [],
  };
}

globalThis.fetch = handle as unknown as typeof fetch;
